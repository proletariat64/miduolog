const text = {type: 'string'};
const object = properties => ({type: 'object', additionalProperties: false, required: Object.keys(properties), properties});
const choice = values => ({type: 'string', enum: values});
const strings = {type: 'array', items: text};
export const statuses = ['pending', 'incorrect', 'correct', 'partial', 'unanswered'];
export const teacherMarks = ['correct', 'incorrect', 'partial', 'unmarked', 'unclear'];
export const emptyTeacher = () => ({mark: 'unmarked', score: '', comment: '', evidence: ''});
export const emptyAssessment = () => ({verdict: 'uncertain', reason: ''});
const teacherSchema = object({mark: choice(teacherMarks), score: text, comment: text, evidence: text});
const aiSchema = object({verdict: choice(['correct', 'incorrect', 'partial', 'uncertain']), reason: text});
const bboxSchema = {anyOf: [object({x: {type: 'number'}, y: {type: 'number'}, width: {type: 'number'}, height: {type: 'number'}}), {type: 'null'}]};
const answerFields = {number: text, studentAnswer: text, answerStatus: choice(['answered', 'unanswered', 'unclear']),
  teacherReview: teacherSchema, aiAssessment: aiSchema, matchKey: text, sourceLocation: text, bbox: bboxSchema};
export const intakeRecognitionSchema = object({pageMarker: text,
  paper: object({title: text, subject: text, grade: text, pageNumber: text, scope: choice(['full_page', 'partial_page', 'unknown'])}),
  materials: {type: 'array', items: object({key: text, text, description: text})},
  questions: {type: 'array', items: object({...answerFields, subject: text, question: text, knowledgePoint: text, tags: strings,
    sharedMaterial: text, materialKeys: strings, diagramDescription: text, completeness: choice(['complete', 'partial', 'unclear']),
    observedError: text, possibleCause: text, needsConfirmation: {type: 'boolean'}, unclear: strings})},
  answers: {type: 'array', items: object(answerFields)}, unclear: strings});

export function string(value, maximum = 30000) {
  if (typeof value !== 'string') throw new Error('内容应为文字');
  if (value.length > maximum) throw new Error('内容过长');
  return value;
}
export function enumValue(value, values, fallback) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw new Error('状态无效');
  return value;
}
export function teacher(value = {}) {
  return {mark: enumValue(value.mark, teacherMarks, 'unmarked'),
    ...Object.fromEntries(['score', 'comment', 'evidence'].map(k => [k, string(value[k] ?? '')]))};
}
export function assessment(value = {}) {
  return {verdict: enumValue(value.verdict, ['correct', 'incorrect', 'partial', 'uncertain'], 'uncertain'), reason: string(value.reason ?? '')};
}
export function bounds(value) {
  if (value == null) return null;
  const keys = ['x', 'y', 'width', 'height'];
  if (keys.some(k => !Number.isFinite(value[k]) || value[k] < 0 || value[k] > 1) || value.x + value.width > 1.001 || value.y + value.height > 1.001) throw new Error('原图区域应为0到1之间的比例');
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
export function questionContent(value = {}) {
  const result = Object.fromEntries(['number', 'subject', 'question', 'knowledgePoint', 'sharedMaterial', 'diagramDescription', 'sourceLocation'].map(k => [k, string(value[k] ?? '')]));
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50)) throw new Error('标签格式无效');
  result.tags = [...new Set((value.tags || []).map(s => string(s, 200)))];
  result.completeness = enumValue(value.completeness, ['complete', 'partial', 'unclear'], 'unclear');
  result.bbox = bounds(value.bbox); result.materialIds = Array.isArray(value.materialIds) ? value.materialIds.map(s => string(s, 200)) : [];
  return result;
}
export function validateExtraction(value) {
  if (!value || !Array.isArray(value.questions) || value.questions.length > 150 || (value.answers !== undefined && (!Array.isArray(value.answers) || value.answers.length > 150))) throw new Error('识别题目列表无效');
  for (const q of value.questions) { questionContent(q); teacher(q.teacherReview); assessment(q.aiAssessment); string(q.studentAnswer ?? ''); }
  for (const a of value.answers || []) { teacher(a.teacherReview); assessment(a.aiAssessment); string(a.studentAnswer ?? ''); string(a.number ?? ''); }
  return value;
}
export function classification(q, pageUnclear = []) {
  const t = teacher(q.teacherReview), a = assessment(q.aiAssessment);
  const wrong = value => ['incorrect', 'partial'].includes(value);
  if ((t.mark === 'correct' && wrong(a.verdict)) || (wrong(t.mark) && a.verdict === 'correct')) return {status: 'pending', reason: '老师批改与 AI 判断冲突'};
  if (wrong(t.mark) && t.evidence.trim() && q.answerStatus === 'answered') return {status: 'incorrect', reason: '老师批改：' + t.evidence};
  if (q.answerStatus === 'unanswered' || !q.studentAnswer?.trim()) return {status: 'pending', reason: '未能确认清晰的孩子原作答'};
  if (t.mark === 'unmarked' && wrong(a.verdict) && a.reason.trim() && q.observedError?.trim()
    && q.completeness === 'complete' && q.answerStatus === 'answered' && !q.needsConfirmation && !(q.unclear || []).length && !pageUnclear.length) return {status: 'incorrect', reason: 'AI 判断：' + a.reason};
  return {status: 'pending', reason: '尚无一致、明确的错误证据，可稍后修改'};
}

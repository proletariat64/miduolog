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
  answerPresence: choice(['present', 'absent', 'unknown']), answerEvidence: text,
  teacherReview: teacherSchema, aiAssessment: aiSchema, matchKey: text, sourceLocation: text, bbox: bboxSchema};
export const intakeRecognitionSchema = object({pageMarker: text,
  paper: object({title: text, documentId: text, subject: text, grade: text, pageNumber: text, scope: choice(['full_page', 'partial_page', 'unknown'])}),
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
  for (const q of value.questions) { questionContent(q); validateAnswer(q); }
  for (const a of value.answers || []) { validateAnswer(a); string(a.number ?? ''); }
  return value;
}
function validateAnswer(raw) {
  teacher(raw.teacherReview); assessment(raw.aiAssessment); string(raw.studentAnswer ?? '');
  enumValue(raw.answerPresence, ['present', 'absent', 'unknown'], 'unknown');
  if (raw.answerEvidence !== undefined) string(raw.answerEvidence);
}
export function hasVisibleAnswer(raw) {
  if (raw.studentAnswer?.trim()) return true;
  if (raw.answerPresence === 'absent') return false;
  if (raw.answerPresence === 'present' && raw.answerEvidence?.trim()) return true;
  // Legacy drawing extractions explicitly said answered. Unclear alone says
  // nothing about visible writing (the corresponding sheet may be elsewhere).
  return raw.answerPresence === undefined && raw.answerStatus === 'answered';
}
const identityText = value => String(value || '').normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
const subjectNames = new Set(['数学', '语文', '英语', '物理', '化学', '生物', '历史', '地理', '政治', '其他']);
function documentEvidence(extraction, raw) {
  const paper = extraction?.paper || {}, documentId = identityText(paper.documentId);
  const observed = [documentId, extraction?.pageMarker, raw.matchKey].filter(Boolean).join('|');
  // This fallback supports already-saved extractions. New extractions explicitly
  // transcribe documentId, so association no longer depends on model key order.
  const visibleIds = [...new Set((observed.match(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+/gu) || []).map(identityText))];
  if (documentId && !visibleIds.includes(documentId)) visibleIds.push(documentId);
  const number = questionNumber(raw.number);
  const keyTokens = [...new Set(String(raw.matchKey || '').split(/[|｜·]/u).map(identityText).filter(s => s && questionNumber(s) !== number && !subjectNames.has(s)))].sort();
  return {ids: visibleIds, subject: identityText(paper.subject || raw.subject), title: identityText(paper.title).replace(/(?:题目页|答题纸|答题卡)$/u, ''), keyTokens};
}
export function questionNumber(value) {
  const text = identityText(value);
  const simple = text.match(/^(?:第)?[（(]?(\d+)[）)]?(?:题)?[.、．]?$/u);
  return simple ? simple[1] : text;
}
export function sameVisibleDocument(leftExtraction, leftRaw, rightExtraction, rightRaw) {
  const left = documentEvidence(leftExtraction, leftRaw), right = documentEvidence(rightExtraction, rightRaw);
  if (left.subject && right.subject && left.subject !== right.subject) return false;
  if (left.ids.length || right.ids.length) return left.ids.length === 1 && right.ids.length === 1 && left.ids[0] === right.ids[0];
  if (left.title && right.title && left.subject && right.subject) return left.title === right.title && left.subject === right.subject;
  return left.keyTokens.length > 0 && JSON.stringify(left.keyTokens) === JSON.stringify(right.keyTokens);
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

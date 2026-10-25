import {randomUUID, createHash} from 'node:crypto';
import {questionContent, teacher, assessment, classification, statuses, string, enumValue, bounds} from './intake-records.mjs';

export const now = () => new Date().toISOString();
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const parse = value => value ? JSON.parse(value) : null;
const encode = value => JSON.stringify(value);

export class IntakeStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS intake_photos(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,file TEXT NOT NULL,state TEXT NOT NULL,error TEXT,extraction TEXT,description TEXT,token TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_batches(id TEXT PRIMARY KEY,requestId TEXT UNIQUE NOT NULL,inputHash TEXT NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_batch_photos(batchId TEXT NOT NULL,photoId TEXT NOT NULL,position INTEGER NOT NULL,reused INTEGER NOT NULL,PRIMARY KEY(batchId,photoId));
      CREATE TABLE IF NOT EXISTS intake_questions(id TEXT PRIMARY KEY,content TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,removed INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,sources TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,legacyId TEXT UNIQUE,redirectId TEXT);
      CREATE TABLE IF NOT EXISTS intake_attempts(id TEXT PRIMARY KEY,questionId TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,sources TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_materials(id TEXT PRIMARY KEY,data TEXT NOT NULL,sources TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS intake_occurrences(batchId TEXT NOT NULL,photoId TEXT NOT NULL,indexNo INTEGER NOT NULL,questionId TEXT,decisionId TEXT,PRIMARY KEY(batchId,photoId,indexNo));
      CREATE TABLE IF NOT EXISTS intake_decisions(id TEXT PRIMARY KEY,batchId TEXT NOT NULL,type TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,resolution TEXT);
      CREATE TABLE IF NOT EXISTS intake_fragments(id TEXT PRIMARY KEY,batchId TEXT NOT NULL,photoId TEXT NOT NULL,indexNo INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,questionId TEXT,attemptId TEXT,UNIQUE(batchId,photoId,indexNo));
      CREATE TABLE IF NOT EXISTS intake_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,beforeValue TEXT,afterValue TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_commands(id TEXT PRIMARY KEY,inputHash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intake_attempts_question ON intake_attempts(questionId);`);
    this.migrateLegacy();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  command(key, input, fn) {
    const old = this.db.prepare('SELECT * FROM intake_commands WHERE id=?').get(key), inputHash = digest(input);
    if (old) { if (old.inputHash !== inputHash) throw Object.assign(new Error('重复请求的内容不同'), {status: 409}); return parse(old.result); }
    return this.transaction(() => { const result = fn(); this.db.prepare('INSERT INTO intake_commands VALUES (?,?,?)').run(key, inputHash, encode(result)); return result; });
  }
  history(id, kind, source, before, after) {
    this.db.prepare('INSERT INTO intake_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, kind, source, before === undefined ? null : encode(before), after === undefined ? null : encode(after), now());
  }
  histories(id) { return this.db.prepare('SELECT * FROM intake_history WHERE entityId=? ORDER BY rowid').all(id).map(r => ({id: r.id, kind: r.kind, source: r.source, before: parse(r.beforeValue), after: parse(r.afterValue), createdAt: r.createdAt})); }
  source(photoId, q = {}) { return {photoId, imageUrl: '/api/intake/photos/' + photoId + '/image', location: string(q.sourceLocation || ''), bbox: bounds(q.bbox)}; }
  sources(values = []) {
    if (!Array.isArray(values) || values.length > 100) throw new Error('来源格式无效');
    return values.map(s => { if (!this.photo(s.photoId)) throw new Error('来源照片不存在'); return this.source(s.photoId, {sourceLocation: s.location || '', bbox: s.bbox}); });
  }
  photo(id) {
    const row = this.db.prepare('SELECT * FROM intake_photos WHERE id=?').get(id);
    return row ? {...row, imageUrl: '/api/intake/photos/' + id + '/image', extraction: parse(row.extraction), description: parse(row.description)} : null;
  }
  addQuestion(raw, sources, {legacyId = null, verified = false, id = randomUUID()} = {}) {
    const content = questionContent(raw), createdAt = now();
    for (const materialId of content.materialIds) if (!this.material(materialId)) throw new Error('共用材料不存在');
    this.db.prepare('INSERT INTO intake_questions(id,content,verified,sources,createdAt,updatedAt,legacyId) VALUES (?,?,?,?,?,?,?)').run(id, encode(content), Number(verified), encode(sources), createdAt, createdAt, legacyId);
    this.history(id, 'question_created', legacyId ? 'legacy' : 'recognition', null, content);
    return id;
  }
  addAttempt(questionId, raw, sources, source = 'recognition') {
    if (!this.question(questionId, true)) throw new Error('题目不存在');
    const result = classification(raw), id = randomUUID();
    const data = {studentAnswer: string(raw.studentAnswer || ''), answerStatus: enumValue(raw.answerStatus, ['answered', 'unanswered', 'unclear'], raw.studentAnswer ? 'answered' : 'unclear'), teacherReview: teacher(raw.teacherReview), aiAssessment: assessment(raw.aiAssessment), status: result.status, statusReason: result.reason, statusSource: source,
      answerPresence: enumValue(raw.answerPresence, ['present', 'absent', 'unknown'], raw.studentAnswer?.trim() || raw.answerStatus === 'answered' ? 'present' : 'unknown'), answerEvidence: string(raw.answerEvidence || ''),
      observedError: string(raw.observedError || ''), possibleCause: string(raw.possibleCause || ''), causeStatus: 'pending', unclear: raw.unclear || []};
    if (source === 'manual' && raw.status !== undefined) { data.status = enumValue(raw.status, statuses); data.statusReason = string(raw.statusReason || '手动录入原作答'); }
    this.db.prepare('INSERT INTO intake_attempts(id,questionId,data,sources,createdAt) VALUES (?,?,?,?,?)').run(id, questionId, encode(data), encode(sources), now());
    this.history(id, 'attempt_created', source, null, data);
    return id;
  }
  attempt(id) {
    const row = this.db.prepare('SELECT * FROM intake_attempts WHERE id=?').get(id);
    return row ? {id, questionId: row.questionId, ...parse(row.data), revision: row.revision, sources: parse(row.sources), createdAt: row.createdAt, history: this.histories(id)} : null;
  }
  question(id, includeRemoved = false) {
    const row = this.db.prepare('SELECT * FROM intake_questions WHERE id=?').get(id);
    if (!row || (row.removed && !includeRemoved)) return null;
    const attempts = this.db.prepare('SELECT id FROM intake_attempts WHERE questionId=? ORDER BY rowid').all(id).map(r => this.attempt(r.id));
    const content = parse(row.content);
    return {id, content, verified: !!row.verified, removed: !!row.removed, redirectId: row.redirectId, revision: row.revision, sources: parse(row.sources), createdAt: row.createdAt, updatedAt: row.updatedAt, legacyId: row.legacyId,
      attempts, materials: content.materialIds.map(id => this.material(id)).filter(Boolean), latestStatus: attempts.at(-1)?.status || 'no_answer', everWrong: attempts.some(a => ['incorrect', 'partial'].includes(a.status) || a.history.some(h => ['incorrect', 'partial'].includes(h.after?.status))), history: this.histories(id)};
  }
  listQuestions({status, tag, batchId, includeRemoved = false} = {}) {
    let ids = this.db.prepare('SELECT id FROM intake_questions ORDER BY createdAt DESC,rowid DESC').all().map(r => r.id);
    if (batchId) { const included = new Set(this.db.prepare('SELECT questionId FROM intake_occurrences WHERE batchId=? AND questionId IS NOT NULL').all(batchId).map(r => r.questionId)); ids = ids.filter(id => included.has(id)); }
    return ids.map(id => this.question(id, includeRemoved)).filter(q => q && (!status || q.latestStatus === status) && (!tag || q.content.tags.includes(tag) || q.content.knowledgePoint === tag || q.content.subject === tag));
  }
  assertRevision(row, input) { if (input.expectedRevision !== undefined && input.expectedRevision !== row.revision) throw Object.assign(new Error('内容已更新，请重新读取后修改'), {status: 409}); }
  updateQuestion(id, input) {
    const previous = this.question(id, true); if (!previous) return null; this.assertRevision(previous, input);
    const content = questionContent({...previous.content, ...(input.content || {})});
    for (const mid of content.materialIds) if (!this.material(mid)) throw new Error('共用材料不存在');
    this.transaction(() => {
      this.db.prepare('UPDATE intake_questions SET content=?,verified=?,revision=revision+1,updatedAt=? WHERE id=?').run(encode(content), input.verified === undefined ? Number(previous.verified) : Number(!!input.verified), now(), id);
      this.history(id, 'question_edited', 'manual', {content: previous.content, verified: previous.verified}, {content, verified: input.verified ?? previous.verified});
    }); return this.question(id, true);
  }
  updateAttempt(id, input) {
    const previous = this.attempt(id); if (!previous) return null; this.assertRevision(previous, input);
    const data = {...previous}; for (const field of ['questionId','sources','revision','createdAt','history','id']) delete data[field];
    if (input.studentAnswer !== undefined) data.studentAnswer = string(input.studentAnswer);
    if (input.teacherReview !== undefined) data.teacherReview = teacher(input.teacherReview);
    if (input.status !== undefined) { data.status = enumValue(input.status, statuses); data.statusReason = string(input.statusReason || '手动修改状态'); }
    data.statusSource = 'manual';
    this.transaction(() => { this.db.prepare('UPDATE intake_attempts SET data=?,revision=revision+1 WHERE id=?').run(encode(data), id); this.history(id, 'attempt_edited', 'manual', previous, data); });
    return this.attempt(id);
  }
  remove(id) {
    const old = this.question(id, true); if (!old) return null;
    if (!old.removed) this.transaction(() => { this.db.prepare('UPDATE intake_questions SET removed=1,revision=revision+1,updatedAt=? WHERE id=?').run(now(), id); this.history(id, 'question_removed', 'manual', old.content, null); });
    return this.question(id, true);
  }
  addSources(questionId, sources, attemptId = null) {
    const target = this.question(questionId, true); if (!target || target.removed) throw new Error('关联题目不可用');
    const combined = values => [...new Map(values.map(s => [encode(s), s])).values()];
    this.db.prepare('UPDATE intake_questions SET sources=?,updatedAt=? WHERE id=?').run(encode(combined([...target.sources, ...sources])), now(), questionId);
    if (attemptId) { const attempt = this.attempt(attemptId); if (!attempt || attempt.questionId !== questionId) throw new Error('作答不属于该题'); this.db.prepare('UPDATE intake_attempts SET sources=? WHERE id=?').run(encode(combined([...attempt.sources, ...sources])), attemptId); }
  }
  material(id) { const row = this.db.prepare('SELECT * FROM intake_materials WHERE id=?').get(id); return row ? {id, ...parse(row.data), sources: parse(row.sources), revision: row.revision, history: this.histories(id)} : null; }
  addMaterial(raw, sources) { const id = randomUUID(), data = {text: string(raw.text || ''), description: string(raw.description || '')}; this.db.prepare('INSERT INTO intake_materials(id,data,sources) VALUES (?,?,?)').run(id, encode(data), encode(sources)); this.history(id, 'material_created', 'recognition', null, data); return id; }
  updateMaterial(id, input) {
    const old = this.material(id); if (!old) return null; this.assertRevision(old, input);
    const data = {text: string(input.text ?? old.text), description: string(input.description ?? old.description)};
    this.transaction(() => { this.db.prepare('UPDATE intake_materials SET data=?,revision=revision+1 WHERE id=?').run(encode(data), id); this.history(id, 'material_edited', 'manual', {text: old.text, description: old.description}, data); }); return this.material(id);
  }
  migrateLegacy() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions'").get() || !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='imports'").get()) return;
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM questions').all()) {
        if (this.db.prepare('SELECT id FROM intake_questions WHERE legacyId=?').get(row.id)) continue;
        const c = parse(row.content), photo = this.db.prepare('SELECT * FROM imports WHERE id=?').get(row.importId); let sources = [];
        if (photo?.image) {
          this.db.prepare('INSERT OR IGNORE INTO intake_photos(id,hash,name,file,state,createdAt) VALUES (?,?,?,?,?,?)').run(photo.id, 'legacy:' + photo.id, photo.originalName || '', photo.image, 'completed', photo.createdAt || now());
          sources = [this.source(photo.id, c)];
        }
        const id = this.addQuestion(c, sources, {id: row.id, legacyId: row.id, verified: row.state === 'library'});
        if (c.studentAnswer?.trim()) { const aid = this.addAttempt(id, c, sources, 'legacy'); const a = this.attempt(aid); const data = {...a, status: statuses.includes(c.questionStatus) ? c.questionStatus : 'pending', statusSource: 'legacy', statusReason: '旧记录保留，不重新判断'}; for (const k of ['id','questionId','sources','createdAt','revision','history']) delete data[k]; this.db.prepare('UPDATE intake_attempts SET data=? WHERE id=?').run(encode(data), aid); }
      }
      // Old images already have recognized questions. Reconstruct a marked legacy
      // extraction once so choosing that photo again reuses evidence, not inference.
      for (const photo of this.db.prepare('SELECT * FROM intake_photos WHERE extraction IS NULL').all()) {
        const rows = this.db.prepare('SELECT * FROM questions WHERE importId=? ORDER BY rowid').all(photo.id);
        if (!rows.length) continue;
        const extraction = {legacy: true, questions: rows.map(r => parse(r.content)), answers: [], unclear: []};
        this.db.prepare('UPDATE intake_photos SET extraction=? WHERE id=?').run(encode(extraction), photo.id);
        for (let i = 0; i < rows.length; i++) this.db.prepare('INSERT OR IGNORE INTO intake_occurrences VALUES (?,?,?,?,NULL)').run('legacy:' + photo.id, photo.id, i, rows[i].id);
      }
    });
  }
}

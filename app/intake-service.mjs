import {randomUUID} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {IntakeStore, digest, now, parse} from './intake-store.mjs';
import {intakeRecognitionSchema, validateExtraction, questionContent, string, hasVisibleAnswer, sameVisibleDocument, questionNumber} from './intake-records.mjs';
import {imageType} from './paper-import.mjs';
import {writeImage} from './local-images.mjs';
import * as matching from './intake-matching.mjs';

const encode = JSON.stringify;
const active = ['saving', 'queued', 'processing'];
const hasAnswer = hasVisibleAnswer;
const error = (message, status = 400) => Object.assign(new Error(message), {status});

export class IntakeService {
  static async open(options) {
    const service = new IntakeService(options);
    await service.initialize(); service.schedule(); return service;
  }
  constructor({db, client, dataDir}) {
    Object.assign(this, {db, client, dataDir}); this.store = new IntakeStore(db);
    this.imageDir = resolve(dataDir, 'images'); this.closed = false; this.runner = null;
  }
  async initialize() {
    await mkdir(this.imageDir, {recursive: true});
    this.db.prepare("UPDATE intake_photos SET state='failed',token=NULL,error='上次识别中断，请明确重试' WHERE state IN ('saving','processing')").run();
    this.db.exec('CREATE TABLE IF NOT EXISTS intake_photo_materials(photoId TEXT NOT NULL,localKey TEXT NOT NULL,materialId TEXT NOT NULL,PRIMARY KEY(photoId,localKey))');
    this.matching = matching;
    if (!this.db.prepare('PRAGMA table_info(intake_photos)').all().some(c => c.name === 'reusedFrom')) this.db.exec('ALTER TABLE intake_photos ADD COLUMN reusedFrom TEXT');
    if (!this.db.prepare('PRAGMA table_info(intake_batches)').all().some(c => c.name === 'sealed')) this.db.exec('ALTER TABLE intake_batches ADD COLUMN sealed INTEGER NOT NULL DEFAULT 1');
    for (const p of this.db.prepare("SELECT * FROM intake_photos WHERE hash LIKE 'legacy:%'").all()) {
      try {
        const hash = digest(await readFile(resolve(this.imageDir, p.file)));
        if (!this.db.prepare('SELECT id FROM intake_photos WHERE hash=?').get(hash)) this.db.prepare('UPDATE intake_photos SET hash=? WHERE id=?').run(hash, p.id);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.refresh();
  }
  photo(id) {
    const p = this.store.photo(id); if (!p) return null;
    const similar = this.db.prepare("SELECT data FROM intake_decisions WHERE type='photo_similarity' AND state='pending'").all().map(r => parse(r.data)).find(d => d.photoId === id);
    return {id: p.id, name: p.name, state: p.state, error: p.error, imageUrl: p.imageUrl, extraction: p.extraction, similarCandidates: similar?.candidates || []};
  }
  async original(id) { const p = this.store.photo(id); if (!p) return null; const bytes = await readFile(resolve(this.imageDir, p.file)); return {bytes, contentType: imageType(bytes) === 'jpg' ? 'image/jpeg' : 'image/' + imageType(bytes)}; }
  decision(id) {
    const r = this.db.prepare('SELECT * FROM intake_decisions WHERE id=?').get(id);
    if (!r) return null;
    const data = parse(r.data);
    return {id, batchId: r.batchId, type: r.type, state: r.state, ...data, candidates: (data.candidates || []).map(c => ({...c, ...(r.type === 'question_duplicate' ? {question: this.store.question(c.id)} : {})})), resolution: parse(r.resolution)};
  }
  fragment(id) {
    const r = this.db.prepare('SELECT * FROM intake_fragments WHERE id=?').get(id); if (!r) return null;
    return {id, batchId: r.batchId, photoId: r.photoId, state: r.state, ...parse(r.data), questionId: r.questionId, attemptId: r.attemptId};
  }
  batch(id) {
    const r = this.db.prepare('SELECT * FROM intake_batches WHERE id=?').get(id); if (!r) return null;
    const photos = this.db.prepare('SELECT photoId,reused FROM intake_batch_photos WHERE batchId=? ORDER BY position').all(id).map(row => ({...this.photo(row.photoId), reused: !!row.reused}));
    const decisions = this.db.prepare('SELECT id FROM intake_decisions WHERE batchId=? ORDER BY rowid').all(id).map(r => this.decision(r.id));
    const fragments = this.db.prepare('SELECT id FROM intake_fragments WHERE batchId=? ORDER BY rowid').all(id).map(r => this.fragment(r.id));
    const warnings = fragments.filter(f => f.state === 'unlinked' && f.warning).map(f => ({type: 'answer_unlinked', fragmentId: f.id, photoId: f.photoId, message: f.warning}));
    return {id, requestId: r.requestId, state: r.state, createdAt: r.createdAt, photos, decisions, fragments, warnings, questions: this.store.listQuestions({batchId: id})};
  }
  batches() { return this.db.prepare('SELECT id FROM intake_batches ORDER BY rowid DESC').all().map(r => this.batch(r.id)); }
  async submit(input) {
    const requestId = string(input.requestId, 200); if (!requestId.trim()) throw error('缺少请求编号');
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 30) throw error('请选择1至30张照片');
    const files = input.files.map(f => {
      const name = string(f.name, 1000); if (typeof f.base64 !== 'string') throw error('缺少图片');
      const bytes = Buffer.from(f.base64, 'base64'), type = imageType(bytes);
      if (!type || bytes.length > 15 * 1024 * 1024) throw error('请使用15MB以下的PNG、JPEG或WebP图片');
      return {name: basename(name), bytes, type, hash: digest(bytes)};
    });
    const inputHash = digest(files.map(f => ({name: f.name, hash: f.hash}))), previous = this.db.prepare('SELECT * FROM intake_batches WHERE requestId=?').get(requestId);
    if (previous) { if (previous.inputHash !== inputHash) throw error('本次请求编号已用于不同照片', 409); return this.batch(previous.id); }
    const id = randomUUID(); this.db.prepare('INSERT INTO intake_batches(id,requestId,inputHash,state,createdAt,sealed) VALUES (?,?,?,?,?,0)').run(id, requestId, inputHash, 'processing', now());
    for (let i = 0; i < files.length; i++) {
      const f = files[i]; let photo = this.db.prepare('SELECT * FROM intake_photos WHERE hash=?').get(f.hash), reused = !!photo;
      if (!photo) {
        photo = {id: randomUUID(), file: randomUUID() + '.' + f.type};
        this.db.prepare('INSERT INTO intake_photos(id,hash,name,file,state,createdAt) VALUES (?,?,?,?,?,?)').run(photo.id, f.hash, f.name, photo.file, 'saving', now());
        this.db.prepare('INSERT OR IGNORE INTO intake_batch_photos VALUES (?,?,?,?)').run(id, photo.id, i, 0);
        try {
          await writeImage(resolve(this.imageDir, photo.file), f.bytes);
          const description = await this.matching.describeImage(f.bytes);
          const records = this.db.prepare('SELECT id,description FROM intake_photos WHERE id!=? AND description IS NOT NULL').all(photo.id).map(r => ({id: r.id, ...parse(r.description)}));
          const candidates = description ? this.matching.photoCandidates(description, records) : [];
          this.db.prepare('UPDATE intake_photos SET description=?,state=? WHERE id=?').run(description ? encode(description) : null, candidates.length ? 'attention' : 'queued', photo.id);
          if (candidates.length) this.addDecision(id, 'photo_similarity', {photoId: photo.id, candidates});
        } catch (e) { this.db.prepare("UPDATE intake_photos SET state='failed',error=? WHERE id=?").run('原图保存失败：' + e.message, photo.id); }
      } else this.db.prepare('INSERT OR IGNORE INTO intake_batch_photos VALUES (?,?,?,?)').run(id, photo.id, i, Number(reused));
    }
    this.db.prepare('UPDATE intake_batches SET sealed=1 WHERE id=?').run(id);
    this.refresh(); this.schedule(); return this.batch(id);
  }
  addDecision(batchId, type, data) { const id = randomUUID(); this.db.prepare('INSERT INTO intake_decisions VALUES (?,?,?,?,?,NULL)').run(id, batchId, type, 'pending', encode(data)); return id; }
  schedule() {
    if (this.closed || this.runner) return;
    this.runner = this.drain().catch(e => { this.workerError = e.message; }).finally(() => { this.runner = null; });
  }
  async writeRetry(fn) {
    for (;;) { try { return fn(); } catch (e) { if (![5, 6].includes(e.errcode & 255)) throw e; await new Promise(r => setTimeout(r, 40)); } }
  }
  async drain() {
    while (!this.closed) {
      const row = this.db.prepare("SELECT * FROM intake_photos WHERE state='queued' ORDER BY rowid LIMIT 1").get(); if (!row) return;
      const token = randomUUID();
      await this.writeRetry(() => this.db.prepare("UPDATE intake_photos SET state='processing',token=? WHERE id=? AND state='queued'").run(token, row.id));
      try {
        const result = row.extraction ? {data: parse(row.extraction)} : await this.client.recognize(resolve(this.imageDir, row.file), intakeRecognitionSchema);
        validateExtraction(result.data);
        await this.writeRetry(() => this.store.transaction(() => {
          this.db.prepare("UPDATE intake_photos SET extraction=?,state='completed',error=NULL,token=NULL WHERE id=? AND token=?").run(encode(result.data), row.id, token);
        }));
      } catch (e) {
        await this.writeRetry(() => this.db.prepare("UPDATE intake_photos SET state='failed',error=?,token=NULL WHERE id=? AND token=?").run('识别失败：' + e.message, row.id, token));
      }
      await this.writeRetry(() => this.refresh());
    }
  }
  refresh() {
    // Pure persistence: no model calls occur while refreshing queryable projections.
    this.store.transaction(() => {
      for (const batch of this.db.prepare('SELECT id,sealed FROM intake_batches').all()) {
        const photos = this.db.prepare('SELECT p.* FROM intake_photos p JOIN intake_batch_photos bp ON bp.photoId=p.id WHERE bp.batchId=? ORDER BY bp.position').all(batch.id);
        for (const photo of photos) if (photo.state === 'completed' && photo.extraction) this.ingest(batch.id, photo.id, parse(photo.extraction));
        const processing = !batch.sealed || !photos.length || photos.some(p => active.includes(p.state));
        if (!processing) this.matchFragments(batch.id, photos);
        const attention = photos.some(p => p.state === 'attention') || this.db.prepare("SELECT id FROM intake_decisions WHERE batchId=? AND state='pending' LIMIT 1").get(batch.id) || this.db.prepare("SELECT id FROM intake_fragments WHERE batchId=? AND state='unlinked' LIMIT 1").get(batch.id);
        const state = processing ? 'processing' : photos.some(p => p.state === 'failed') ? 'partial_failure' : attention ? 'attention' : 'completed';
        this.db.prepare('UPDATE intake_batches SET state=? WHERE id=?').run(state, batch.id);
      }
    });
  }
  ingest(batchId, photoId, extraction) {
    const materialMap = new Map();
    for (const m of extraction.materials || []) {
      let r = this.db.prepare('SELECT materialId FROM intake_photo_materials WHERE photoId=? AND localKey=?').get(photoId, String(m.key));
      if (!r) { r = {materialId: this.store.addMaterial(m, [this.store.source(photoId)])}; this.db.prepare('INSERT INTO intake_photo_materials VALUES (?,?,?)').run(photoId, String(m.key), r.materialId); }
      materialMap.set(m.key, r.materialId);
    }
    for (let indexNo = 0; indexNo < extraction.questions.length; indexNo++) {
      if (this.db.prepare('SELECT 1 FROM intake_occurrences WHERE batchId=? AND photoId=? AND indexNo=?').get(batchId, photoId, indexNo)) continue;
      const raw = extraction.questions[indexNo], content = questionContent({...raw, materialIds: (raw.materialKeys || []).map(k => materialMap.get(k)).filter(Boolean)}), sources = [this.store.source(photoId, raw)];
      // Blank question with a filled answer is an answer region, not a fabricated question.
      if (!raw.question?.trim() && hasAnswer(raw)) {
        this.addFragment(batchId, photoId, 1000 + indexNo, raw);
        this.db.prepare('INSERT INTO intake_occurrences VALUES (?,?,?,NULL,NULL)').run(batchId, photoId, indexNo); continue;
      }
      const canonical = this.db.prepare('SELECT reusedFrom FROM intake_photos WHERE id=?').get(photoId)?.reusedFrom || photoId;
      const old = this.db.prepare('SELECT questionId FROM intake_occurrences WHERE photoId=? AND indexNo=? AND questionId IS NOT NULL LIMIT 1').get(canonical, indexNo);
      if (old) {
        this.db.prepare('INSERT INTO intake_occurrences VALUES (?,?,?,?,NULL)').run(batchId, photoId, indexNo, old.questionId);
        const existing = this.store.question(old.questionId, true);
        if (existing && !existing.removed) {
          const attempt = existing.attempts.find(a => a.sources.some(s => s.photoId === canonical));
          this.store.addSources(old.questionId, sources, attempt?.id);
        }
        continue;
      }
      const candidates = this.matching.questionCandidates(this.matchingContent(content), this.store.listQuestions().map(q => ({id: q.id, content: this.matchingContent(q.content)})));
      let questionId = null, decisionId = null;
      if (candidates.length) decisionId = this.addDecision(batchId, 'question_duplicate', {photoId, indexNo, question: {...raw, content}, source: sources[0], candidates});
      else {
        questionId = this.store.addQuestion(content, sources);
        if (hasAnswer(raw)) this.store.addAttempt(questionId, {...raw, unclear: [...(raw.unclear || []), ...(extraction.unclear || [])]}, sources);
      }
      this.db.prepare('INSERT INTO intake_occurrences VALUES (?,?,?,?,?)').run(batchId, photoId, indexNo, questionId, decisionId);
    }
    for (let i = 0; i < (extraction.answers || []).length; i++) this.addFragment(batchId, photoId, i, extraction.answers[i]);
  }
  addFragment(batchId, photoId, indexNo, raw) {
    this.db.prepare('INSERT OR IGNORE INTO intake_fragments(id,batchId,photoId,indexNo,state,data) VALUES (?,?,?,?,?,?)').run(randomUUID(), batchId, photoId, indexNo, 'unlinked', encode({...raw, warning: '', candidates: []}));
  }
  matchingContent(content) {
    const materials = (content.materialIds || []).map(id => this.store.material(id)).filter(Boolean).map(m => ({text: m.text, description: m.description}));
    return {...content, sharedMaterial: materials.length ? {inline: content.sharedMaterial || '', materials} : content.sharedMaterial};
  }
  batchQuestionMatches(batchId, fragment, fragmentPhotoId) {
    const rows = this.db.prepare('SELECT * FROM intake_occurrences WHERE batchId=? AND questionId IS NOT NULL').all(batchId), matches = new Set();
    const fragmentExtraction = this.store.photo(fragmentPhotoId)?.extraction;
    if (!questionNumber(fragment.number)) return [];
    for (const row of rows) {
      const photo = this.store.photo(row.photoId), raw = photo?.extraction?.questions[row.indexNo];
      if (raw && questionNumber(raw.number) === questionNumber(fragment.number) && sameVisibleDocument(photo.extraction, raw, fragmentExtraction, fragment)) matches.add(row.questionId);
    }
    return [...matches];
  }
  matchFragments(batchId, photos) {
    for (const row of this.db.prepare("SELECT * FROM intake_fragments WHERE batchId=? AND state='unlinked'").all(batchId)) {
      const raw = parse(row.data), matches = this.batchQuestionMatches(batchId, raw, row.photoId);
      if (matches.length === 1) this.attachFragment(row, matches[0]);
      else {
        const waiting = photos.some(p => ['attention','failed'].includes(p.state)) || this.db.prepare("SELECT id FROM intake_decisions WHERE batchId=? AND state='pending' LIMIT 1").get(batchId);
        const warning = waiting ? '本批材料尚未全部可用，作答暂存，请先处理失败或重复项' : matches.length > 1 ? '本批有多个可能对应题目，请手动指定' : '本批缺少可明确对应的题干，未搜索历史，作答未录入';
        const candidates = [...new Set(this.db.prepare('SELECT questionId FROM intake_occurrences WHERE batchId=? AND questionId IS NOT NULL').all(batchId).map(r => r.questionId))];
        this.db.prepare('UPDATE intake_fragments SET data=? WHERE id=?').run(encode({...raw, warning, candidates}), row.id);
      }
    }
  }
  attachFragment(row, questionId) {
    const canonicalPhotoId = this.db.prepare('SELECT reusedFrom FROM intake_photos WHERE id=?').get(row.photoId)?.reusedFrom || row.photoId;
    const raw = parse(row.data), previous = this.db.prepare("SELECT attemptId FROM intake_fragments WHERE photoId=? AND indexNo=? AND questionId=? AND state='linked' LIMIT 1").get(canonicalPhotoId, row.indexNo, questionId);
    const question = this.store.question(questionId); if (!question) throw error('关联题目不可用');
    const sources = [this.store.source(row.photoId, raw)];
    const attemptId = previous?.attemptId || this.store.addAttempt(questionId, {...question.content, ...raw}, sources);
    this.store.addSources(questionId, sources, attemptId);
    this.db.prepare("UPDATE intake_fragments SET state='linked',questionId=?,attemptId=?,data=? WHERE id=?").run(questionId, attemptId, encode({...raw, warning: '', candidates: []}), row.id);
  }
  resolveDecision(id, input) {
    const d = this.decision(id); if (!d) return null;
    if (d.state === 'resolved') { if (digest(d.resolution) !== digest(input)) throw error('此项已处理，请刷新查看', 409); return d; }
    this.store.transaction(() => {
      if (d.type === 'photo_similarity') {
        if (input.action === 'recognize') this.db.prepare("UPDATE intake_photos SET state='queued',error=NULL WHERE id=?").run(d.photoId);
        else if (input.action === 'skip') {
          if (!d.candidates.some(c => c.id === input.photoId)) throw error('请选择本次提示的重复照片');
          const source = this.store.photo(input.photoId); if (!source?.extraction) throw error('所选照片尚无可复用识别结果');
          this.db.prepare("UPDATE intake_photos SET extraction=?,state='completed',error=NULL,reusedFrom=? WHERE id=?").run(encode(source.extraction), source.reusedFrom || source.id, d.photoId);
        } else throw error('照片重复处理方式无效');
      } else {
        let questionId;
        const raw = d.question, sources = [d.source];
        if (input.action === 'new') { questionId = this.store.addQuestion(raw.content, sources); if (hasAnswer(raw)) this.store.addAttempt(questionId, raw, sources); }
        else if (['link', 'same_attempt'].includes(input.action)) {
          if (!d.candidates.some(c => c.id === input.questionId)) throw error('只能关联本次候选题目');
          questionId = input.questionId;
          if (input.action === 'same_attempt') { if (!input.attemptId) throw error('请选择已有作答'); this.store.addSources(questionId, sources, input.attemptId); }
          else { this.store.addSources(questionId, sources); if (hasAnswer(raw)) this.store.addAttempt(questionId, raw, sources); }
          this.store.history(questionId, 'recognition_difference', 'recognition', null, {content: raw.content, resolution: input});
        } else throw error('题目重复处理方式无效');
        this.db.prepare('UPDATE intake_occurrences SET questionId=? WHERE decisionId=?').run(questionId, id);
      }
      this.db.prepare("UPDATE intake_decisions SET state='resolved',resolution=? WHERE id=?").run(encode(input), id);
    });
    this.refresh(); this.schedule(); return this.decision(id);
  }
  linkFragment(id, input) {
    const row = this.db.prepare('SELECT * FROM intake_fragments WHERE id=?').get(id); if (!row) return null;
    const occurrences = this.db.prepare('SELECT questionId FROM intake_occurrences WHERE batchId=? AND questionId=?').get(row.batchId, input.questionId);
    if (!occurrences) throw error('只能指定本次上传中已有的题目');
    if (row.state === 'linked') { if (row.questionId !== input.questionId) throw error('此作答已经关联', 409); return this.store.attempt(row.attemptId); }
    this.store.transaction(() => this.attachFragment(row, input.questionId)); this.refresh();
    return this.store.attempt(this.db.prepare('SELECT attemptId FROM intake_fragments WHERE id=?').get(id).attemptId);
  }
  retry(id) {
    if (!this.batch(id)) return null;
    this.db.prepare("UPDATE intake_photos SET state='queued',error=NULL WHERE id IN (SELECT photoId FROM intake_batch_photos WHERE batchId=?) AND state='failed'").run(id);
    this.refresh(); this.schedule(); return this.batch(id);
  }
  createQuestion(input) {
    if (!input.requestId) throw error('缺少请求编号');
    return this.store.command('question:' + input.requestId, input, () => {
      const sources = this.store.sources(input.sources || []), id = this.store.addQuestion(input.content || {}, sources);
      if (input.attempt && hasAnswer(input.attempt)) this.store.addAttempt(id, {...input.content, ...input.attempt}, sources, 'manual');
      return this.store.question(id);
    });
  }
  appendAttempt(id, input) {
    if (!input.requestId) throw error('缺少请求编号');
    return this.store.command('attempt:' + input.requestId, {id, ...input}, () => {
      const question = this.store.question(id); if (!question) throw error('题目不存在', 404);
      if (typeof input.studentAnswer !== 'string' || (!input.studentAnswer.trim() && input.status !== 'unanswered')) throw error('请输入原作答，或明确标记未作答');
      const sources = input.sources ? this.store.sources(input.sources) : question.sources;
      return this.store.attempt(this.store.addAttempt(id, {...question.content, ...input}, sources, 'manual'));
    });
  }
  split(id, input) {
    if (!input.requestId || !Array.isArray(input.parts) || input.parts.length < 2 || input.parts.length > 30) throw error('请提供至少两道拆分题目和请求编号');
    return this.store.command('split:' + input.requestId, {id, ...input}, () => {
      const old = this.store.question(id); if (!old) throw error('题目不存在', 404);
      const assigned = new Set();
      const ids = input.parts.map(part => {
        const nid = this.store.addQuestion({...old.content, ...part.content}, part.sources ? this.store.sources(part.sources) : old.sources);
        for (const aid of part.attemptIds || []) { if (assigned.has(aid) || !old.attempts.some(a => a.id === aid)) throw error('作答不能重复或跨题分配'); assigned.add(aid); this.db.prepare('UPDATE intake_attempts SET questionId=? WHERE id=?').run(nid, aid); this.store.history(aid, 'attempt_moved', 'manual', {questionId: id}, {questionId: nid}); }
        return nid;
      });
      this.db.prepare('UPDATE intake_questions SET removed=1,revision=revision+1,updatedAt=? WHERE id=?').run(now(), id);
      this.store.history(id, 'question_split', 'manual', old.content, {questionIds: ids});
      return ids.map(qid => this.store.question(qid));
    });
  }
  merge(id, input) {
    if (!input.requestId || !Array.isArray(input.questionIds) || !input.questionIds.length || input.questionIds.includes(id)) throw error('请选择其他题目及请求编号');
    return this.store.command('merge:' + input.requestId, {id, ...input}, () => {
      const survivor = this.store.question(id); if (!survivor) throw error('题目不存在', 404);
      const content = {...survivor.content}, materialIds = new Set(content.materialIds);
      for (const otherId of new Set(input.questionIds)) {
        const q = this.store.question(otherId); if (!q) throw error('合并题目不存在');
        this.store.addSources(id, q.sources); q.content.materialIds.forEach(mid => materialIds.add(mid));
        this.db.prepare('UPDATE intake_attempts SET questionId=? WHERE questionId=?').run(id, otherId);
        this.db.prepare('UPDATE intake_occurrences SET questionId=? WHERE questionId=?').run(id, otherId);
        this.db.prepare('UPDATE intake_fragments SET questionId=? WHERE questionId=?').run(id, otherId);
        this.db.prepare('UPDATE intake_questions SET removed=1,redirectId=?,revision=revision+1,updatedAt=? WHERE id=?').run(id, now(), otherId);
        this.store.history(otherId, 'question_merged', 'manual', q.content, {questionId: id});
      }
      content.materialIds = [...materialIds]; this.db.prepare('UPDATE intake_questions SET content=?,revision=revision+1,updatedAt=? WHERE id=?').run(encode(content), now(), id);
      this.store.history(id, 'question_merge_received', 'manual', null, {questionIds: input.questionIds}); return this.store.question(id);
    });
  }
  reviewQuestions() {
    this.store.migrateLegacy();
    return this.store.listQuestions().filter(q => q.verified).map(q => this.reviewQuestion(q.id));
  }
  syncLegacyQuestion(id) {
    this.store.migrateLegacy();
    const row = this.db.prepare('SELECT * FROM questions WHERE id=?').get(id);
    if (row) this.store.updateQuestion(id, {content: parse(row.content), verified: row.state === 'library'});
  }
  reviewQuestion(id) {
    const q = this.store.question(id); if (!q || !q.verified) return null;
    const latest = q.attempts.at(-1);
    return {id: q.id, state: 'library', importId: q.sources[0]?.photoId || '', originalName: this.store.photo(q.sources[0]?.photoId)?.name || '', content: {...q.content, studentAnswer: latest?.studentAnswer || '', observedError: latest?.observedError || '', possibleCause: latest?.possibleCause || '', causeStatus: latest?.causeStatus || 'pending'}};
  }
  async idle() { while (this.runner) await this.runner; }
  async close() { this.closed = true; await this.idle(); }
}

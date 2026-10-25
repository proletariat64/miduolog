import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, rm} from 'node:fs/promises';
import {resolve, basename} from 'node:path';
import {recognitionSchema} from './codex-client.mjs';
import {writeImage} from './local-images.mjs';

export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const hashOf = bytes => createHash('sha256').update(bytes).digest('hex');
const inProgress = ['saving', 'queued', 'processing'];

/** The same durable task is used by browser uploads and folder imports. */
export class PaperImports {
  static async open(options) {
    const module = new PaperImports(options);
    await module.initialize();
    module.schedule();
    return module;
  }

  constructor({db, client, dataDir, files = {readFile, writeFile, mkdir, rename, rm}}) {
    Object.assign(this, {db, client, files: {readFile, writeFile, mkdir, rename, rm, ...files}});
    this.imageDir = resolve(dataDir, 'images');
    this.closed = false;
    this.runner = null;
  }

  async initialize() {
    await this.files.mkdir(this.imageDir, {recursive: true});
    this.db.exec(`CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,image TEXT NOT NULL,originalName TEXT NOT NULL,state TEXT NOT NULL,error TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,importId TEXT NOT NULL,state TEXT NOT NULL,content TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_fingerprints(hash TEXT PRIMARY KEY,importId TEXT NOT NULL);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(imports)').all().map(c => c.name));
    for (const name of ['contentHash', 'workToken', 'startedAt']) {
      if (!columns.has(name)) this.db.exec('ALTER TABLE imports ADD COLUMN ' + name + ' TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS imports_contentHash ON imports(contentHash)');
    this.db.prepare('UPDATE imports SET startedAt=createdAt WHERE startedAt IS NULL').run();
    // Work whose model call was interrupted must not silently incur another call.
    this.db.prepare("UPDATE imports SET state='failed',workToken=NULL,error=? WHERE state IN ('saving','processing')")
      .run('上次处理在完成前结束，原图保留；请明确重试，不会自动再次识别。');
    for (const row of this.db.prepare('SELECT * FROM imports ORDER BY createdAt').all()) {
      let hash = row.contentHash;
      if (!hash) {
        try { hash = hashOf(await this.files.readFile(resolve(this.imageDir, row.image))); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        this.db.prepare('UPDATE imports SET contentHash=? WHERE id=?').run(hash, row.id);
      }
      const previous = this.db.prepare('SELECT i.state FROM paper_fingerprints f JOIN imports i ON i.id=f.importId WHERE f.hash=?').get(hash);
      // Old duplicates remain intact; prefer their completed result for future callers.
      if (!previous || row.state === 'completed' || previous.state !== 'completed') {
        this.db.prepare('INSERT OR REPLACE INTO paper_fingerprints(hash,importId) VALUES (?,?)').run(hash, row.id);
      }
    }
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM imports WHERE id=?').get(id);
    if (!row) return null;
    const count = this.db.prepare('SELECT count(*) AS n FROM questions WHERE importId=?').get(id).n;
    const messages = {
      saving: '正在保存原图……', queued: '原图已保存，排队等待 Codex 识别……',
      processing: 'Codex 正在识别题目与原作答，并分析可能错因……',
      completed: count ? '识别完成，请逐题核对。' : '未找到可收录的题目，原图已保留。',
      failed: row.error || '识别未完成，原图已保留。',
    };
    return {id, state: inProgress.includes(row.state) ? 'processing' : row.state,
      stage: row.state, message: messages[row.state], count, originalName: row.originalName,
      error: row.error, createdAt: row.createdAt, startedAt: row.startedAt};
  }

  list() {
    return this.db.prepare('SELECT id FROM imports ORDER BY createdAt DESC').all().map(row => this.get(row.id));
  }

  questions(importId) {
    const rows = importId ? this.db.prepare('SELECT * FROM questions WHERE importId=? ORDER BY rowid').all(importId)
      : this.db.prepare('SELECT * FROM questions ORDER BY createdAt DESC,rowid').all();
    return rows.map(row => ({...row, content: JSON.parse(row.content)}));
  }

  get busy() {
    return this.db.prepare("SELECT count(*) AS n FROM imports WHERE state IN ('saving','queued','processing')").get().n > 0;
  }

  async submit({bytes, name}) {
    if (this.closed) throw new Error('导入任务已关闭');
    if (!Buffer.isBuffer(bytes) || typeof name !== 'string') throw new Error('缺少图片文件');
    const type = imageType(bytes);
    if (!type || bytes.length > 15 * 1024 * 1024) throw new Error('请使用15MB以下的PNG、JPEG或WebP图片');
    const hash = hashOf(bytes);
    let id, filename;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT i.* FROM paper_fingerprints f JOIN imports i ON i.id=f.importId WHERE f.hash=?').get(hash);
      if (previous && previous.state !== 'failed') {
        this.db.exec('COMMIT');
        return {...this.get(previous.id), reused: true};
      }
      id = previous?.id || randomUUID();
      filename = previous?.image || id + '.' + type;
      if (previous) {
        this.db.prepare("UPDATE imports SET state='saving',error=NULL,workToken=NULL,startedAt=? WHERE id=?").run(new Date().toISOString(), id);
      } else {
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO imports(id,image,originalName,state,error,createdAt,contentHash,startedAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, filename, basename(name).slice(0, 250), 'saving', null, now, hash, now);
        this.db.prepare('INSERT INTO paper_fingerprints(hash,importId) VALUES (?,?)').run(hash, id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try {
      await writeImage(resolve(this.imageDir, filename), bytes, this.files);
      this.db.prepare("UPDATE imports SET state='queued' WHERE id=? AND state='saving'").run(id);
      this.schedule();
    } catch (error) {
      this.db.prepare("UPDATE imports SET state='failed',error=? WHERE id=?").run('原图保存失败：' + error.message, id);
    }
    return {...this.get(id), reused: false};
  }

  inspect(bytes) {
    if (!Buffer.isBuffer(bytes) || !imageType(bytes) || bytes.length > 15 * 1024 * 1024) {
      throw new Error('请使用15MB以下的PNG、JPEG或WebP图片');
    }
    const row = this.db.prepare('SELECT i.id FROM paper_fingerprints f JOIN imports i ON i.id=f.importId WHERE f.hash=?').get(hashOf(bytes));
    const existing = row ? this.get(row.id) : null;
    const action = {completed: 'skip', processing: 'resume'}[existing?.state] || 'recognize';
    return {action, existing};
  }

  async original(id) {
    const row = this.db.prepare('SELECT image FROM imports WHERE id=?').get(id);
    if (!row) return null;
    const bytes = await this.files.readFile(resolve(this.imageDir, row.image));
    const type = imageType(bytes);
    return {bytes, contentType: type === 'jpg' ? 'image/jpeg' : 'image/' + type};
  }

  schedule() {
    if (this.closed || this.runner) return;
    this.runnerError = null;
    this.runner = this.drain().catch(error => { this.runnerError = error.message; }).finally(() => {
      this.runner = null;
      if (!this.closed && !this.runnerError) {
        try { if (this.db.prepare("SELECT id FROM imports WHERE state='queued' LIMIT 1").get()) this.schedule(); }
        catch (error) { this.runnerError = error.message; }
      }
    });
  }

  async drain() {
    while (!this.closed) {
      let row;
      const token = randomUUID();
      try {
        row = this.db.prepare("SELECT * FROM imports WHERE state='queued' ORDER BY rowid LIMIT 1").get();
        if (!row) return;
        const claimed = this.db.prepare("UPDATE imports SET state='processing',workToken=? WHERE id=? AND state='queued'").run(token, row.id);
        if (!claimed.changes) continue;
      } catch (error) {
        if (![5, 6].includes(error.errcode)) throw error;
        // SQLite BUSY/LOCKED: retain queued work and back off without inference.
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      try {
        const response = await this.client.recognize(resolve(this.imageDir, row.image), recognitionSchema);
        const data = response.data;
        if (!Array.isArray(data.questions) || data.questions.length > 100) throw new Error('识别题目列表无效');
        for (const q of data.questions) {
          for (const field of ['question', 'studentAnswer', 'possibleCause']) {
            if (typeof q[field] !== 'string') throw new Error('识别结果格式不完整');
          }
        }
        await this.withWriteRetry(() => {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const current = this.db.prepare("SELECT id FROM imports WHERE id=? AND state='processing' AND workToken=?").get(row.id, token);
            if (current) {
              for (const q of data.questions) {
                this.db.prepare('INSERT INTO questions(id,importId,state,content,createdAt) VALUES (?,?,?,?,?)')
                  .run(randomUUID(), row.id, 'pending', JSON.stringify({...q, causeStatus: 'pending', unclear: data.unclear || []}), new Date().toISOString());
              }
              this.db.prepare("UPDATE imports SET state='completed',workToken=NULL,error=NULL WHERE id=?").run(row.id);
            }
            this.db.exec('COMMIT');
          } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        });
      } catch (error) {
        await this.withWriteRetry(() => this.db.prepare("UPDATE imports SET state='failed',workToken=NULL,error=? WHERE id=? AND state='processing' AND workToken=?")
          .run(error.message, row.id, token));
      }
    }
  }

  async withWriteRetry(write) {
    while (true) {
      try { return write(); }
      catch (error) {
        if (![5, 6].includes(error.errcode & 255)) throw error;
        if (this.closed) return;
      }
      // Retain the inference response in memory and retry only persistence.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async idle() {
    while (this.runner) await this.runner;
  }

  async close() {
    this.closed = true;
    await this.idle();
  }
}

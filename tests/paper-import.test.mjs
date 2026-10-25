import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {PaperImports} from '../app/paper-import.mjs';
import {deferred, until, testDirectory, png, recognition} from './helpers.mjs';

test('concurrent identical images share one durable task and one recognition', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'), pending = deferred();
  let calls = 0;
  const papers = await PaperImports.open({db, dataDir, client: {recognize: async () => { calls++; return pending.promise; }}});
  const bytes = png('same');
  const [a, b] = await Promise.all([papers.submit({bytes, name: 'a.png'}), papers.submit({bytes, name: 'renamed.png'})]);
  assert.equal(a.id, b.id); await until(() => calls === 1);
  pending.resolve(recognition()); await papers.idle();
  assert.equal(papers.get(a.id).state, 'completed');
  assert.equal(papers.get(a.id).count, 1);
  assert.equal(papers.questions(a.id)[0].state, 'pending');
  assert.equal(papers.questions(a.id)[0].content.causeStatus, 'pending');
  assert.equal(papers.inspect(bytes).action, 'skip');
  assert.equal((await papers.submit({bytes, name: 'again.png'})).reused, true);
  assert.equal(calls, 1); assert.equal(papers.list().length, 1);
  await papers.close(); db.close();
});

test('different images queue sequentially instead of sharing a global busy race', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'), work = [];
  let active = 0, maximum = 0;
  const papers = await PaperImports.open({db, dataDir, client: {recognize: async () => {
    active++; maximum = Math.max(maximum, active); const d = deferred(); work.push(d);
    try { return await d.promise; } finally { active--; }
  }}});
  const first = await papers.submit({bytes: png('first'), name: 'first.png'});
  const second = await papers.submit({bytes: png('second'), name: 'second.png'});
  await until(() => work.length === 1);
  assert.equal(papers.get(second.id).stage, 'queued'); assert.equal(papers.busy, true);
  work[0].resolve(recognition('first')); await until(() => work.length === 2);
  work[1].resolve(recognition('second')); await papers.idle();
  assert.equal(maximum, 1); assert.equal(papers.busy, false);
  assert.equal(papers.get(first.id).state, 'completed'); assert.equal(papers.get(second.id).state, 'completed');
  await papers.close(); db.close();
});

test('recognition failure keeps the source; only explicit resubmission retries', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:');
  let calls = 0, source;
  const papers = await PaperImports.open({db, dataDir, client: {recognize: async path => {
    source = path; calls++; if (calls === 1) throw new Error('synthetic failure'); return recognition();
  }}});
  const bytes = png('retry'), task = await papers.submit({bytes, name: 'retry.png'});
  await papers.idle(); assert.equal(papers.get(task.id).state, 'failed');
  assert.deepEqual(await fs.readFile(source), bytes); assert.equal(calls, 1);
  assert.equal(papers.inspect(bytes).action, 'recognize');
  const retried = await papers.submit({bytes, name: 'retry.png'}); await papers.idle();
  assert.equal(retried.id, task.id); assert.equal(calls, 2); assert.equal(papers.questions(task.id).length, 1);
  await papers.close(); db.close();
});

test('source write failure never starts inference and is visible through the task interface', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'); let calls = 0;
  const papers = await PaperImports.open({db, dataDir, files: {...fs, writeFile: async () => { throw new Error('disk full'); }}, client: {recognize: async () => { calls++; return recognition(); }}});
  const result = await papers.submit({bytes: png(), name: 'write.png'});
  assert.equal(result.state, 'failed'); assert.match(result.message, /disk full/); assert.equal(calls, 0);
  await papers.close(); db.close();
});

test('a partial write during retry preserves the original image bytes', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:');
  let calls = 0, failWrite = false;
  const papers = await PaperImports.open({db, dataDir, files: {...fs, writeFile: async (path, bytes, options) => {
    if (failWrite) { await fs.writeFile(path, bytes.subarray(0, 4), options); throw new Error('disk full after partial write'); }
    return fs.writeFile(path, bytes, options);
  }}, client: {recognize: async () => { calls++; throw new Error('model unavailable'); }}});
  const bytes = png('preserve-original'), task = await papers.submit({bytes, name: 'source.png'});
  await papers.idle(); failWrite = true;
  assert.equal((await papers.submit({bytes, name: 'retry.png'})).state, 'failed');
  assert.deepEqual((await papers.original(task.id)).bytes, bytes);
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(join(dataDir, 'images'))).some(name => name.endsWith('.tmp')), false);
  await papers.close(); db.close();
});

test('legacy migration fingerprints originals without changing existing question content or state', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:');
  await fs.mkdir(join(dataDir, 'images'));
  const bytes = png('legacy'); await fs.writeFile(join(dataDir, 'images', 'old.png'), bytes);
  db.exec('CREATE TABLE imports(id TEXT PRIMARY KEY,image TEXT,originalName TEXT,state TEXT,error TEXT,createdAt TEXT); CREATE TABLE questions(id TEXT PRIMARY KEY,importId TEXT,state TEXT,content TEXT,createdAt TEXT);');
  db.prepare('INSERT INTO imports VALUES (?,?,?,?,?,?)').run('old', 'old.png', 'original.png', 'completed', null, '2026-01-01');
  const content = {number: '1', question: '旧题目', studentAnswer: '原作答', causeStatus: 'pending'};
  db.prepare('INSERT INTO questions VALUES (?,?,?,?,?)').run('q', 'old', 'library', JSON.stringify(content), '2026-01-01');
  let calls = 0;
  const papers = await PaperImports.open({db, dataDir, client: {recognize: async () => { calls++; return recognition(); }}});
  assert.equal(papers.inspect(bytes).existing.id, 'old'); assert.equal(papers.inspect(bytes).action, 'skip');
  assert.deepEqual(papers.questions('old')[0].content, content); assert.equal(papers.questions('old')[0].state, 'library');
  assert.equal(calls, 0); await papers.close(); db.close();
});

test('recovery preserves interrupted work as failed, resumes only queued work, and rejects stale completion', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'), oldResult = deferred();
  let oldCalls = 0, newCalls = 0;
  const old = await PaperImports.open({db, dataDir, client: {recognize: async () => { oldCalls++; return oldResult.promise; }}});
  const bytes = png('interrupted'), task = await old.submit({bytes, name: 'paper.png'});
  await until(() => oldCalls === 1);
  const recovered = await PaperImports.open({db, dataDir, client: {recognize: async () => { newCalls++; return recognition('new result'); }}});
  assert.equal(recovered.get(task.id).state, 'failed'); assert.equal(newCalls, 0);
  await recovered.submit({bytes, name: 'paper.png'}); await recovered.idle();
  oldResult.resolve(recognition('stale result')); await old.idle();
  assert.equal(recovered.questions(task.id).length, 1); assert.equal(recovered.questions(task.id)[0].content.question, 'new result');
  assert.equal(newCalls, 1); await old.close(); await recovered.close(); db.close();
});

test('queued originals resume after reopening without losing their source', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:');
  const first = await PaperImports.open({db, dataDir, client: {recognize: async () => recognition()}});
  await first.close();
  await fs.writeFile(join(dataDir, 'images', 'queued.png'), png('queued'));
  db.prepare('INSERT INTO imports(id,image,originalName,state,createdAt) VALUES (?,?,?,?,?)').run('queued', 'queued.png', 'queued.png', 'queued', '2026-01-01');
  let calls = 0; const reopened = await PaperImports.open({db, dataDir, client: {recognize: async () => { calls++; return recognition(); }}});
  await reopened.idle(); assert.equal(reopened.get('queued').state, 'completed'); assert.equal(calls, 1);
  await reopened.close(); db.close();
});

test('a SQLite write lock leaves queued work recoverable and backs off before retry', async t => {
  let db, locker, papers;
  t.after(async () => { if (locker?.isTransaction) locker.exec('ROLLBACK'); await papers?.close(); locker?.close(); db?.close(); });
  const dataDir = await testDirectory(t), path = join(dataDir, 'notebook.sqlite');
  db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL');
  let calls = 0;
  papers = await PaperImports.open({db, dataDir, client: {recognize: async () => { calls++; return recognition(); }}});
  await papers.idle();
  await fs.writeFile(join(dataDir, 'images/queued.png'), png('locked'));
  db.prepare('INSERT INTO imports(id,image,originalName,state,createdAt) VALUES (?,?,?,?,?)').run('queued', 'queued.png', 'queued.png', 'queued', '2026-01-01');
  locker = new DatabaseSync(path); locker.exec('BEGIN IMMEDIATE');
  papers.schedule();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(papers.get('queued').stage, 'queued'); assert.equal(calls, 0);
  locker.exec('ROLLBACK'); await papers.idle();
  assert.equal(papers.get('queued').stage, 'completed'); assert.equal(calls, 1);
});

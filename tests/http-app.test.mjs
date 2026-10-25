import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {createNotebook} from '../app/http-app.mjs';
import {CodexClient} from '../app/codex-client.mjs';
import {FakeCodexProcess, testDirectory, png, recognition, grading, until, deferred} from './helpers.mjs';

async function start(db, dataDir) {
  const counts = {recognition: 0, grading: 0};
  const client = new CodexClient({processFactory: () => new FakeCodexProcess({onTurn: (r, p) => {
    p.acknowledge(r);
    if (r.params.input.some(i => i.type === 'localImage')) { counts.recognition++; p.complete(r, recognition().data); }
    else { counts.grading++; p.complete(r, grading().data); }
  }})});
  const app = await createNotebook({db, client, dataDir});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (path, method = 'GET', data, headers = {}) => {
    const response = await fetch(base + path, {method, headers: {'Content-Type': 'application/json', 'X-Mido-Client': 'desktop', ...headers}, ...(data ? {body: JSON.stringify(data)} : {})});
    return {status: response.status, data: await response.json()};
  };
  const wait = async (path, predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const result = (await request(path)).data; if (predicate(result)) return result; await new Promise(r => setTimeout(r, 5)); }
    throw new Error('HTTP result did not settle');
  };
  return {...app, base, request, wait, counts};
}

test('real HTTP adapter shares content dedup, durable task status and pending results', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:');
  const app = await start(db, dataDir); t.after(async () => { await app.close(); db.close(); });
  const bytes = png('http'), input = {name: 'first.png', base64: bytes.toString('base64')};
  assert.equal((await app.request('/api/import/check', 'POST', input)).data.action, 'recognize');
  const [a, b] = await Promise.all([app.request('/api/import', 'POST', input), app.request('/api/import', 'POST', {...input, name: 'renamed.png'})]);
  assert.equal(a.data.id, b.data.id);
  const id = a.data.id, status = await app.wait('/api/jobs/' + id, r => r.state === 'completed');
  assert.equal(status.count, 1); assert.equal(app.counts.recognition, 1);
  assert.equal((await app.request('/api/imports')).data.length, 1);
  const questions = (await app.request('/api/questions?importId=' + id)).data;
  assert.equal(questions.length, 1); assert.equal(questions[0].state, 'pending');
  assert.equal((await app.request('/api/import/check', 'POST', input)).data.action, 'skip');
  assert.deepEqual(Buffer.from(await (await fetch(app.base + '/images/' + id)).arrayBuffer()), bytes);
  assert.equal((await app.request('/api/import', 'POST', input, {Origin: 'http://untrusted.invalid'})).status, 403);
  assert.equal((await fetch(app.base + '/api/import', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)})).status, 403);
});

test('reopening the app preserves task results and review history without model resubmission', async t => {
  let db, app;
  t.after(async () => { await app?.close(); db?.close(); });
  const dataDir = await testDirectory(t), databasePath = join(dataDir, 'notebook.sqlite');
  db = new DatabaseSync(databasePath); app = await start(db, dataDir);
  const input = {name: 'paper.png', base64: png('durable').toString('base64')};
  const task = (await app.request('/api/import', 'POST', input)).data;
  await app.wait('/api/jobs/' + task.id, r => r.state === 'completed');
  const q = (await app.request('/api/questions?importId=' + task.id)).data[0];
  await app.request('/api/questions/' + q.id, 'PATCH', {state: 'library'});
  const session = (await app.request('/api/review/sessions', 'POST', {questionIds: [q.id], isTest: true})).data;
  const item = session.items[0]; assert.equal('originalAnswer' in item, false);
  await app.request('/api/review/items/' + item.id + '/submit', 'POST', {answer: '2'});
  const result = await app.wait('/api/review/items/' + item.id, r => r.state === 'graded');
  assert.equal(result.result, 'independent_correct');
  await app.close(); db.close(); db = new DatabaseSync(databasePath); app = await start(db, dataDir);
  assert.equal((await app.request('/api/jobs/' + task.id)).data.state, 'completed');
  assert.equal((await app.request('/api/review/sessions/' + session.id)).data.items[0].result, 'independent_correct');
  assert.equal((await app.request('/api/import', 'POST', input)).data.reused, true);
  assert.equal(app.counts.recognition, 0);
  assert.equal((await app.request('/api/questions?importId=' + task.id)).data[0].content.causeStatus, 'pending');
});

test('shutdown cancels model waits before draining an unfinished HTTP body', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'), waiting = deferred();
  let cancelled = false;
  const client = {request: () => waiting.promise, close: () => { cancelled = true; waiting.reject(new Error('closed')); }};
  const app = await createNotebook({db, client, dataDir, shutdownTimeoutMs: 20});
  t.after(async () => { await app.close(); db.close(); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const status = fetch(base + '/api/status').catch(() => null);
  let bodyStarted = false;
  app.server.on('request', req => { if (req.url === '/api/import') req.once('data', () => { bodyStarted = true; }); });
  const upload = http.request(base + '/api/import', {method: 'POST', headers: {'X-Mido-Client': 'desktop', 'Content-Length': 1000}});
  upload.on('error', () => {}); upload.write('{');
  t.after(() => upload.destroy());
  await until(() => bodyStarted);
  const close = app.close();
  assert.equal(cancelled, true, 'cancel the model before waiting for HTTP drain');
  await close; await status;
  assert.equal(app.server.listening, false);
});

test('two real HTTP bodies released together cannot both start grading', async t => {
  const dataDir = await testDirectory(t), db = new DatabaseSync(':memory:'), app = await start(db, dataDir);
  t.after(async () => { await app.close(); db.close(); });
  const task = (await app.request('/api/import', 'POST', {name: 'paper.png', base64: png('concurrent').toString('base64')})).data;
  await app.wait('/api/jobs/' + task.id, r => r.state === 'completed');
  const q = (await app.request('/api/questions?importId=' + task.id)).data[0];
  await app.request('/api/questions/' + q.id, 'PATCH', {state: 'library'});
  const session = (await app.request('/api/review/sessions', 'POST', {questionIds: [q.id]})).data;
  const path = '/api/review/items/' + session.items[0].id + '/submit'; let startedBodies = 0;
  app.server.on('request', req => { if (req.url === path) req.once('data', () => { startedBodies++; }); });
  function partial(answer) {
    const payload = JSON.stringify({answer}), response = deferred();
    const req = http.request(app.base + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Mido-Client': 'desktop', 'Content-Length': Buffer.byteLength(payload)}}, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => response.resolve({status: res.statusCode, data: JSON.parse(text)}));
    });
    req.on('error', response.reject); req.write(payload.slice(0, 5));
    return {finish: () => req.end(payload.slice(5)), response: response.promise};
  }
  const a = partial('first'), b = partial('second');
  await until(() => startedBodies === 2); a.finish(); b.finish();
  const results = await Promise.all([a.response, b.response]);
  assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
  const result = await app.wait('/api/review/items/' + session.items[0].id, r => r.state === 'graded');
  assert.equal(result.answer, results.find(r => r.status === 202).data.answer);
  assert.equal(app.counts.grading, 1);
});

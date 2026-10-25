import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ReviewService} from '../app/review-service.mjs';
import {imageType} from '../app/paper-import.mjs';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {deferred, grading, png, until, testDirectory} from './helpers.mjs';

function setup(t, client, extra = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE imports(id TEXT,originalName TEXT); CREATE TABLE questions(id TEXT,state TEXT,importId TEXT,content TEXT);');
  db.prepare('INSERT INTO imports VALUES (?,?)').run('paper', 'synthetic-tests.jpg');
  for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO questions VALUES (?,?,?,?)')
    .run('q' + i, i === 5 ? 'pending' : 'library', 'paper', JSON.stringify({number: String(i), subject: '数学', question: '合成题' + i,
      studentAnswer: '原答案不能提前泄露', observedError: '原分析不能提前泄露', knowledgePoint: '测试', possibleCause: '待确认', causeStatus: 'pending'}));
  const options = {db, client, dataDir: 'unused', imageType, ...extra};
  const service = new ReviewService(options);
  const request = async (method, path, input = {}) => {
    let result;
    await service.handle({method}, {}, path, {body: () => Promise.resolve(input), json: (_, status, data) => { result = {status, data}; }});
    return result;
  };
  return {db, service, request, options};
}
async function session(request, ids = ['q1'], isTest = true) {
  return (await request('POST', '/api/review/sessions', {questionIds: ids, isTest})).data;
}

test('public review interface hides answers until grading and preserves four result categories', async t => {
  let verdict = 'correct';
  const {request, service} = setup(t, {runJson: async ({schema}) => schema.properties.hint ? {data: {hint: '先找条件'}} : grading(verdict)});
  assert.equal((await request('POST', '/api/review/sessions', {questionIds: ['q5']})).status, 400);
  const s = await session(request, ['q1', 'q2', 'q3', 'q4']);
  for (let i = 0; i < s.items.length; i++) {
    const id = s.items[i].id, path = '/api/review/items/' + id;
    const before = (await request('GET', path)).data;
    assert.equal('grading' in before, false); assert.equal('originalAnswer' in before, false);
    assert.equal('studentAnswer' in before.question, false); assert.equal('observedError' in before.question, false);
    if (i === 2) { await request('POST', path + '/hint'); await service.idle(); }
    verdict = i === 1 ? 'incorrect' : i === 3 ? 'uncertain' : 'correct';
    assert.equal((await request('POST', path + '/submit', {answer: '测试作答'})).status, 202); await service.idle();
    const after = (await request('GET', path)).data;
    assert.equal(after.result, ['independent_correct', 'incorrect', 'hinted_correct', 'pending'][i]);
    assert.ok(after.grading.reason); assert.equal(after.originalAnswer, '原答案不能提前泄露');
    assert.equal((await request('POST', path + '/submit', {answer: '重复'})).status, 409);
  }
  assert.equal((await request('GET', '/api/review/sessions/' + s.id)).data.state, 'completed');
  assert.equal((await request('GET', '/api/review/recommendations')).data.every(q => q.reason.startsWith('尚未复习')), true);
  const path = '/api/review/items/' + s.items[0].id;
  const disputed = (await request('POST', path + '/dispute', {message: '测试异议'})).data;
  assert.equal(disputed.result, 'pending'); assert.equal(disputed.grading.verdict, 'correct');
});

test('two bodies released together accept one submission and start one grader', async t => {
  const gradingWork = deferred(); let calls = 0;
  const {request, service} = setup(t, {runJson: async () => { calls++; return gradingWork.promise; }});
  const s = await session(request), path = '/api/review/items/' + s.items[0].id + '/submit';
  const a = deferred(), b = deferred();
  const p = request('POST', path, a.promise), q = request('POST', path, b.promise);
  a.resolve({answer: 'first'}); b.resolve({answer: 'second'});
  const responses = await Promise.all([p, q]); assert.deepEqual(responses.map(r => r.status).sort(), [202, 409]);
  assert.equal(calls, 1); const accepted = responses.find(r => r.status === 202).data.answer;
  gradingWork.resolve(grading()); await service.idle();
  assert.equal((await request('GET', path.replace('/submit', ''))).data.answer, accepted);
});

test('a hint and a delayed submission obey the same occupation rule', async t => {
  const hintWork = deferred(); let calls = 0;
  const {request, service} = setup(t, {runJson: async () => { calls++; return hintWork.promise; }});
  const s = await session(request), path = '/api/review/items/' + s.items[0].id;
  const body = deferred(); const submitting = request('POST', path + '/submit', body.promise);
  assert.equal((await request('POST', path + '/hint')).status, 202);
  body.resolve({answer: '2'}); assert.equal((await submitting).status, 409); assert.equal(calls, 1);
  hintWork.resolve({data: {hint: '先找条件'}}); await service.idle();
  assert.equal((await request('GET', path)).data.hintUsed, true);
});

test('failed image persistence preserves text and never invokes a grader', async t => {
  let calls = 0;
  const {request} = setup(t, {runJson: async () => { calls++; return grading(); }}, {
    files: {mkdir: async () => {}, writeFile: async () => { throw new Error('disk full'); }},
  });
  const s = await session(request), path = '/api/review/items/' + s.items[0].id;
  assert.equal((await request('POST', path + '/submit', {answer: '保存这段作答', imageBase64: png().toString('base64')})).status, 500);
  const item = (await request('GET', path)).data;
  assert.equal(item.state, 'failed'); assert.equal(item.result, null); assert.equal(item.answer, '保存这段作答'); assert.equal(calls, 0);
});

test('recovery prevents an old grading callback from overwriting a new result', async t => {
  const oldWork = deferred();
  const {request, service, options} = setup(t, {runJson: async () => oldWork.promise});
  const s = await session(request), path = '/api/review/items/' + s.items[0].id;
  await request('POST', path + '/submit', {answer: '旧作答'});
  const recovered = new ReviewService({...options, client: {runJson: async () => grading('incorrect')}});
  async function next(method, suffix, input) { let out; await recovered.handle({method}, {}, path + suffix, {body: async () => input, json: (_, status, data) => { out = {status, data}; }}); return out; }
  const interrupted = (await next('GET', '')).data;
  assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.answer, '旧作答'); assert.equal(interrupted.result, null);
  await next('POST', '/submit', {answer: '新作答'}); await recovered.idle();
  oldWork.resolve(grading('correct')); await service.idle();
  const item = (await next('GET', '')).data;
  assert.equal(item.answer, '新作答'); assert.equal(item.result, 'incorrect'); assert.equal(item.grading.verdict, 'incorrect');
});

test('recovery during replacement image saving retains the last complete image', async t => {
  const dataDir = await testDirectory(t), saving = deferred(); let began = false;
  const {request, service, options, db} = setup(t, {runJson: async () => grading()}, {
    dataDir, files: {...fs, writeFile: async (path, bytes, flags) => {
      began = true; await saving.promise; return fs.writeFile(path, bytes, flags);
    }},
  });
  const s = await session(request), id = s.items[0].id, path = '/api/review/items/' + id;
  await fs.mkdir(join(dataDir, 'review-images'));
  const oldBytes = png('old-complete');
  await fs.writeFile(join(dataDir, 'review-images/old.png'), oldBytes);
  db.prepare('UPDATE review_items SET answerImage=? WHERE id=?').run('old.png', id);
  const interrupted = request('POST', path + '/submit', {answer: '保存文字', imageBase64: png('replacement').toString('base64')});
  await until(() => began);
  const recovered = new ReviewService({...options, client: {runJson: async ({images}) => {
    assert.deepEqual(await fs.readFile(images[0]), oldBytes); return grading();
  }}});
  assert.equal(recovered.item(id).answerImage, 'old.png');
  assert.equal(recovered.item(id).answer, '保存文字');
  let response;
  await recovered.handle({method: 'POST'}, {}, path + '/submit', {body: async () => ({answer: '文字重试'}), json: (_, status) => { response = status; }});
  assert.equal(response, 202); await recovered.idle();
  saving.resolve(); await interrupted; await service.idle();
  assert.equal(recovered.item(id).state, 'graded');
  assert.equal(recovered.item(id).answerImage, 'old.png');
  assert.equal(recovered.item(id).answer, '文字重试');
  assert.deepEqual(await fs.readdir(join(dataDir, 'review-images')), ['old.png']);
});

test('model failure is retryable, while real graded outcomes affect recommendation priority', async t => {
  let calls = 0;
  const {request, service} = setup(t, {runJson: async () => { calls++; if (calls === 1) throw new Error('model unavailable'); return grading('incorrect'); }});
  const s = await session(request, ['q1'], false), path = '/api/review/items/' + s.items[0].id;
  await request('POST', path + '/submit', {answer: '答案'}); await service.idle();
  assert.equal((await request('GET', path)).data.result, null);
  await request('POST', path + '/submit', {answer: '重新作答'}); await service.idle();
  assert.equal((await request('GET', path)).data.result, 'incorrect');
  const list = (await request('GET', '/api/review/recommendations')).data;
  assert.equal(list[0].id, 'q1'); assert.match(list[0].reason, /仍不会/); assert.equal(calls, 2);
});

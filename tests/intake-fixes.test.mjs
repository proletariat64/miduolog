import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile, rename, writeFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {testDirectory, png} from './helpers.mjs';
import {createIntakeServer} from '../app/intake-http.mjs';
import {createNotebook} from '../app/http-app.mjs';

const q = (question = '计算 1+1', extra = {}) => ({number: '1', subject: '数学', question, studentAnswer: '', knowledgePoint: '加法', observedError: '', possibleCause: '', needsConfirmation: false, completeness: 'complete', answerStatus: 'unanswered', ...extra});
async function setup(t, responses = {}, factory = createIntakeServer) {
  let app, db, calls = 0; const prompts = [];
  t.after(async () => { await app?.close(); db?.close(); });
  const dataDir = await testDirectory(t), path = join(dataDir, 'intake.sqlite');
  const client = {recognize: async file => {
    calls++;
    const label = (await readFile(file)).subarray(8).toString();
    const value = responses[label] || responses['*'] || {questions: [q()], answers: [], unclear: []};
    if (value instanceof Error) throw value;
    return {data: typeof value === 'function' ? await value() : value};
  }, runJson: async input => { prompts.push(JSON.parse(input.prompt)); return input.schema.properties.hint ? {data: {hint: '先读材料'}} : ({data: {verdict: 'correct', recognizedAnswer: '2', reason: '测试', referenceAnswer: '2', explanation: '测试', nextStep: '', uncertainties: []}}); }, close() {}};
  async function open() {
    db = new DatabaseSync(path); app = await factory({db, client, dataDir});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  await open();
  const request = async (route, method = 'GET', body) => {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + route, {method,
      headers: {'Content-Type': 'application/json', 'X-Mido-Client': 'desktop'}, ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, data: await response.json()};
  };
  const upload = async (labels, requestId = crypto.randomUUID()) => (await request('/api/intake/batches', 'POST', {requestId, files: labels.map(label => ({name: label + '.png', base64: png(label).toString('base64')}))})).data;
  const settle = async id => {
    for (let i = 0; i < 200; i++) {
      const batch = (await request('/api/intake/batches/' + id)).data;
      if (batch.state !== 'processing') return batch;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('batch did not settle');
  };
  return {request, upload, settle, responses, prompts, dataDir, databasePath: path, calls: () => calls, reopen: async () => { await app.close(); db.close(); await open(); }};
}


test('repeated original-attempt edits preserve flat truthful history with linear response growth', async t => {
  const app = await setup(t, {one: {questions: [q('history', {studentAnswer: '3', answerStatus: 'answered'})]}});
  const original = (await app.settle((await app.upload(['one'])).id)).questions[0], id = original.attempts[0].id;
  const sizes = [];
  for (let i = 0; i < 12; i++) {
    const response = await app.request('/api/intake/attempts/' + id, 'PATCH', {status: i % 2 ? 'correct' : 'incorrect', statusReason: 'edit ' + i});
    assert.equal(response.status, 200); sizes.push(JSON.stringify(response.data).length);
    const change = response.data.history.at(-1);
    assert.equal('history' in change.before, false); assert.equal(change.after.statusReason, 'edit ' + i);
  }
  assert.ok(sizes.at(-1) < sizes[0] * 15, JSON.stringify(sizes));
});

test('interrupted upload becomes recoverable and same request resumes without replaying completed inference', async t => {
  const app = await setup(t), requestId = crypto.randomUUID();
  const batch = await app.settle((await app.upload(['saved'], requestId)).id);
  const seed = new DatabaseSync(app.databasePath); seed.prepare('UPDATE intake_batches SET sealed=0 WHERE id=?').run(batch.id); seed.close();
  await app.reopen();
  assert.notEqual((await app.request('/api/intake/batches/' + batch.id)).data.state, 'processing');
  assert.equal((await app.upload(['saved'])).id, batch.id);
  assert.equal((await app.settle(batch.id)).state, 'completed'); assert.equal(app.calls(), 1);
});


test('reupload repairs a missing original instead of permanently reusing failed photo metadata', async t => {
  const app = await setup(t), images = join(app.dataDir, 'images'), saved = join(app.dataDir, 'images-saved');
  await rename(images, saved); await writeFile(images, 'blocked');
  const failed = await app.settle((await app.upload(['repair'])).id);
  assert.equal(failed.state, 'partial_failure'); assert.equal(app.calls(), 0);
  await unlink(images); await rename(saved, images);
  const repaired = await app.settle((await app.upload(['repair'])).id);
  assert.equal(repaired.state, 'completed'); assert.equal(repaired.questions.length, 1); assert.equal(app.calls(), 1);
});


test('retry reports missing original without model calls, and the same upload request repairs it', async t => {
  const app = await setup(t, {retry: new Error('adapter unavailable')}), requestId = crypto.randomUUID();
  const batch = await app.settle((await app.upload(['retry'], requestId)).id);
  const image = new DatabaseSync(app.databasePath); const file = image.prepare('SELECT file FROM intake_photos WHERE id=?').get(batch.photos[0].id).file; image.close();
  await unlink(join(app.dataDir, 'images', file));
  const retry = await app.request('/api/intake/batches/' + batch.id + '/retry', 'POST');
  assert.equal(retry.data.state, 'partial_failure'); assert.match(retry.data.photos[0].error, /原图/); assert.equal(app.calls(), 1);
  delete app.responses.retry;
  assert.equal((await app.settle((await app.upload(['retry'], requestId)).id)).state, 'completed');
  assert.equal(app.calls(), 2);
});


const paper = {documentId: 'EXAM-42', subject: '数学'};
const answer = {number: '1', studentAnswer: '8', answerStatus: 'answered', matchKey: 'EXAM-42'};
test('manual answer association accepts an active split child visible in the same batch', async t => {
  const app = await setup(t, {parts: {paper, questions: [q('第一问和第二问')], answers: [{...answer, number: '?'}]}});
  const batch = await app.settle((await app.upload(['parts'])).id), original = batch.questions[0];
  const split = await app.request('/api/intake/questions/' + original.id + '/split', 'POST', {requestId: crypto.randomUUID(), parts: [{content: {question: '第一问'}}, {content: {question: '第二问'}}]});
  const link = await app.request('/api/intake/fragments/' + batch.fragments[0].id + '/link', 'POST', {questionId: split.data[0].id});
  assert.equal(link.status, 200); assert.equal(link.data.questionId, split.data[0].id);
});

test('fragment uniqueness waits for failed batch photos and excludes removed question targets', async t => {
  const app = await setup(t, {question: {paper, questions: [q('待关联题目')]}, answers: {paper, questions: [], answers: [answer]}, missing: new Error('暂不可读')});
  const batch = await app.settle((await app.upload(['question', 'answers', 'missing'])).id);
  assert.equal(batch.fragments[0].state, 'unlinked'); assert.match(batch.fragments[0].warning, /尚未全部可用/);
  await app.request('/api/intake/questions/' + batch.questions[0].id, 'DELETE');
  app.responses.missing = {questions: [], answers: []};
  await app.request('/api/intake/batches/' + batch.id + '/retry', 'POST');
  const retried = await app.settle(batch.id);
  assert.equal(retried.fragments[0].state, 'unlinked'); assert.deepEqual(retried.fragments[0].candidates, []);
  await app.reopen(); assert.equal((await app.request('/api/intake/batches/' + batch.id)).status, 200);
});


test('unsupported nested question methods cannot mutate the parent question', async t => {
  const app = await setup(t), qid = (await app.settle((await app.upload(['route'])).id)).questions[0].id;
  assert.equal((await app.request('/api/intake/questions/' + qid + '/attempts', 'DELETE')).status, 405);
  assert.equal((await app.request('/api/intake/questions/' + qid + '/split', 'PATCH', {content: {question: 'should not replace'}})).status, 405);
  const question = (await app.request('/api/intake/questions/' + qid)).data;
  assert.equal(question.removed, false); assert.equal(question.content.question, '计算 1+1');
});

test('invalid extraction materials fail the affected photo without poisoning future startup or healthy batches', async t => {
  const app = await setup(t, {bad: {materials: [{key: 'bad', text: 'x'.repeat(30001)}], questions: [q('坏数据')]}, good: {questions: [q('好数据')]}});
  const batch = await app.settle((await app.upload(['bad', 'good'])).id);
  assert.equal(batch.state, 'partial_failure'); assert.equal(batch.photos[0].state, 'failed');
  assert.deepEqual(batch.questions.map(q => q.content.question), ['好数据']);
  const seed = new DatabaseSync(app.databasePath); seed.prepare("UPDATE intake_photos SET state='completed',extraction=? WHERE id=?").run(JSON.stringify(app.responses.bad), batch.photos[0].id); seed.close();
  await app.reopen();
  const recovered = (await app.request('/api/intake/batches/' + batch.id)).data;
  assert.equal(recovered.photos[0].state, 'failed'); assert.equal(recovered.questions.length, 1);
});

test('duplicate resolution keeps page uncertainty and does not invent a definite error', async t => {
  const wrong = q('重复但看不清', {studentAnswer: '3', answerStatus: 'answered', observedError: '加法结果错误', aiAssessment: {verdict: 'incorrect', reason: '1+1=2'}});
  const app = await setup(t, {first: {questions: [wrong]}, second: {questions: [wrong], unclear: ['拍摄模糊，原作答未确认']}});
  await app.settle((await app.upload(['first'])).id);
  const batch = await app.settle((await app.upload(['second'])).id), decision = batch.decisions[0];
  await app.request('/api/intake/decisions/' + decision.id, 'POST', {action: 'new'});
  const question = (await app.request('/api/intake/batches/' + batch.id)).data.questions[0];
  assert.equal(question.latestStatus, 'pending'); assert.ok(question.attempts[0].unclear.includes('拍摄模糊，原作答未确认'));
});


test('shared reading materials are available in review display and frozen hint and grading inputs', async t => {
  const app = await setup(t, {reading: {materials: [{key: 'story', text: '小明终于找到了小狗，因此很高兴。'}], questions: [q('主人公为什么高兴？', {subject: '语文', materialKeys: ['story']})]}}, createNotebook);
  const question = (await app.settle((await app.upload(['reading'])).id)).questions[0];
  await app.request('/api/intake/questions/' + question.id, 'PATCH', {verified: true});
  const session = (await app.request('/api/review/sessions', 'POST', {questionIds: [question.id], isTest: true})).data;
  assert.match(session.items[0].question.question, /小明终于找到了小狗/);
  await app.request('/api/intake/materials/' + question.materials[0].id, 'PATCH', {text: '后来修改的另一篇文章'});
  const path = '/api/review/items/' + session.items[0].id;
  await app.request(path + '/hint', 'POST');
  for (let i = 0; i < 100 && (await app.request(path)).data.state === 'hinting'; i++) await new Promise(r => setTimeout(r, 5));
  await app.request(path + '/submit', 'POST', {answer: '因为找到了小狗'});
  assert.equal(app.prompts.length, 2);
  for (const prompt of app.prompts) { assert.match(prompt.question, /小明终于找到了小狗/); assert.doesNotMatch(prompt.question, /后来修改/); }
});

test('legacy edits synchronize answer and cause fields while state-only edits preserve newer intake corrections', async t => {
  const app = await setup(t, {legacy: {questions: [q('旧题目', {studentAnswer: '2', answerStatus: 'answered', possibleCause: '旧错因', causeStatus: 'confirmed'})]}}, createNotebook);
  const task = (await app.request('/api/import', 'POST', {name: 'legacy.png', base64: png('legacy').toString('base64')})).data;
  for (let i = 0; i < 100 && (await app.request('/api/jobs/' + task.id)).data.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
  const old = (await app.request('/api/questions?importId=' + task.id)).data[0];
  const seed = new DatabaseSync(app.databasePath);
  seed.prepare('UPDATE questions SET content=? WHERE id=?').run(JSON.stringify({...old.content, causeStatus: 'confirmed'}), old.id); seed.close();
  await app.reopen();
  const migrated = (await app.request('/api/intake/questions/' + old.id)).data;
  assert.equal(migrated.attempts[0].causeStatus, 'confirmed');
  const edited = await app.request('/api/questions/' + old.id, 'PATCH', {studentAnswer: '3', observedError: '结果错误', possibleCause: '进位遗漏', causeStatus: 'disputed', state: 'library'});
  assert.equal(edited.status, 200);
  const after = (await app.request('/api/intake/questions/' + old.id)).data;
  assert.equal(after.attempts[0].studentAnswer, '3'); assert.equal(after.attempts[0].observedError, '结果错误');
  assert.equal(after.attempts[0].possibleCause, '进位遗漏'); assert.equal(after.attempts[0].causeStatus, 'disputed');
  assert.ok(after.attempts[0].revision > migrated.attempts[0].revision);
  await app.request('/api/intake/attempts/' + after.attempts[0].id, 'PATCH', {studentAnswer: '人工更新4'});
  await app.request('/api/questions/' + old.id, 'PATCH', {state: 'library'});
  assert.equal((await app.request('/api/intake/questions/' + old.id)).data.attempts[0].studentAnswer, '人工更新4');
});


test('resuming an interrupted multi-photo upload restores missing membership and a source saved before interruption', async t => {
  const app = await setup(t, {one: {questions: [q('第一张题目')]}, two: {questions: [q('第二张题目')]}});
  const batch = await app.settle((await app.upload(['one', 'two'])).id), seed = new DatabaseSync(app.databasePath);
  seed.prepare('UPDATE intake_batches SET sealed=0 WHERE id=?').run(batch.id);
  seed.prepare("UPDATE intake_photos SET state='saving',extraction=NULL WHERE id=?").run(batch.photos[0].id);
  seed.prepare('DELETE FROM intake_batch_photos WHERE batchId=? AND photoId=?').run(batch.id, batch.photos[1].id); seed.close();
  await app.reopen();
  const interrupted = (await app.request('/api/intake/batches/' + batch.id)).data;
  assert.deepEqual(interrupted.expectedPhotos.map(p => p.name), ['one.png', 'two.png']);
  const resumed = await app.settle((await app.upload(['one', 'two'])).id);
  assert.equal(resumed.id, batch.id); assert.equal(resumed.state, 'completed'); assert.equal(resumed.photos.length, 2); assert.equal(app.calls(), 3);
});

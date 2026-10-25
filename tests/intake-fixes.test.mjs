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
      headers: {...(body instanceof FormData ? {} : {'Content-Type': 'application/json'}), 'X-Mido-Client': 'desktop'}, ...(body ? {body: body instanceof FormData ? body : JSON.stringify(body)} : {})});
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
  return {origin: () => 'http://127.0.0.1:' + app.server.address().port, request, upload, settle, responses, prompts, dataDir, databasePath: path, calls: () => calls, reopen: async () => { await app.close(); db.close(); await open(); }};
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


test('a fresh request used to recover an interrupted upload remains idempotent after completion and restart', async t => {
  const app = await setup(t), first = await app.settle((await app.upload(['alias'])).id), requestId = crypto.randomUUID();
  const seed = new DatabaseSync(app.databasePath); seed.prepare('UPDATE intake_batches SET sealed=0 WHERE id=?').run(first.id); seed.close();
  assert.equal((await app.upload(['alias'], requestId)).id, first.id);
  assert.equal((await app.upload(['alias'], requestId)).id, first.id);
  await app.reopen(); assert.equal((await app.upload(['alias'], requestId)).id, first.id);
  assert.equal((await app.request('/api/intake/batches')).data.length, 1);
  const conflict = await app.request('/api/intake/batches', 'POST', {requestId, files: [{name: 'different.png', base64: png('different').toString('base64')}]});
  assert.equal(conflict.status, 409); assert.equal(app.calls(), 1);
});


test('a transient projection reservation lock retries persistence without failing the photo or replaying recognition', async t => {
  let reservations = 0, injected = 0;
  const factory = async options => {
    const execute = options.db.exec.bind(options.db);
    options.db.exec = statement => {
      if (statement === 'BEGIN IMMEDIATE' && reservations && --reservations === 0) { injected++; throw Object.assign(new Error('database is locked'), {errcode: 5}); }
      return execute(statement);
    };
    return createIntakeServer(options);
  };
  const app = await setup(t, {busy: () => { reservations = 2; return {questions: [q('短暂锁后保存')]}; }}, factory);
  const batch = await app.settle((await app.upload(['busy'])).id);
  assert.equal(injected, 1); assert.equal(batch.state, 'completed'); assert.equal(batch.photos[0].state, 'completed');
  assert.equal(batch.questions.length, 1); assert.equal(app.calls(), 1);
});


test('legacy synchronization uses accepted truncated fields and ignores an invalid cause status consistently', async t => {
  const app = await setup(t, {legacy: {questions: [q('兼容旧题', {studentAnswer: '2', answerStatus: 'answered'})]}}, createNotebook);
  const task = (await app.request('/api/import', 'POST', {name: 'legacy.png', base64: png('legacy').toString('base64')})).data;
  for (let i = 0; i < 100 && (await app.request('/api/jobs/' + task.id)).data.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
  const old = (await app.request('/api/questions?importId=' + task.id)).data[0];
  await app.request('/api/questions/' + old.id, 'PATCH', {state: 'library', causeStatus: 'confirmed'});
  const result = await app.request('/api/questions/' + old.id, 'PATCH', {studentAnswer: '长'.repeat(30001), possibleCause: '因'.repeat(30001), causeStatus: 'unsupported'});
  assert.equal(result.status, 200);
  const legacy = (await app.request('/api/questions?importId=' + task.id)).data[0];
  const intake = (await app.request('/api/intake/questions/' + old.id)).data;
  assert.equal(intake.attempts[0].studentAnswer, legacy.content.studentAnswer); assert.equal(intake.attempts[0].studentAnswer.length, 30000);
  assert.equal(intake.attempts[0].possibleCause, legacy.content.possibleCause); assert.equal(intake.attempts[0].causeStatus, 'confirmed');
});


test('completed request resubmission repairs deleted source bytes and preserves inference', async t => {
  const app = await setup(t), requestId = crypto.randomUUID(), batch = await app.settle((await app.upload(['restore'], requestId)).id);
  const seed = new DatabaseSync(app.databasePath); const file = seed.prepare('SELECT file FROM intake_photos WHERE id=?').get(batch.photos[0].id).file; seed.close();
  await unlink(join(app.dataDir, 'images', file));
  assert.equal((await app.upload(['restore'], requestId)).id, batch.id);
  assert.deepEqual(await readFile(join(app.dataDir, 'images', file)), png('restore')); assert.equal(app.calls(), 1);
});

test('blank answer-sheet regions do not create attempts or warnings while visible drawings are retained', async t => {
  const responses = {sheet: {paper, questions: [], answers: [{...answer, studentAnswer: '', answerPresence: 'absent'}, {...answer, number: '2', studentAnswer: '', answerStatus: 'unclear', answerPresence: 'unknown'}, {...answer, number: '3', studentAnswer: '', answerStatus: 'unclear', answerPresence: 'present', answerEvidence: '孩子画了三角形'}]}, questions: {paper, questions: [q('甲', {number: '1'}), q('乙', {number: '2'}), q('丙', {number: '3'})]}};
  const app = await setup(t, responses), batch = await app.settle((await app.upload(['questions', 'sheet'])).id);
  assert.equal(batch.fragments.length, 1); assert.equal(batch.fragments[0].number, '3'); assert.equal(batch.fragments[0].state, 'linked'); assert.equal(batch.warnings.length, 0);
  assert.equal(batch.questions.find(q => q.content.number === '1').attempts.length, 0);
  assert.equal(batch.questions.find(q => q.content.number === '3').attempts.length, 1);
});

test('split moves the linked answer fragment with its original attempt and remains idempotently linkable', async t => {
  const app = await setup(t, {whole: {paper, questions: [q('拆分父题')]}, sheet: {paper, questions: [], answers: [answer]}});
  const batch = await app.settle((await app.upload(['whole', 'sheet'])).id), original = batch.questions[0], attempt = original.attempts[0];
  const children = (await app.request('/api/intake/questions/' + original.id + '/split', 'POST', {requestId: crypto.randomUUID(), parts: [{content: {question: '甲'}, attemptIds: [attempt.id]}, {content: {question: '乙'}}]})).data;
  const next = (await app.request('/api/intake/batches/' + batch.id)).data;
  assert.equal(next.fragments[0].questionId, children[0].id);
  const link = await app.request('/api/intake/fragments/' + next.fragments[0].id + '/link', 'POST', {questionId: children[0].id});
  assert.equal(link.status, 200); assert.equal(link.data.id, attempt.id);
});


test('legacy edits update removed records safely and rollback both catalogs when synchronization fails', async t => {
  const app = await setup(t, {legacy: {questions: [q('旧题无作答')]}}, createNotebook);
  const task = (await app.request('/api/import', 'POST', {name: 'legacy.png', base64: png('legacy').toString('base64')})).data;
  for (let i = 0; i < 100 && (await app.request('/api/jobs/' + task.id)).data.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
  const old = (await app.request('/api/questions?importId=' + task.id)).data[0];
  await app.reopen(); await app.request('/api/intake/questions/' + old.id, 'DELETE');
  assert.equal((await app.request('/api/questions/' + old.id, 'PATCH', {studentAnswer: '安全补原作答'})).status, 200);
  assert.equal((await app.request('/api/intake/questions/' + old.id)).data.removed, true);
  const seed = new DatabaseSync(app.databasePath); seed.exec("CREATE TRIGGER reject_legacy_sync BEFORE UPDATE ON intake_attempts BEGIN SELECT RAISE(ABORT,'injected sync failure'); END"); seed.close();
  assert.equal((await app.request('/api/questions/' + old.id, 'PATCH', {question: '不该部分提交', studentAnswer: '同步失败'})).status, 500);
  assert.equal((await app.request('/api/questions?importId=' + task.id)).data[0].content.question, '旧题无作答');
  const current = (await app.request('/api/intake/questions/' + old.id)).data;
  assert.equal(current.content.question, '旧题无作答'); assert.equal(current.attempts[0].studentAnswer, '安全补原作答');
});

test('legacy creation history preserves recorded status without inventing ever-wrong evidence', async t => {
  const app = await setup(t, {legacy: {questions: [q('旧状态题', {studentAnswer: '3', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '红叉'}})]}}, createNotebook);
  const task = (await app.request('/api/import', 'POST', {name: 'legacy.png', base64: png('legacy').toString('base64')})).data;
  for (let i = 0; i < 100 && (await app.request('/api/jobs/' + task.id)).data.state !== 'completed'; i++) await new Promise(r => setTimeout(r, 5));
  const old = (await app.request('/api/questions?importId=' + task.id)).data[0], seed = new DatabaseSync(app.databasePath);
  seed.prepare('UPDATE questions SET content=? WHERE id=?').run(JSON.stringify({...old.content, questionStatus: 'correct'}), old.id); seed.close();
  await app.reopen(); const current = (await app.request('/api/intake/questions/' + old.id)).data;
  assert.equal(current.latestStatus, 'correct'); assert.equal(current.everWrong, false); assert.equal(current.attempts[0].history[0].after.status, 'correct');
});


test('multipart intake accepts thirty file-backed photos beyond the JSON aggregate cap and cleans staging files', async t => {
  const app = await setup(t), form = new FormData(); form.append('requestId', crypto.randomUUID());
  const bytes = Buffer.concat([png('streamed'), Buffer.alloc(900000)]);
  for (let i = 0; i < 30; i++) form.append('photos', new Blob([bytes], {type: 'image/png'}), 'page-' + i + '.png');
  const response = await app.request('/api/intake/batches', 'POST', form);
  assert.equal(response.status, 202, JSON.stringify(response.data)); const batch = await app.settle(response.data.id);
  assert.equal(batch.expectedPhotos.length, 30); assert.equal(batch.questions.length, 1); assert.equal(app.calls(), 1);
  const {readdir} = await import('node:fs/promises'); assert.equal((await readdir(app.dataDir)).some(name => name.startsWith('upload-')), false);
});


test('multipart limits reject oversized or excessive files, clean staging, and ordinary edits have a small body bound', async t => {
  const app = await setup(t), form = new FormData(); form.append('requestId', crypto.randomUUID());
  form.append('photos', new Blob([png('too-large'), Buffer.alloc(15 * 1024 * 1024)], {type: 'image/png'}), 'large.png');
  assert.equal((await app.request('/api/intake/batches', 'POST', form)).status, 413);
  const many = new FormData(); many.append('requestId', crypto.randomUUID());
  for (let i = 0; i < 31; i++) many.append('photos', new Blob([png('tiny')]), i + '.png');
  assert.equal((await app.request('/api/intake/batches', 'POST', many)).status, 413);
  assert.equal((await app.request('/api/intake/questions', 'POST', {requestId: crypto.randomUUID(), content: {question: 'x'.repeat(1024 * 1024)}})).status, 413);
  const {readdir} = await import('node:fs/promises'); assert.equal((await readdir(app.dataDir)).some(name => name.startsWith('upload-')), false); assert.equal(app.calls(), 0);
});

test('multipart original-save errors release admission and a later valid upload still succeeds', async t => {
  const app = await setup(t), form = new FormData(); form.append('requestId', crypto.randomUUID()); form.append('photos', new Blob([png('staging')]), 'source.png');
  const directory = join(app.dataDir, 'images'); await rename(directory, join(app.dataDir, 'saved-images')); await writeFile(directory, 'not-a-directory');
  assert.equal((await app.request('/api/intake/batches', 'POST', form)).status, 202);
  await unlink(directory); await rename(join(app.dataDir, 'saved-images'), directory);
  const retry = new FormData(); retry.append('requestId', crypto.randomUUID()); retry.append('photos', new Blob([png('staging')]), 'source.png');
  const batch = await app.settle((await app.request('/api/intake/batches', 'POST', retry)).data.id);
  assert.equal(batch.state, 'completed'); assert.equal(app.calls(), 1);
});


test('malformed multipart releases staged files and bounded admission queues concurrent uploads', async t => {
  const app = await setup(t), {readdir} = await import('node:fs/promises');
  const malformed = await fetch(app.origin() + '/api/intake/batches', {method: 'POST', headers: {'X-Mido-Client': 'desktop', 'Content-Type': 'multipart/form-data; boundary=broken'}, body: '--broken\r\nContent-Disposition: form-data; name="photos"; filename="bad.png"\r\n\r\nunclosed'});
  assert.equal(malformed.status, 400); assert.equal((await readdir(app.dataDir)).some(name => name.startsWith('upload-')), false);
  const http = await import('node:http'); let first;
  const response = new Promise((resolve, reject) => {
    first = http.request(app.origin() + '/api/intake/batches', {method: 'POST', headers: {'X-Mido-Client': 'desktop', 'Content-Type': 'multipart/form-data; boundary=hold'}}, res => { const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(Buffer.concat(chunks))})); });
    first.on('error', reject);
  });
  t.after(() => first.destroy());
  first.write('--hold\r\nContent-Disposition: form-data; name="requestId"\r\n\r\nheld\r\n--hold\r\nContent-Disposition: form-data; name="photos"; filename="held.png"\r\nContent-Type: image/png\r\n\r\n'); first.write(png('held'));
  for (let i = 0; i < 100 && !(await readdir(app.dataDir)).some(name => name.startsWith('upload-')); i++) await new Promise(r => setTimeout(r, 5));
  const pending = ['queued-a', 'queued-b', 'overflow'].map(label => app.request('/api/intake/batches', 'POST', {requestId: label, files: [{name: label + '.png', base64: png(label).toString('base64')}]}));
  assert.equal((await Promise.race(pending)).status, 429);
  first.end('\r\n--hold--\r\n'); assert.equal((await response).status, 202);
  assert.deepEqual((await Promise.all(pending)).map(r => r.status).sort(), [202, 202, 429]);
  assert.equal((await readdir(app.dataDir)).some(name => name.startsWith('upload-')), false);
});


test('multipart retains the full fifteen MiB per-photo allowance', async t => {
  const app = await setup(t), bytes = Buffer.alloc(15 * 1024 * 1024); png('maximum').copy(bytes);
  const form = new FormData(); form.append('requestId', crypto.randomUUID()); form.append('photos', new Blob([bytes], {type: 'image/png'}), 'maximum.png');
  const response = await app.request('/api/intake/batches', 'POST', form); assert.equal(response.status, 202);
  assert.equal((await app.settle(response.data.id)).state, 'completed'); assert.equal(app.calls(), 1);
});


test('uncertain client commands retain original visible content and target across navigation before reconciling once', async t => {
  const {PendingCommands} = await import('../app/intake-command-client.js');
  const app = await setup(t), pending = new PendingCommands();
  const create = async question => (await app.request('/api/intake/questions', 'POST', {requestId: crypto.randomUUID(), content: {question}})).data;
  const a = await create('题目A'), b = await create('题目B');
  const original = pending.start({kind: 'new-attempt', targetId: a.id, path: '/api/intake/questions/' + a.id + '/attempts', payload: {studentAnswer: '原提交A'}, snapshot: {questionId: a.id, values: [{name: 'studentAnswer', value: '原提交A'}]}});
  await assert.rejects(pending.reconcile(original.key, async (path, payload) => { await app.request(path, 'POST', payload); throw new Error('response lost after commit'); }), /response lost/);
  const other = pending.start({kind: 'new-attempt', targetId: b.id, path: '/api/intake/questions/' + b.id + '/attempts', payload: {studentAnswer: 'B的新操作'}, snapshot: {questionId: b.id, values: [{name: 'studentAnswer', value: 'B的新操作'}]}});
  const restored = pending.start({kind: 'new-attempt', targetId: a.id, path: '/wrong-target', payload: {studentAnswer: '返回后的空白或新输入'}, snapshot: {values: []}});
  assert.equal(restored.key, original.key); assert.notEqual(restored.key, other.key);
  assert.equal(restored.path, original.path); assert.deepEqual(restored.snapshot, original.snapshot); assert.equal(restored.payload.studentAnswer, '原提交A');
  let sends = 0; const send = (path, payload) => { sends++; return app.request(path, 'POST', payload); };
  const [first, joined] = await Promise.all([pending.reconcile(restored.key, send), pending.reconcile(restored.key, send)]);
  assert.equal(first.status, 200); assert.equal(joined.status, 200); assert.equal(sends, 1);
  assert.equal((await app.request('/api/intake/questions/' + a.id)).data.attempts.length, 1);
  assert.equal((await app.request('/api/intake/questions/' + b.id)).data.attempts.length, 0);
  assert.equal(pending.has(original.key), false); assert.equal(pending.has(other.key), true);
});

test('pending global add and archived-parent split can be recovered by saved path without creating duplicates', async t => {
  const {PendingCommands} = await import('../app/intake-command-client.js');
  const app = await setup(t, {}, createNotebook), pending = new PendingCommands();
  const moduleResponse = await fetch(app.origin() + '/intake-command-client.js'); assert.equal(moduleResponse.status, 200); assert.match(moduleResponse.headers.get('content-type'), /javascript/); await moduleResponse.text();
  const add = pending.start({kind: 'add', path: '/api/intake/questions', payload: {content: {question: '上次补录原题'}}, snapshot: {questionId: null, values: [{name: 'question', value: '上次补录原题'}]}});
  const created = (await app.request(add.path, 'POST', add.payload)).data;
  const reopened = pending.start({kind: 'add', path: '/api/intake/questions', payload: {content: {question: '不能悄悄替换上次补录'}}, snapshot: {values: []}});
  assert.equal((await app.request(reopened.path, 'POST', reopened.payload)).data.id, created.id);
  pending.acknowledge(add.key);
  const split = pending.start({kind: 'split', targetId: created.id, path: '/api/intake/questions/' + created.id + '/split', payload: {parts: [{content: {question: '第一问'}}, {content: {question: '第二问'}}]}, snapshot: {questionId: created.id, values: [{name: 'parts', value: '第一问\n---\n第二问'}]}});
  const children = (await app.request(split.path, 'POST', split.payload)).data;
  assert.equal((await app.request('/api/intake/questions/' + created.id)).data.removed, true);
  const recovered = await app.request(split.path, 'POST', pending.get(split.key).payload);
  assert.deepEqual(recovered.data.map(q => q.id), children.map(q => q.id)); assert.equal((await app.request('/api/intake/questions')).data.length, 2);
});

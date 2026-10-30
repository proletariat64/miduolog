import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {testDirectory, png, deferred} from './helpers.mjs';
import {createIntakeServer} from '../app/intake-http.mjs';
import {createNotebook} from '../app/http-app.mjs';
import {questionPage, answerPage} from './intake-extraction-fixtures.mjs';
import sharp from 'sharp';

const q = (question = '计算 1+1', extra = {}) => ({number: '1', subject: '数学', question, studentAnswer: '', knowledgePoint: '加法', observedError: '', possibleCause: '', needsConfirmation: false, completeness: 'complete', answerStatus: 'unanswered', ...extra});
async function setup(t, responses = {}, factory = createIntakeServer) {
  let app, db, calls = 0;
  t.after(async () => { await app?.close(); db?.close(); });
  const dataDir = await testDirectory(t), path = join(dataDir, 'intake.sqlite');
  const client = {recognize: async file => {
    calls++;
    const label = (await readFile(file)).subarray(8).toString();
    const value = responses[label] || responses['*'] || {questions: [q()], answers: [], unclear: []};
    if (value instanceof Error) throw value;
    return {data: typeof value === 'function' ? await value() : value};
  }, runJson: async () => ({data: {verdict: 'correct', recognizedAnswer: '2', reason: '测试', referenceAnswer: '2', explanation: '测试', nextStep: '', uncertainties: []}}), close() {}};
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
  return {request, upload, settle, responses, databasePath: path, url: route => 'http://127.0.0.1:' + app.server.address().port + route, calls: () => calls, reopen: async () => { await app.close(); db.close(); await open(); }};
}

test('photo previews bound transfer dimensions while original evidence remains unchanged', async t => {
  const app = await setup(t);
  const bytes = await sharp({create: {width: 1800, height: 2400, channels: 3, background: 'white'}}).jpeg().toBuffer();
  const batch = await app.settle((await app.request('/api/intake/batches', 'POST', {requestId: crypto.randomUUID(), files: [{name: 'page.jpg', base64: bytes.toString('base64')}]})).data.id);
  const route = batch.photos[0].imageUrl;
  const response = await fetch(app.url(route + '?preview=1'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.match(response.headers.get('cache-control'), /private/);
  const preview = Buffer.from(await response.arrayBuffer()), metadata = await sharp(preview).metadata();
  assert.ok(metadata.width <= 640 && metadata.height <= 640);
  assert.ok(preview.length < bytes.length);
  const original = await fetch(app.url(route));
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  assert.equal(app.calls(), 1);
  assert.equal((await fetch(app.url('/api/intake/photos/missing/image?preview=1'))).status, 404);
});

test('standalone intake saves every visible question and original evidence without requiring review', async t => {
  const app = await setup(t, {whole: {questions: [q(), q('计算 2+2', {number: '2', studentAnswer: '5', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '第二题红叉'}}), q('残缺题', {number: '3', completeness: 'partial'})], unclear: []}});
  const batch = await app.settle((await app.upload(['whole'])).id);
  assert.equal(batch.state, 'completed'); assert.equal(batch.questions.length, 3);
  const list = (await app.request('/api/intake/questions')).data;
  assert.deepEqual(list.map(x => x.latestStatus).sort(), ['incorrect', 'no_answer', 'no_answer']);
  assert.equal(list.find(x => x.latestStatus === 'incorrect').attempts[0].teacherReview.evidence, '第二题红叉');
  assert.equal(list[0].sources[0].imageUrl.startsWith('/api/intake/photos/'), true);
  const photo = (await app.request('/api/intake/photos/' + batch.photos[0].id)).data;
  assert.equal(photo.extraction.questions.length, 3);
  await app.reopen(); assert.equal((await app.request('/api/intake/questions')).data.length, 3); assert.equal(app.calls(), 1);
});

test('notebook uses the intake API and exposes verified wrong attempts to review without direct intake SQL', async t => {
  const app = await setup(t, {wrong: {questions: [q('计算1+1', {studentAnswer: '3', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '红叉'}})]}}, createNotebook);
  const batch = await app.settle((await app.upload(['wrong'])).id), question = batch.questions[0];
  assert.equal((await app.request('/api/review/recommendations')).data.length, 0);
  assert.equal((await app.request('/api/intake/questions/' + question.id, 'PATCH', {verified: true})).status, 200);
  const recommended = (await app.request('/api/review/recommendations')).data;
  assert.equal(recommended.length, 1); assert.equal(recommended[0].id, question.id);
  const session = (await app.request('/api/review/sessions', 'POST', {questionIds: [question.id]})).data;
  assert.equal(session.items.length, 1); assert.equal('studentAnswer' in session.items[0].question, false);
});

test('a mixed batch links only its own uniquely identified answers, including a previously isolated repeated sheet', async t => {
  const answer = {number: '1', studentAnswer: '3', answerStatus: 'answered', matchKey: '数学练习甲', teacherReview: {mark: 'incorrect', evidence: '红叉'}};
  const app = await setup(t, {sheet: {questions: [], answers: [answer]}, paper: {questions: [q('计算1+1', {matchKey: '数学练习甲'})]}});
  const isolated = await app.settle((await app.upload(['sheet'])).id);
  assert.equal(isolated.questions.length, 0); assert.equal(isolated.warnings.length, 1);
  const joined = await app.settle((await app.upload(['sheet', 'paper'])).id);
  assert.equal(joined.questions.length, 1); assert.equal(joined.warnings.length, 0);
  assert.equal(joined.questions[0].attempts[0].studentAnswer, '3'); assert.equal(joined.questions[0].sources.length, 2);
  assert.equal(app.calls(), 2);
  const old = (await app.request('/api/intake/batches/' + isolated.id)).data;
  assert.equal(old.questions.length, 0); assert.equal(old.fragments[0].state, 'unlinked');
  const later = await app.settle((await app.upload(['sheet'])).id);
  assert.equal(later.questions.length, 0); assert.equal(later.fragments[0].state, 'unlinked');
});

test('ambiguous answers remain pending, accept manual mapping only inside the batch, and do not fabricate attempts', async t => {
  const app = await setup(t, {a: {questions: [q('甲题', {matchKey: '试卷'})]}, b: {questions: [q('乙题', {matchKey: '试卷'})]}, answer: {questions: [], answers: [{number: '1', matchKey: '试卷', studentAnswer: '2'}]}, outside: {questions: [q('外部题')]}});
  const outside = await app.settle((await app.upload(['outside'])).id);
  const batch = await app.settle((await app.upload(['a','b','answer'])).id), fragment = batch.fragments[0];
  assert.equal(fragment.state, 'unlinked'); assert.equal(batch.questions.every(q => q.attempts.length === 0), true);
  assert.equal((await app.request('/api/intake/fragments/' + fragment.id + '/link', 'POST', {questionId: outside.questions[0].id})).status, 400);
  const target = batch.questions[0].id, first = await app.request('/api/intake/fragments/' + fragment.id + '/link', 'POST', {questionId: target});
  assert.equal(first.status, 200);
  assert.equal((await app.request('/api/intake/fragments/' + fragment.id + '/link', 'POST', {questionId: target})).data.id, first.data.id);
  assert.equal((await app.request('/api/intake/questions/' + target)).data.attempts.length, 1);
});

test('shared materials can be corrected without overwriting recognition evidence, and attempt edits reject stale revisions', async t => {
  const app = await setup(t, {material: {materials: [{key: 'passage', text: '原阅读材料', description: ''}], questions: [q('问一', {materialKeys: ['passage'], studentAnswer: '错答', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '叉'}}), q('问二', {number: '2', materialKeys: ['passage']})]}});
  const batch = await app.settle((await app.upload(['material'])).id), first = batch.questions.find(q => q.attempts.length);
  const material = first.materials[0];
  assert.equal(batch.questions.every(q => q.materials[0].id === material.id), true);
  assert.equal((await app.request('/api/intake/materials/' + material.id, 'PATCH', {text: '核对后的阅读材料'})).data.text, '核对后的阅读材料');
  const attempt = first.attempts[0];
  const changed = await app.request('/api/intake/attempts/' + attempt.id, 'PATCH', {expectedRevision: 1, studentAnswer: '正确的原答案', status: 'correct'});
  assert.equal(changed.data.statusSource, 'manual');
  assert.equal((await app.request('/api/intake/attempts/' + attempt.id, 'PATCH', {expectedRevision: 1, status: 'incorrect'})).status, 409);
  await app.reopen();
  const restored = (await app.request('/api/intake/questions/' + first.id)).data;
  assert.equal(restored.latestStatus, 'correct'); assert.equal(restored.everWrong, true);
  assert.equal(restored.materials[0].text, '核对后的阅读材料');
  const extraction = (await app.request('/api/intake/photos/' + batch.photos[0].id)).data.extraction;
  assert.equal(extraction.materials[0].text, '原阅读材料'); assert.equal(extraction.questions[0].studentAnswer, '错答');
});

test('duplicate question decisions preserve separate attempts, manual priority and repeat-decision idempotency', async t => {
  const raw = q('计算 1+1', {studentAnswer: '3', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '红叉'}});
  const app = await setup(t, {old: {questions: [raw]}, again: {questions: [{...raw, studentAnswer: '2', teacherReview: {mark: 'correct', evidence: '勾'}}]}});
  const first = await app.settle((await app.upload(['old'])).id), original = first.questions[0];
  await app.request('/api/intake/questions/' + original.id, 'PATCH', {content: {question: '计算 1+1', tags: ['人工标签']}});
  const second = await app.settle((await app.upload(['again'])).id), decision = second.decisions[0];
  assert.equal(second.state, 'attention'); assert.equal(second.questions.length, 0);
  const payload = {action: 'link', questionId: original.id};
  assert.equal((await app.request('/api/intake/decisions/' + decision.id, 'POST', payload)).status, 200);
  assert.equal((await app.request('/api/intake/decisions/' + decision.id, 'POST', payload)).status, 200);
  assert.equal((await app.request('/api/intake/decisions/' + decision.id, 'POST', {action: 'new'})).status, 409);
  const updated = (await app.request('/api/intake/questions/' + original.id)).data;
  assert.equal(updated.attempts.length, 2); assert.deepEqual(updated.content.tags, ['人工标签']);
  assert.equal(updated.latestStatus, 'pending'); assert.equal(updated.everWrong, true);
  const photoAgain = await app.settle((await app.upload(['again'])).id);
  assert.equal(photoAgain.decisions.length, 0); assert.equal((await app.request('/api/intake/questions/' + original.id)).data.attempts.length, 2);
});

test('photo similarity is decided before inference and choosing a duplicate reuses its records without a second question warning', async t => {
  const sharp = (await import('sharp')).default;
  const pixels = Buffer.alloc(320 * 440 * 3, 250);
  for (let y = 35; y < 400; y++) for (let x = 25; x < 290; x++) {
    const row = Math.floor((y - 35) / 29);
    if ((y - 35) % 29 < 3 && x < 100 + (row * 43) % 185) pixels.fill(30, (y * 320 + x) * 3, (y * 320 + x) * 3 + 3);
  }
  const original = await sharp(pixels, {raw: {width: 320, height: 440, channels: 3}}).png().toBuffer();
  const resized = await sharp(original).resize(480).webp({quality: 65}).toBuffer();
  const app = await setup(t);
  const send = async bytes => (await app.request('/api/intake/batches', 'POST', {requestId: crypto.randomUUID(), files: [{name: 'same.webp', base64: bytes.toString('base64')}]})).data;
  const first = await app.settle((await send(original)).id), second = await app.settle((await send(resized)).id);
  assert.equal(second.state, 'attention'); assert.equal(app.calls(), 1);
  const d = second.decisions.find(d => d.type === 'photo_similarity');
  await app.request('/api/intake/decisions/' + d.id, 'POST', {action: 'skip', photoId: first.photos[0].id});
  const result = (await app.request('/api/intake/batches/' + second.id)).data;
  assert.equal(result.state, 'completed'); assert.equal(result.decisions.filter(d => d.state === 'pending').length, 0);
  assert.equal(result.questions[0].id, first.questions[0].id); assert.equal(app.calls(), 1);
});

test('question-only records accept a later explicit original attempt without fabricating one at import', async t => {
  const app = await setup(t), batch = await app.settle((await app.upload(['blank'])).id), question = batch.questions[0];
  assert.equal(question.attempts.length, 0);
  const payload = {requestId: crypto.randomUUID(), studentAnswer: '2', status: 'correct', statusReason: '对照原图确认'};
  const result = await app.request('/api/intake/questions/' + question.id + '/attempts', 'POST', payload);
  assert.equal(result.status, 200); assert.equal(result.data.status, 'correct');
  assert.equal((await app.request('/api/intake/questions/' + question.id + '/attempts', 'POST', payload)).data.id, result.data.id);
  assert.equal((await app.request('/api/intake/questions/' + question.id)).data.attempts.length, 1);
});

test('split, merge and removal retain sources, shared materials, original attempts and old review snapshots', async t => {
  const app = await setup(t, {whole: {materials: [{key: 'shared', text: '共享题干'}], questions: [q('第一问和第二问', {materialKeys: ['shared'], studentAnswer: '原作答', answerStatus: 'answered'})]}}, createNotebook);
  const original = (await app.settle((await app.upload(['whole'])).id)).questions[0];
  await app.request('/api/intake/questions/' + original.id, 'PATCH', {verified: true});
  const session = (await app.request('/api/review/sessions', 'POST', {questionIds: [original.id]})).data;
  const splitPayload = {requestId: crypto.randomUUID(), parts: [{content: {question: '第一问'}, attemptIds: [original.attempts[0].id]}, {content: {question: '第二问'}}]};
  const parts = (await app.request('/api/intake/questions/' + original.id + '/split', 'POST', splitPayload)).data;
  assert.equal(parts.length, 2); assert.equal(parts[0].attempts[0].id, original.attempts[0].id);
  assert.equal(parts[1].materials[0].id, original.materials[0].id);
  assert.deepEqual((await app.request('/api/intake/questions/' + original.id + '/split', 'POST', splitPayload)).data.map(q => q.id), parts.map(q => q.id));
  const merged = (await app.request('/api/intake/questions/' + parts[0].id + '/merge', 'POST', {requestId: crypto.randomUUID(), questionIds: [parts[1].id]})).data;
  assert.equal(merged.attempts.length, 1); assert.equal(merged.sources.length, 1);
  await app.request('/api/intake/questions/' + merged.id, 'DELETE');
  assert.equal((await app.request('/api/intake/questions')).data.length, 0);
  assert.equal((await app.request('/api/intake/questions/' + merged.id)).data.removed, true);
  const historical = (await app.request('/api/review/sessions/' + session.id)).data;
  assert.equal(historical.items[0].question.question, session.items[0].question.question);
  assert.match(historical.items[0].question.question, /共享题干/);
});

test('a partial batch retries failed inference only, preserves successful results and rejects conflicting upload retries', async t => {
  const app = await setup(t, {bad: new Error('外部模型中断'), good: {questions: [q('保留此题')]}});
  const requestId = crypto.randomUUID(), files = ['bad','good'].map(label => ({name: 'same.png', base64: png(label).toString('base64')}));
  const task = (await app.request('/api/intake/batches', 'POST', {requestId, files})).data;
  const settled = await app.settle(task.id); assert.equal(settled.state, 'partial_failure'); assert.equal(settled.questions.length, 1);
  assert.equal((await app.request('/api/intake/batches', 'POST', {requestId, files})).data.id, task.id);
  assert.equal((await app.request('/api/intake/batches', 'POST', {requestId, files: files.slice(1)})).status, 409);
  const before = app.calls(); await app.reopen(); assert.equal(app.calls(), before);
  app.responses.bad = {questions: [q('重试成功题')]};
  await app.request('/api/intake/batches/' + task.id + '/retry', 'POST', {});
  const retried = await app.settle(task.id); assert.equal(retried.questions.length, 2); assert.equal(app.calls(), before + 1);
});

test('concurrent identical uploads share original extraction, and same-name same-size different photos both survive', async t => {
  const app = await setup(t, {aaa: {questions: [q('甲问题')]}, bbb: {questions: [q('乙问题')]}});
  const file = {name: 'same.png', base64: png('aaa').toString('base64')};
  const [a,b] = await Promise.all([app.request('/api/intake/batches', 'POST', {requestId: 'one', files: [file]}), app.request('/api/intake/batches', 'POST', {requestId: 'two', files: [file]})]);
  const first = await app.settle(a.data.id), second = await app.settle(b.data.id);
  assert.equal(first.photos[0].id, second.photos[0].id); assert.equal(app.calls(), 1);
  const otherTask = await app.request('/api/intake/batches', 'POST', {requestId: 'three', files: [{name: 'same.png', base64: png('bbb').toString('base64')}]});
  const other = await app.settle(otherTask.data.id);
  assert.notEqual(other.photos[0].id, first.photos[0].id); assert.equal(app.calls(), 2);
  assert.equal((await app.request('/api/intake/questions')).data.length, 2);
});

test('legacy imported originals and verified question IDs remain usable through intake after reopening', async t => {
  const app = await setup(t, {legacy: {questions: [q('旧题目', {studentAnswer: '2', answerStatus: 'answered'})]}}, createNotebook);
  const task = (await app.request('/api/import', 'POST', {name: 'legacy.png', base64: png('legacy').toString('base64')})).data;
  for (let i = 0; i < 100; i++) { const job = (await app.request('/api/jobs/' + task.id)).data; if (job.state === 'completed') break; await new Promise(r => setTimeout(r, 5)); }
  const old = (await app.request('/api/questions?importId=' + task.id)).data[0];
  await app.request('/api/questions/' + old.id, 'PATCH', {state: 'library'});
  await app.reopen(); const before = app.calls();
  const batch = await app.settle((await app.upload(['legacy'])).id);
  assert.equal(batch.questions[0].id, old.id); assert.equal(batch.questions[0].attempts.length, 1);
  assert.equal(app.calls(), before);
  assert.equal((await app.request('/api/review/recommendations')).data[0].id, old.id);
});

test('different shared reading passages prevent identical subquestion text from being treated as the same problem', async t => {
  const app = await setup(t, {
    passageA: {materials: [{key: 'text', text: '小明很高兴，因为找到了小狗。'}], questions: [q('请概括主人公的心情。', {subject: '语文', materialKeys: ['text']})]},
    passageB: {materials: [{key: 'text', text: '小明很难过，因为丢失了小狗。'}], questions: [q('请概括主人公的心情。', {subject: '语文', materialKeys: ['text']})]},
  });
  await app.settle((await app.upload(['passageA'])).id);
  const other = await app.settle((await app.upload(['passageB'])).id);
  assert.equal(other.decisions.length, 0); assert.equal(other.questions.length, 1);
});

test('a visible drawing answer is preserved as an image-backed attempt even when it cannot be transcribed as text', async t => {
  const app = await setup(t, {drawing: {questions: [q('在图中画出高。', {studentAnswer: '', answerStatus: 'answered', diagramDescription: '三角形图', sourceLocation: '页面下半部', bbox: {x: 0.1, y: 0.5, width: 0.8, height: 0.4}, teacherReview: {mark: 'incorrect', evidence: '所画线段旁红叉'}})]}});
  const question = (await app.settle((await app.upload(['drawing'])).id)).questions[0];
  assert.equal(question.attempts.length, 1); assert.equal(question.attempts[0].studentAnswer, '');
  assert.equal(question.attempts[0].status, 'incorrect'); assert.equal(question.attempts[0].sources[0].bbox.y, 0.5);
});

test('automatic marking is conservative and separates teacher evidence from independent AI judgement', async t => {
  const ai = {verdict: 'incorrect', reason: '1+1应为2，原作答3不等值'};
  const questions = [
    q('第1类计算 1+1', {number: '1', studentAnswer: '3', answerStatus: 'answered', observedError: '结果错误', aiAssessment: ai}),
    q('第2类计算 1+1', {number: '2', studentAnswer: '3', answerStatus: 'answered', teacherReview: {mark: 'correct', evidence: '红勾'}, aiAssessment: ai}),
    q('第3类计算 1+1', {number: '3', studentAnswer: '3', answerStatus: 'answered', completeness: 'partial', observedError: '结果错误', aiAssessment: ai}),
    q('第4类计算 1+1', {number: '4', studentAnswer: '2', answerStatus: 'answered', teacherReview: {mark: 'correct', evidence: '红勾'}, aiAssessment: {verdict: 'correct', reason: '正确'}}),
    q('第5类计算 1+1', {number: '5', studentAnswer: '2', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '红叉'}, aiAssessment: {verdict: 'correct', reason: '正确'}}),
  ];
  const app = await setup(t, {states: {questions}}), batch = await app.settle((await app.upload(['states'])).id);
  const states = Object.fromEntries(batch.questions.map(q => [q.content.number, q.latestStatus]));
  assert.deepEqual(states, {'1': 'incorrect', '2': 'pending', '3': 'pending', '4': 'pending', '5': 'pending'});
  const attempt = batch.questions.find(q => q.content.number === '2').attempts[0];
  assert.equal(attempt.teacherReview.mark, 'correct'); assert.equal(attempt.aiAssessment.verdict, 'incorrect'); assert.equal(attempt.causeStatus, 'pending');
});

test('confirming a re-encoded answer sheet as a duplicate adds provenance without another attempt', async t => {
  const sharp = (await import('sharp')).default, pixels = Buffer.alloc(320 * 440 * 3, 250);
  for (let y = 35; y < 400; y++) for (let x = 25; x < 290; x++) {
    const row = Math.floor((y - 35) / 29);
    if ((y - 35) % 29 < 3 && x < 100 + (row * 43) % 185) pixels.fill(30, (y * 320 + x) * 3, (y * 320 + x) * 3 + 3);
  }
  const original = await sharp(pixels, {raw: {width: 320, height: 440, channels: 3}}).png().toBuffer(), resized = await sharp(original).resize(480).webp({quality: 65}).toBuffer();
  const app = await setup(t, {'*': {questions: [], answers: [{number: '1', studentAnswer: '2', matchKey: '数学甲', answerStatus: 'answered'}]}, paper: {questions: [q('计算1+1', {matchKey: '数学甲'})]}});
  const send = async bytes => (await app.request('/api/intake/batches', 'POST', {requestId: crypto.randomUUID(), files: [{name: 'sheet.png', base64: bytes.toString('base64')}, {name: 'paper.png', base64: png('paper').toString('base64')}]})).data;
  const first = await app.settle((await send(original)).id), second = await app.settle((await send(resized)).id);
  const d = second.decisions.find(d => d.type === 'photo_similarity');
  await app.request('/api/intake/decisions/' + d.id, 'POST', {action: 'skip', photoId: first.photos[0].id});
  const question = (await app.request('/api/intake/questions/' + first.questions[0].id)).data;
  assert.equal(question.attempts.length, 1); assert.equal(question.attempts[0].sources.length, 2);
});

test('actual synthetic question-page extraction does not invent attempts from unclear absence of an answer sheet', async t => {
  const app = await setup(t, {questions: questionPage});
  const batch = await app.settle((await app.upload(['questions'])).id);
  assert.equal(batch.questions.length, 2);
  assert.equal(batch.questions.every(q => q.attempts.length === 0 && q.latestStatus === 'no_answer'), true);
});

test('actual synthetic question and answer extractions associate by visible document identity despite model key order', async t => {
  const app = await setup(t, {questions: questionPage, answers: answerPage});
  const batch = await app.settle((await app.upload(['answers','questions'])).id);
  assert.equal(batch.state, 'completed'); assert.equal(batch.warnings.length, 0);
  assert.equal(batch.questions.length, 2); assert.equal(batch.questions.every(q => q.attempts.length === 1), true);
  const wrong = batch.questions.find(q => q.content.number === '1');
  assert.equal(wrong.attempts[0].studentAnswer, '12'); assert.equal(wrong.latestStatus, 'incorrect');
  assert.equal(wrong.attempts[0].teacherReview.mark, 'incorrect');
  assert.equal(wrong.attempts[0].aiAssessment.verdict, 'uncertain');
});

test('visible unreadable handwriting is retained only with positive answer evidence, not an unclear flag alone', async t => {
  const app = await setup(t, {unclear: {questions: [q('辨认原作答1', {answerStatus: 'unclear', answerPresence: 'present', answerEvidence: '答案框内可见铅笔数字笔画但无法辨认', teacherReview: {mark: 'unmarked', evidence: '未见老师批改'}}), q('辨认原作答2', {number: '2', answerStatus: 'unclear', answerPresence: 'unknown', answerEvidence: '', teacherReview: {mark: 'unmarked', evidence: '未见老师批改'}})]}});
  const batch = await app.settle((await app.upload(['unclear'])).id);
  const visible = batch.questions.find(q => q.content.number === '1'), absent = batch.questions.find(q => q.content.number === '2');
  assert.equal(visible.attempts.length, 1); assert.equal(visible.latestStatus, 'pending');
  assert.equal(visible.attempts[0].answerEvidence, '答案框内可见铅笔数字笔画但无法辨认');
  assert.equal(absent.attempts.length, 0);
});

test('different visible document IDs cannot be overridden by equal titles, question numbers or similar model match keys', async t => {
  const otherAnswers = structuredClone(answerPage);
  otherAnswers.paper.documentId = 'MIDO-13579'; otherAnswers.pageMarker = '合成数学练习 B · 编号 MIDO-13579 · 答题纸';
  const app = await setup(t, {questions: questionPage, answers: otherAnswers});
  const batch = await app.settle((await app.upload(['questions','answers'])).id);
  assert.equal(batch.state, 'attention'); assert.equal(batch.questions.every(q => q.attempts.length === 0), true);
  assert.equal(batch.fragments.every(f => f.state === 'unlinked'), true);
});


test('split keeps all child questions discoverable through the original upload batch after restart', async t => {
  const app = await setup(t, {whole: {questions: [q('第一问和第二问')]}});
  const batch = await app.settle((await app.upload(['whole'])).id), original = batch.questions[0];
  const parts = (await app.request('/api/intake/questions/' + original.id + '/split', 'POST', {
    requestId: crypto.randomUUID(), parts: [{content: {number: '1', question: '第一问'}}, {content: {number: '2', question: '第二问'}}],
  })).data;
  const expected = parts.map(part => part.id).sort();
  assert.deepEqual((await app.request('/api/intake/batches/' + batch.id)).data.questions.map(part => part.id).sort(), expected);
  await app.reopen();
  assert.deepEqual((await app.request('/api/intake/questions?batchId=' + batch.id)).data.map(part => part.id).sort(), expected);
  assert.equal((await app.request('/api/intake/questions/' + original.id)).data.removed, true);
});


test('new intake retains completed inference across a SQLite write lock without replaying it', async t => {
  const started = deferred(), inference = deferred();
  t.after(() => inference.resolve({questions: [q('模型已完成，等待保存')], answers: [], unclear: []}));
  const app = await setup(t, {locked: async () => { started.resolve(); return inference.promise; }});
  const batch = await app.upload(['locked']); await started.promise;
  const lock = new DatabaseSync(app.databasePath);
  try {
    lock.exec('BEGIN IMMEDIATE');
    inference.resolve({questions: [q('模型已完成，等待保存')], answers: [], unclear: []});
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal((await app.request('/api/intake/batches/' + batch.id)).data.state, 'processing');
    assert.equal(app.calls(), 1);
  } finally { if (lock.isTransaction) lock.exec('ROLLBACK'); lock.close(); }
  assert.equal((await app.settle(batch.id)).questions[0].content.question, '模型已完成，等待保存');
  await app.reopen();
  assert.equal((await app.request('/api/intake/batches/' + batch.id)).data.state, 'completed');
  assert.equal(app.calls(), 1);
});


test('answer sheets wait for all batch materials instead of warning while their question photo is still processing', async t => {
  const started = deferred(), inference = deferred();
  t.after(() => inference.resolve(questionPage));
  const app = await setup(t, {answers: answerPage, questions: async () => { started.resolve(); return inference.promise; }});
  const task = await app.upload(['answers', 'questions']); await started.promise;
  const processing = (await app.request('/api/intake/batches/' + task.id)).data;
  assert.equal(processing.state, 'processing'); assert.equal(processing.warnings.length, 0);
  inference.resolve(questionPage);
  const completed = await app.settle(task.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.warnings.length, 0);
  assert.equal(completed.questions.every(question => question.attempts.length === 1), true);
});


test('status and tag filters follow the latest attempt while edits to an older attempt keep prior error evidence', async t => {
  const app = await setup(t, {tagged: {questions: [q('计算 2+2', {studentAnswer: '5', answerStatus: 'answered', teacherReview: {mark: 'incorrect', evidence: '红叉'}})]}});
  const question = (await app.settle((await app.upload(['tagged'])).id)).questions[0];
  await app.request('/api/intake/questions/' + question.id, 'PATCH', {content: {tags: ['复习数学']}});
  await app.request('/api/intake/questions/' + question.id + '/attempts', 'POST', {requestId: crypto.randomUUID(), studentAnswer: '4', status: 'correct'});
  await app.request('/api/intake/attempts/' + question.attempts[0].id, 'PATCH', {status: 'partial', statusReason: '对照原图修正旧次作答'});
  await app.reopen();
  const filtered = (await app.request('/api/intake/questions?status=correct&tag=' + encodeURIComponent('复习数学'))).data;
  assert.deepEqual(filtered.map(item => item.id), [question.id]);
  assert.equal(filtered[0].everWrong, true); assert.equal(filtered[0].attempts.length, 2);
  assert.equal(filtered[0].attempts[0].status, 'partial'); assert.equal(filtered[0].attempts[1].status, 'correct');
  assert.deepEqual((await app.request('/api/intake/questions?status=partial')).data, []);
});

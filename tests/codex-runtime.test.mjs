import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexClient} from '../app/codex-client.mjs';
import {FakeCodexProcess, until} from './helpers.mjs';
const schema = {type: 'object', properties: {label: {type: 'string'}}};
const input = prompt => ({prompt, schema});

test('recognition and grading share readiness and isolate concurrent events', async t => {
  const child = new FakeCodexProcess(); let starts = 0;
  const client = new CodexClient({processFactory: () => { starts++; return child; }});
  t.after(() => client.close());
  const progress = [];
  const a = client.recognize('/synthetic.png', schema, {onProgress: chunk => progress.push(chunk)});
  const b = client.runJson(input('grade'));
  await until(() => child.turns.length === 2);
  assert.equal(starts, 1);
  const first = child.turns.find(r => r.params.input.some(i => i.type === 'localImage'));
  const second = child.turns.find(r => r !== first);
  child.output({method: 'item/agentMessage/delta', params: {threadId: second.params.threadId, delta: 'not-for-a'}});
  child.output({method: 'item/agentMessage/delta', params: {threadId: first.params.threadId, delta: 'only-a'}});
  child.complete(second, {label: 'b'}); child.complete(first, {label: 'a'});
  assert.equal((await a).data.label, 'a'); assert.equal((await b).data.label, 'b');
  assert.deepEqual(progress, ['only-a']);
  assert.equal(child.requests.filter(r => r.method === 'initialize').length, 1);
});

test('timeout before acknowledgement interrupts only its own turn', async t => {
  const child = new FakeCodexProcess({onTurn: (request, p) => {
    if (request.params.input[0].text === 'fast') { p.acknowledge(request); p.complete(request, {label: 'fast'}); }
  }});
  const client = new CodexClient({processFactory: () => child}); t.after(() => client.close());
  const slow = client.runJson({...input('slow'), timeoutMs: 30});
  const rejected = assert.rejects(slow, /超时/);
  assert.equal((await client.runJson(input('fast'))).data.label, 'fast');
  await rejected;
  const request = child.turns.find(r => r.params.input[0].text === 'slow');
  child.acknowledge(request);
  await until(() => child.requests.some(r => r.method === 'turn/interrupt'));
  const interrupts = child.requests.filter(r => r.method === 'turn/interrupt');
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].params.threadId, request.params.threadId);
  assert.equal(interrupts[0].params.turnId, 'turn-' + request.params.threadId);
});

test('cancellation does not cancel another caller and ignores late output', async t => {
  const child = new FakeCodexProcess(), abort = new AbortController();
  const client = new CodexClient({processFactory: () => child}); t.after(() => client.close());
  const a = client.runJson({...input('cancel'), signal: abort.signal});
  const rejected = assert.rejects(a, {name: 'AbortError'});
  const b = client.runJson(input('keep'));
  await until(() => child.turns.length === 2); abort.abort(); await rejected;
  child.complete(child.turns.find(r => r.params.input[0].text === 'cancel'), {label: 'late'});
  child.complete(child.turns.find(r => r.params.input[0].text === 'keep'), {label: 'kept'});
  assert.equal((await b).data.label, 'kept');
});

test('process exit rejects work; a later call reconnects without resubmitting old inference', async t => {
  const children = [];
  const client = new CodexClient({processFactory: () => { const p = new FakeCodexProcess(); children.push(p); return p; }});
  t.after(() => { client.close(); children.forEach(p => p.kill()); });
  const first = client.runJson(input('first')); const failed = assert.rejects(first, /退出/);
  await until(() => children[0]?.turns.length === 1); children[0].crash(); await failed;
  assert.equal(children.length, 1);
  const second = client.runJson(input('second'));
  await until(() => children[1]?.turns.length === 1); children[1].complete(children[1].turns[0], {label: 'recovered'});
  assert.equal((await second).data.label, 'recovered');
  assert.equal(children.reduce((n, p) => n + p.turns.length, 0), 2);
});

test('startup failure can recover and invalid JSON does not poison the next call', async t => {
  const children = [];
  const client = new CodexClient({processFactory: () => {
    const p = new FakeCodexProcess(children.length ? {} : {initializeError: 'startup-failed'}); children.push(p); return p;
  }});
  t.after(() => { client.close(); children.forEach(p => p.kill()); });
  await assert.rejects(client.runJson(input('not-started')), /startup-failed/);
  const invalid = client.runJson(input('invalid')); const failure = assert.rejects(invalid, /JSON/);
  await until(() => children[1]?.turns.length === 1); children[1].complete(children[1].turns[0], 'not-json'); await failure;
  const valid = client.runJson(input('valid'));
  await until(() => children[1].turns.length === 2); children[1].complete(children[1].turns[1], {label: 'valid'});
  assert.equal((await valid).data.label, 'valid');
});

test('close rejects in-flight work and prohibits reopening the disposed client', async () => {
  const child = new FakeCodexProcess(), client = new CodexClient({processFactory: () => child});
  const pending = client.runJson(input('pending')); const rejected = assert.rejects(pending, /关闭/);
  await until(() => child.turns.length === 1); client.close(); await rejected;
  await assert.rejects(client.runJson(input('later')), /关闭/);
});

test('an unacknowledged turn request timeout terminates the uncertain connection', async t => {
  const child = new FakeCodexProcess({onTurn: () => {}});
  const client = new CodexClient({processFactory: () => child, requestTimeoutMs: 30});
  t.after(() => client.close());
  await assert.rejects(client.runJson({...input('missing-ack'), timeoutMs: 1000}), /turn\/start.*超时/);
  assert.equal(child.killed, true, 'uncertain inference must not remain alive');
});

test('a stdin error disposes the old process without disturbing its replacement', async t => {
  const children = [];
  const client = new CodexClient({processFactory: () => { const child = new FakeCodexProcess(); children.push(child); return child; }});
  t.after(() => { client.close(); children.forEach(child => child.kill()); });
  await client.start();
  children[0].stdin.emit('error', new Error('broken pipe'));
  await client.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, false);
  assert.equal(client.child, children[1]);
});

test('cancellation during shared initialization settles without cancelling other callers', async t => {
  const child = new FakeCodexProcess();
  const reply = child.reply.bind(child); let initialization;
  child.reply = (request, result) => {
    if (request.method === 'initialize') initialization = {request, result};
    else reply(request, result);
  };
  const client = new CodexClient({processFactory: () => child}); t.after(() => client.close());
  const abort = new AbortController();
  const cancelled = client.runJson({...input('cancel'), signal: abort.signal});
  const failure = assert.rejects(cancelled, {name: 'AbortError'});
  const kept = client.runJson(input('keep'));
  await until(() => initialization); abort.abort();
  await Promise.race([failure, new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not settle promptly')), 100))]);
  reply(initialization.request, initialization.result);
  await until(() => child.turns.length === 1); child.complete(child.turns[0], {label: 'kept'});
  assert.equal((await kept).data.label, 'kept');
});

test('cancellation while thread creation is pending reports AbortError', async t => {
  const child = new FakeCodexProcess(), reply = child.reply.bind(child);
  child.reply = (request, result) => { if (request.method !== 'thread/start') reply(request, result); };
  const client = new CodexClient({processFactory: () => child, requestTimeoutMs: 50});
  t.after(() => client.close());
  const abort = new AbortController();
  const waiting = client.runJson({...input('cancel'), signal: abort.signal});
  const failure = assert.rejects(waiting, {name: 'AbortError'});
  await until(() => child.requests.some(r => r.method === 'thread/start')); abort.abort(); await failure;
  assert.equal(child.turns.length, 0);
});

for (const mode of ['rejected', 'unanswered']) test('failed interrupt disposes abandoned inference: ' + mode, async t => {
  const child = new FakeCodexProcess(), reply = child.reply.bind(child);
  child.reply = (request, result) => {
    if (request.method !== 'turn/interrupt') reply(request, result);
    else if (mode === 'rejected') child.output({id: request.id, error: {message: 'cannot interrupt'}});
  };
  const client = new CodexClient({processFactory: () => child, requestTimeoutMs: 40});
  t.after(() => client.close());
  await assert.rejects(client.runJson({...input('abandoned'), timeoutMs: 20}), /超时/);
  await until(() => child.killed);
  assert.equal(client.child, null);
});

test('a throwing progress callback fails only its own call and interrupts its turn', async t => {
  const child = new FakeCodexProcess(), client = new CodexClient({processFactory: () => child});
  t.after(() => client.close());
  const failure = client.runJson({...input('callback'), onProgress: () => { throw new Error('progress failed'); }});
  const rejected = assert.rejects(failure, /progress failed/);
  const kept = client.runJson(input('kept'));
  await until(() => child.turns.length === 2);
  const failedTurn = child.turns.find(turn => turn.params.input[0].text === 'callback');
  child.output({method: 'item/agentMessage/delta', params: {threadId: failedTurn.params.threadId, delta: 'progress'}});
  await rejected;
  child.complete(child.turns.find(turn => turn !== failedTurn), {label: 'kept'});
  assert.equal((await kept).data.label, 'kept');
  await until(() => child.requests.some(request => request.method === 'turn/interrupt'));
  assert.equal(child.killed, false);
});

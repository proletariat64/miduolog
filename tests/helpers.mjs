import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import assert from 'node:assert/strict';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
export async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Test condition not reached');
    await new Promise(resolve => setImmediate(resolve));
  }
}
export async function testDirectory(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'mido-architecture-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(basename(directory).startsWith('mido-architecture-test-'));
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}
export function png(label = 'test') {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]);
}
export function recognition(label = '合成题') {
  return {data: {questions: [{number: '1', subject: '数学', question: label,
    studentAnswer: '测试作答', knowledgePoint: '测试', observedError: '', possibleCause: '', needsConfirmation: false}], unclear: []}};
}
export function grading(verdict = 'correct') {
  return {data: {verdict, recognizedAnswer: '2', reason: '测试依据', referenceAnswer: '2',
    explanation: '测试讲解', nextStep: '继续练习', uncertainties: verdict === 'uncertain' ? ['信息不足'] : []}};
}

/** In-memory stdio adapter; exercises the real JSONL runtime, not a fake runJson. */
export class FakeCodexProcess extends EventEmitter {
  constructor({onTurn, initializeError} = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.turns = [];
    this.killed = false;
    this.threadCounter = 0;
    this.stdin = new Writable({write: (chunk, encoding, done) => {
      done();
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        this.requests.push(request);
        queueMicrotask(() => {
          if (request.method === 'initialize') {
            initializeError ? this.output({id: request.id, error: {message: initializeError}}) : this.reply(request, {userAgent: 'fake-codex'});
          } else if (request.method === 'thread/start') {
            this.reply(request, {thread: {id: 'thread-' + (++this.threadCounter)}, model: 'fake-model'});
          } else if (request.method === 'turn/start') {
            this.turns.push(request);
            if (onTurn) onTurn(request, this);
            else this.acknowledge(request);
          } else if (request.id !== undefined) this.reply(request, {});
        });
      }
    }});
  }
  output(message) { if (!this.stdout.destroyed) this.stdout.write(JSON.stringify(message) + '\n'); }
  reply(request, result) { this.output({id: request.id, result}); }
  acknowledge(request) { this.reply(request, {turn: {id: 'turn-' + request.params.threadId}}); }
  complete(request, value) {
    const threadId = request.params.threadId;
    this.output({method: 'item/completed', params: {threadId, item: {type: 'agentMessage', phase: 'final_answer', text: typeof value === 'string' ? value : JSON.stringify(value)}}});
    this.output({method: 'turn/completed', params: {threadId, turn: {status: 'completed'}}});
  }
  crash() { this.emit('exit', 1); }
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.stdout.end(); this.stderr.end(); this.stdin.destroy();
    queueMicrotask(() => this.emit('exit', 0));
  }
}

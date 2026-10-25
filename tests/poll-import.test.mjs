import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForImport} from '../scripts/poll-import.mjs';

test('recognition receives its own deadline after spending time in the queue', async () => {
  let time = 0;
  const statuses = [
    {time: 7 * 60000, state: 'processing', stage: 'queued'},
    {time: 7.5 * 60000, state: 'processing', stage: 'processing'},
    {time: 12 * 60000, state: 'processing', stage: 'processing'},
    {time: 13 * 60000, state: 'completed', stage: 'completed'},
  ];
  const result = await waitForImport(async () => { const next = statuses.shift(); time = next.time; return next; }, {now: () => time, pollMs: 0});
  assert.equal(result.state, 'completed'); assert.equal(statuses.length, 0);
});

test('queue timeout is unfinished rather than a failed recognition', async () => {
  let time = 0;
  await assert.rejects(waitForImport(async () => {
    time = 9 * 60000; return {state: 'processing', stage: 'queued'};
  }, {now: () => time, pollMs: 0}), error => error.unfinished === true && /排队/.test(error.message));
});

test('model failures remain failures and missing durable tasks are not retried', async () => {
  await assert.rejects(waitForImport(async () => ({state: 'failed', message: 'model failed'})), error => !error.unfinished && error.message === 'model failed');
  let calls = 0;
  await assert.rejects(waitForImport(async () => { calls++; const error = new Error('not found'); error.status = 404; throw error; }), /not found/);
  assert.equal(calls, 1);
});

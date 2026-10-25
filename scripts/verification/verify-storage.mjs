import assert from 'node:assert/strict';
import {localServiceUrl} from '../lib/worktree-environment.mjs';
const base = await localServiceUrl(process.cwd());
async function get(path) { const r = await fetch(base + path); assert.equal(r.ok, true); return r.json(); }
const fingerprint = imports => JSON.stringify(imports.map(({id, state, count}) => ({id, state, count})));
async function collect() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const imports = await get('/api/imports');
    if (imports.some(task => task.state === 'processing')) throw new Error('请等待导入队列完成后再验证存储');
    const [questions, sessions] = await Promise.all([get('/api/questions'), get('/api/review/sessions')]);
    const jobs = await Promise.all(imports.map(task => get('/api/jobs/' + task.id)));
    const savedSessions = await Promise.all(sessions.map(session => get('/api/review/sessions/' + session.id)));
    if (fingerprint(imports) === fingerprint(await get('/api/imports'))) return {imports, questions, sessions, jobs, savedSessions};
  }
  throw new Error('导入状态持续变化，请在队列空闲时重新验证；未判断为数据损坏');
}
const {questions, imports, sessions, jobs, savedSessions} = await collect();
assert.equal(new Set(questions.map(q => q.id)).size, questions.length);
const imported = new Set(imports.map(i => i.id));
for (const q of questions) { assert.ok(imported.has(q.importId)); assert.ok(['pending', 'library'].includes(q.state)); }
for (const task of jobs) assert.equal(task.count, questions.filter(q => q.importId === task.id).length);
for (let i = 0; i < sessions.length; i++) {
  assert.equal(savedSessions[i].items.length, sessions[i].total);
  assert.equal(savedSessions[i].isTest, sessions[i].isTest);
}
console.log(JSON.stringify({questions: questions.length, imports: imports.length, reviewSessions: sessions.length}));
console.log('PASS：通过应用 interface 验证导入状态、题目关联和复习记录；不直接读取数据库。');

import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:4318',folder='.scratch/mistake-notebook/real-paper/';
async function api(path,method='GET',input){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Mido-Client':'desktop'},...(input?{body:JSON.stringify(input)}:{})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
const source=JSON.parse(await readFile(folder+'latest-result.json','utf8'));
const original=await api('/api/questions');
const wanted=['1','4','12','15'].map(number=>{const q=original.find(q=>q.importId===source.importId&&q.content.number===number);assert.equal(q?.state,'library');return q;});
let session;try{const old=JSON.parse(await readFile(folder+'review-verification-progress.json','utf8'));session=await api('/api/review/sessions/'+old.id);}catch{session=await api('/api/review/sessions','POST',{questionIds:wanted.map(q=>q.id),isTest:true});await writeFile(folder+'review-verification-progress.json',JSON.stringify({id:session.id}),'utf8');}
assert.equal(session.isTest,true);console.log('真实 Codex 批阅验证；会话 '+session.id+'；所有作答标记为验证数据。');
async function settled(id){const deadline=Date.now()+220000;while(Date.now()<deadline){const item=await api('/api/review/items/'+id);if(!['grading','hinting'].includes(item.state))return item;await new Promise(r=>setTimeout(r,2000));}throw new Error('等待 Codex 批阅超时，已提交作答保留在本地');}
const answers={'1':'D','4':'B','12':'19.75米','15':'1/10'};
for(const initial of session.items){let item=await api('/api/review/items/'+initial.id);if(item.state==='graded'){console.log('第'+item.question.number+'题已有验证结果：'+item.result);continue;}
  assert.equal('grading' in item,false);assert.equal('originalAnswer' in item,false);assert.equal('studentAnswer' in item.question,false);
  if(item.question.number==='12'&&!item.hintUsed){console.log('第12题：请求真实提示……');await api('/api/review/items/'+item.id+'/hint','POST',{});item=await settled(item.id);if(!item.hintUsed)throw new Error('真实提示未成功：'+item.error);console.log('提示已返回并保存。');}
  console.log('第'+item.question.number+'题：提交验证答案，等待 Codex……');
  await api('/api/review/items/'+item.id+'/submit','POST',{answer:answers[item.question.number]});item=await settled(item.id);if(item.state!=='graded')throw new Error(item.error||'批阅失败');console.log('第'+item.question.number+'题：'+item.result+'；'+item.grading.reason);
}
session=await api('/api/review/sessions/'+session.id);assert.equal(session.state,'completed');
const expected={'1':'independent_correct','4':'incorrect','12':'hinted_correct','15':'independent_correct'};for(const item of session.items)assert.equal(item.result,expected[item.question.number]);
const after=await api('/api/questions');for(const before of wanted)assert.deepEqual(after.find(q=>q.id===before.id),before,'批阅不能自动改动原错因或题目');
const recommendations=await api('/api/review/recommendations');for(const q of recommendations.filter(q=>wanted.some(w=>w.id===q.id)))assert.equal(q.reason,'尚未复习，先检查是否已经学会','验证记录不得影响真实推荐');
await writeFile(folder+'review-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),session},null,2),'utf8');
console.log('PASS：四题实际 Codex 批阅、提示标记、本地记录、答案隐藏和验证数据隔离全部通过。');

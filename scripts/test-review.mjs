import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ReviewService,outcomeFor} from '../app/review-service.mjs';
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE imports(id TEXT,originalName TEXT); CREATE TABLE questions(id TEXT,state TEXT,importId TEXT,content TEXT);');
db.prepare('INSERT INTO imports VALUES (?,?)').run('paper','real-paper.jpg');
for(let i=1;i<=5;i++)db.prepare('INSERT INTO questions VALUES (?,?,?,?)').run('q'+i,i===5?'pending':'library','paper',JSON.stringify({number:String(i),subject:'数学',question:'测试题'+i,studentAnswer:'原答案不能提前泄露',observedError:'原分析不能提前泄露',knowledgePoint:'测试',possibleCause:'待确认',causeStatus:'pending'}));
let verdict='correct',calls=0;
const client={async runJson({schema}){calls++;if(schema.properties.hint)return {data:{hint:'先找出题目的条件。'}};return {data:{verdict,recognizedAnswer:'本次作答',reason:'测试依据',referenceAnswer:'参考答案',explanation:'测试讲解',nextStep:'继续练习',uncertainties:verdict==='uncertain'?['信息不足']:[]}};}};
const opts={db,client,connection:async()=>{},dataDir:'.scratch/review-unit',imageType:()=>null};
const service=new ReviewService(opts);
async function request(method,path,input={}){let result;await service.handle({method},{},path,{body:async()=>input,json:(_,status,data)=>{result={status,data};}});return result;}
assert.equal(outcomeFor('correct',false),'independent_correct');assert.equal(outcomeFor('correct',true),'hinted_correct');assert.equal(outcomeFor('incorrect',true),'incorrect');assert.equal(outcomeFor('uncertain',false),'pending');
assert.equal((await request('POST','/api/review/sessions',{questionIds:['q5']})).status,400);
const created=await request('POST','/api/review/sessions',{questionIds:['q1','q2','q3','q4'],isTest:true});assert.equal(created.status,201);const session=created.data;
for(const item of session.items){assert.equal('grading' in item,false);assert.equal('originalAnswer' in item,false);assert.equal('studentAnswer' in item.question,false);assert.equal('observedError' in item.question,false);}
for(let i=0;i<4;i++){
  const item=session.items[i];if(i===2){await request('POST','/api/review/items/'+item.id+'/hint');await new Promise(r=>setTimeout(r,5));assert.equal(service.itemDto(service.item(item.id)).hintUsed,true);}
  verdict=i===1?'incorrect':i===3?'uncertain':'correct';const submitted=await request('POST','/api/review/items/'+item.id+'/submit',{answer:'测试用作答'});assert.equal(submitted.status,202);await new Promise(r=>setTimeout(r,5));
  assert.equal(service.item(item.id).result,['independent_correct','incorrect','hinted_correct','pending'][i]);
  const before=calls;assert.equal((await request('POST','/api/review/items/'+item.id+'/submit',{answer:'重复提交'})).status,409);assert.equal(calls,before);
}
assert.equal(service.session(session.id).state,'completed');assert.equal(service.recommendations().every(q=>q.reason.startsWith('尚未复习')),true,'验证记录不能影响真实推荐');
await request('POST','/api/review/items/'+session.items[0].id+'/dispute',{message:'测试异议'});assert.equal(service.item(session.items[0].id).result,'pending');assert.equal(JSON.parse(service.item(session.items[0].id).grading).verdict,'correct');
const incomplete=(await request('POST','/api/review/sessions',{questionIds:['q1']})).data;db.prepare("UPDATE review_items SET state='grading',answer='已保存的作答' WHERE id=?").run(incomplete.items[0].id);new ReviewService(opts);assert.equal(service.item(incomplete.items[0].id).state,'failed');assert.equal(service.item(incomplete.items[0].id).answer,'已保存的作答');assert.equal(service.item(incomplete.items[0].id).result,null);
assert.equal(JSON.parse(db.prepare('SELECT content FROM questions WHERE id=?').get('q1').content).causeStatus,'pending');
db.close();console.log('PASS：答案隐藏、四类结果、提示记录、验证记录隔离、重复提交、批阅异议及中断恢复。');

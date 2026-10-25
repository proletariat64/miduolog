import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:4318';
const report=JSON.parse(await readFile('.scratch/mistake-notebook/real-paper/latest-result.json','utf8'));
const classifications={
  '1':{knowledgePoint:'数与运算 / 整除的含义与方向',possibleCause:'概念理解 / 整除方向混淆（待确认）：可能将“整除”与“被整除”的方向混淆，需结合女儿的解释确认。'},
  '4':{knowledgePoint:'数与运算 / 自然数、素数、互素与分数的小数形式',possibleCause:'概念理解 / 定义辨析与反例检验（待确认）：可能遗漏正确说法②，或对素数、互素的定义掌握不稳，需结合口述确认。'},
  '12':{knowledgePoint:'分数应用 / 单位“1”与具体数量',possibleCause:'题意理解 / 相对变化量与实际量混淆（待确认）：可能混淆“它的四分之一”与“四分之一米”，也可能存在计算失误；无解题过程，需确认。'},
  '15':{knowledgePoint:'图形与几何 / 三角形面积比与长方形整体面积',possibleCause:'解题方法 / 面积关系建立（待确认）：可能未识别三角形ABD占长方形面积的一半，或面积关系整理有误，需查看解题过程确认。'}
};
async function all(){const r=await fetch(base+'/api/questions');if(!r.ok)throw new Error('无法读取题目');return r.json();}
const before=await all();
const paper=before.filter(q=>q.importId===report.importId);
assert.equal(paper.length,15);
const selected=Object.keys(classifications).map(n=>{const matches=paper.filter(q=>q.content.number===n);assert.equal(matches.length,1);return matches[0];});
const seventh=paper.find(q=>q.content.number==='7');assert.equal(seventh.state,'pending');
await writeFile('.scratch/mistake-notebook/real-paper/before-selected-admission.json',JSON.stringify(paper,null,2),'utf8');
for(const q of selected){const r=await fetch(base+'/api/questions/'+q.id,{method:'PATCH',headers:{'Content-Type':'application/json','X-Mido-Client':'desktop'},body:JSON.stringify({state:'library',causeStatus:'pending',...classifications[q.content.number]})});const result=await r.json();if(!r.ok)throw new Error(result.error);}
const after=await all();
for(const q of paper){const current=after.find(item=>item.id===q.id);if(classifications[q.content.number]){assert.equal(current.state,'library');assert.equal(current.content.causeStatus,'pending');assert.equal(current.content.knowledgePoint,classifications[q.content.number].knowledgePoint);assert.equal(current.content.possibleCause,classifications[q.content.number].possibleCause);assert.equal(current.content.question,q.content.question);assert.equal(current.content.studentAnswer,q.content.studentAnswer);}else assert.deepEqual(current,q);}
const summary=after.filter(q=>q.importId===report.importId).map(q=>({number:q.content.number,state:q.state,causeStatus:q.content.causeStatus,knowledgePoint:q.content.knowledgePoint,possibleCause:q.content.possibleCause}));
await writeFile('.scratch/mistake-notebook/real-paper/admission-result.json',JSON.stringify({importId:report.importId,updatedAt:new Date().toISOString(),questions:summary},null,2),'utf8');
console.log(JSON.stringify(summary.filter(q=>['1','4','7','12','15'].includes(q.number)),null,2));
console.log('PASS：四题按知识点和可能错因分类入库，错因均待确认；第7题及其余题目保持原状态。');

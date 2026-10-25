import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
import {waitForImport} from '../lib/poll-import.mjs';
import {localServiceUrl} from '../lib/worktree-environment.mjs';

const folder=resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('请提供试卷目录');
const run=process.argv.includes('--run'),base=await localServiceUrl(resolve('.'));
async function api(path,options={}){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(30000),...options,headers:{'Content-Type':'application/json','X-Mido-Client':'desktop',...options.headers}});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error||'请求失败');error.status=response.status;throw error;}
  return data;
}
async function check(file){
  const bytes=await readFile(resolve(folder,file.name));
  return api('/api/import/check',{method:'POST',body:JSON.stringify({base64:bytes.toString('base64')})});
}
const files=(await readdir(folder,{withFileTypes:true})).filter(f=>f.isFile()&&['.png','.jpg','.jpeg','.webp'].includes(extname(f.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
const plan=[];
for(const file of files){const status=await check(file);plan.push({name:file.name,action:status.action,existingId:status.existing?.id||null});}
console.log(JSON.stringify({directory:folder,total:plan.length,skip:plan.filter(f=>f.action==='skip').length,process:plan.filter(f=>f.action!=='skip').length,files:plan},null,2));
if(!run)process.exit(0);
const reportFolder=resolve('.scratch/mistake-notebook/real-paper');await mkdir(reportFolder,{recursive:true});
const report={startedAt:new Date().toISOString(),directory:folder,files:[],newQuestionIds:[]};
const reportPath=resolve(reportFolder,'batch-import-result.json');
const before=await api('/api/questions'),beforeIds=new Set(before.map(q=>q.id));
async function save(){await writeFile(reportPath,JSON.stringify(report,null,2),'utf8');}
const waitFor=id=>waitForImport(()=>api('/api/jobs/'+id),{onProgress:message=>console.log('  '+message)});
for(let i=0;i<plan.length;i++){
  const file=plan[i],entry={name:file.name,status:'pending'};report.files.push(entry);await save();
  console.log('['+(i+1)+'/'+plan.length+'] '+file.name);
  try{
    const inspected=await check(file);
    if(inspected.action==='skip'){
      entry.status='skipped';entry.importId=inspected.existing.id;entry.questionCount=inspected.existing.count;
      console.log('  已导入，按图片内容跳过。');await save();continue;
    }
    let task=inspected.action==='resume'?inspected.existing:null;
    if(!task){
      const bytes=await readFile(resolve(folder,file.name));
      try{task=await api('/api/import',{method:'POST',body:JSON.stringify({name:file.name,base64:bytes.toString('base64')})});}
      catch(error){
        // Ask the import module to resolve ambiguous transport failures; never query its storage.
        const recovered=await check(file);
        if(['skip','resume'].includes(recovered.action))task=recovered.existing;else throw error;
      }
    }
    entry.importId=task.id;entry.status='processing';await save();await waitFor(task.id);
    const rows=await api('/api/questions?importId='+encodeURIComponent(task.id));
    const added=rows.filter(q=>!beforeIds.has(q.id));
    assert.equal(added.every(q=>q.state==='pending'),true,'新增题目必须全部待核对');
    entry.status=task.reused&&task.state==='completed'?'skipped':'completed';
    entry.questionCount=rows.length;entry.newQuestionCount=added.length;
    entry.emptyQuestionCount=rows.filter(q=>!q.content.question?.trim()).length;
    report.newQuestionIds.push(...added.map(q=>q.id));
    console.log('  完成：'+rows.length+'条记录，新增'+added.length+'条，均待核对。');
  }catch(error){entry.status=error.unfinished?'unfinished':'failed';entry.error=error.message;console.log('  未完成：'+error.message);}
  await save();
}
const after=await api('/api/questions'),afterIds=new Set(after.map(q=>q.id));
assert.equal([...beforeIds].every(id=>afterIds.has(id)),true,'已有题目不能丢失');
// Users may edit questions while the batch runs; expose those changes rather
// than claim unchanged contents or reject legitimate concurrent edits.
report.priorQuestionChanges=before.filter(old=>JSON.stringify(after.find(q=>q.id===old.id))!==JSON.stringify(old)).map(q=>q.id);
report.finishedAt=new Date().toISOString();
report.summary={total:plan.length,skipped:report.files.filter(f=>f.status==='skipped').length,completed:report.files.filter(f=>f.status==='completed').length,unfinished:report.files.filter(f=>f.status==='unfinished').length,failed:report.files.filter(f=>f.status==='failed').length,newQuestions:new Set(report.newQuestionIds).size,allNewPending:report.newQuestionIds.every(id=>after.find(q=>q.id===id)?.state==='pending'),priorQuestionIdsPreserved:true,priorQuestionChanges:report.priorQuestionChanges.length};
await save();console.log('批量结果：'+JSON.stringify(report.summary));console.log('报告：'+reportPath);
if(report.summary.failed||report.summary.unfinished)process.exitCode=1;

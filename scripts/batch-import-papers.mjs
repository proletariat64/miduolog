import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';

const folder=resolve(process.argv[2]||'');if(!process.argv[2])throw new Error('请提供试卷目录');
const run=process.argv.includes('--run'),base='http://127.0.0.1:4318';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const db=new DatabaseSync('data/notebook.sqlite',{readOnly:true});
const before=db.prepare('SELECT * FROM questions').all();
async function knownImages(){const map=new Map();for(const row of db.prepare('SELECT * FROM imports ORDER BY createdAt').all()){
  try{const hash=digest(await readFile(resolve('data/images',row.image)));const previous=map.get(hash);if(!previous||row.state==='completed'||previous.state!=='completed')map.set(hash,row);}catch(error){if(error.code!=='ENOENT')throw error;}
}return map;}
let known=await knownImages();
const files=(await readdir(folder,{withFileTypes:true})).filter(f=>f.isFile()&&['.png','.jpg','.jpeg','.webp'].includes(extname(f.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
const plan=[];for(const f of files){const hash=digest(await readFile(resolve(folder,f.name))),existing=known.get(hash);plan.push({name:f.name,hash,action:existing?.state==='completed'?'skip':existing?.state==='processing'?'resume':'recognize',existingId:existing?.id||null});}
console.log(JSON.stringify({directory:folder,total:plan.length,skip:plan.filter(f=>f.action==='skip').length,process:plan.filter(f=>f.action!=='skip').length,files:plan.map(({hash,...f})=>f)},null,2));
if(!run){db.close();process.exit(0);}
const reportFolder='.scratch/mistake-notebook/real-paper';await mkdir(reportFolder,{recursive:true});
const report={startedAt:new Date().toISOString(),directory:folder,files:[],newQuestionIds:[],priorQuestionCount:before.length};
const reportPath=resolve(reportFolder,'batch-import-result.json');
async function save(){await writeFile(reportPath,JSON.stringify(report,null,2),'utf8');}
async function api(path,options={}){const r=await fetch(base+path,{signal:AbortSignal.timeout(30000),...options,headers:{'Content-Type':'application/json','X-Mido-Client':'desktop',...options.headers}});const data=await r.json();if(!r.ok){const error=new Error(data.error||'请求失败');error.status=r.status;throw error;}return data;}
async function waitFor(id){const deadline=Date.now()+480000;let last='';while(Date.now()<deadline){
  const row=db.prepare('SELECT * FROM imports WHERE id=?').get(id);if(row?.state==='completed')return row;if(row?.state==='failed')throw new Error(row.error||'识别失败');
  try{const job=await api('/api/jobs/'+id);if(job.message!==last){console.log('  '+job.message);last=job.message;}}catch(error){if(error.status!==404)console.log('  进度暂不可读，继续检查本地保存状态。');}
  await new Promise(r=>setTimeout(r,2500));
}throw new Error('等待识别超过8分钟，原图已保留；不重复上传');}
for(let i=0;i<plan.length;i++){
  const file=plan[i],entry={name:file.name,hash:file.hash,status:'pending'};report.files.push(entry);await save();
  console.log('['+(i+1)+'/'+plan.length+'] '+file.name);
  try{
    known=await knownImages();let existing=known.get(file.hash);
    if(existing?.state==='completed'){entry.status='skipped';entry.importId=existing.id;entry.questionCount=db.prepare('SELECT count(*) AS n FROM questions WHERE importId=?').get(existing.id).n;console.log('  已导入，按图片内容跳过。');await save();continue;}
    let id=existing?.state==='processing'?existing.id:null;
    if(!id){const bytes=await readFile(resolve(folder,file.name));const deadline=Date.now()+600000;
      while(!id){try{id=(await api('/api/import',{method:'POST',body:JSON.stringify({name:basename(file.name),base64:bytes.toString('base64')})})).id;}catch(error){
        // 仅409可确定没有创建任务；网络不确定时通过内容比对找回，避免重复上传。
        existing=(await knownImages()).get(file.hash);if(existing&&['processing','completed'].includes(existing.state)){id=existing.id;break;}
        if(error.status!==409||Date.now()>deadline)throw error;console.log('  本机正在处理其他图片，排队等待……');await new Promise(r=>setTimeout(r,3000));
      }}
    }
    entry.importId=id;entry.status='processing';await save();await waitFor(id);
    const rows=db.prepare('SELECT * FROM questions WHERE importId=?').all(id);const added=rows.filter(q=>!before.some(old=>old.id===q.id));
    assert.equal(added.every(q=>q.state==='pending'),true,'新增题目必须全部待核对');
    entry.status='completed';entry.questionCount=rows.length;entry.newQuestionCount=added.length;entry.emptyQuestionCount=rows.filter(q=>!JSON.parse(q.content).question?.trim()).length;
    report.newQuestionIds.push(...added.map(q=>q.id));console.log('  识别完成：'+rows.length+'题，新增'+added.length+'题，全部待核对。');
  }catch(error){entry.status='failed';entry.error=error.message;console.log('  未完成：'+error.message);}
  await save();
}
for(const previous of before)assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id=?').get(previous.id),previous,'已有题目被意外修改');
report.finishedAt=new Date().toISOString();report.summary={total:plan.length,skipped:report.files.filter(f=>f.status==='skipped').length,completed:report.files.filter(f=>f.status==='completed').length,failed:report.files.filter(f=>f.status==='failed').length,newQuestions:new Set(report.newQuestionIds).size,allNewPending:report.newQuestionIds.every(id=>db.prepare('SELECT state FROM questions WHERE id=?').get(id).state==='pending'),priorQuestionsUnchanged:true};
await save();db.close();console.log('批量结果：'+JSON.stringify(report.summary));console.log('报告：'+reportPath);if(report.summary.failed)process.exitCode=1;

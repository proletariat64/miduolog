import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {localServiceUrl} from '../lib/worktree-environment.mjs';
const filename=process.argv[2];if(!filename)throw new Error('请提供试卷图片路径');
const base=await localServiceUrl(resolve('.'));
const bytes=await readFile(filename);
const response=await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Mido-Client':'desktop'},body:JSON.stringify({name:basename(filename),base64:bytes.toString('base64')})});
const job=await response.json();if(!response.ok)throw new Error(job.error);
console.log('已保存原图；导入编号：'+job.id);
let previous='',status;const deadline=Date.now()+480000;
do{
  await new Promise(r=>setTimeout(r,2500));
  status=await (await fetch(base+'/api/jobs/'+job.id)).json();
  if(status.message!==previous){console.log(status.message);previous=status.message;}
  if(Date.now()>deadline)throw new Error('等待结果超时，原图仍保留在本机');
}while(status.state==='processing');
if(status.state!=='completed')throw new Error(status.message||'识别失败');
const all=await (await fetch(base+'/api/questions')).json();
const questions=all.filter(q=>q.importId===job.id);
const out=resolve('.scratch/mistake-notebook/real-paper');await mkdir(out,{recursive:true});
await writeFile(resolve(out,'latest-result.json'),JSON.stringify({importId:job.id,questions},null,2),'utf8');
console.log(JSON.stringify({importId:job.id,count:questions.length,questions:questions.map(q=>({id:q.id,...q.content}))},null,2));

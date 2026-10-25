import {CodexClient,recognitionSchema} from '../../app/codex-client.mjs';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
const client=new CodexClient();
const out=resolve('.scratch/mistake-notebook/verification');
try{
  const info=await client.start();console.log('app-server initialize 成功');
  const account=await client.request('account/read',{refreshToken:false});
  console.log('登录类型：'+(account.account?.type||'未登录'));
  if(!account.account)throw new Error('app-server 未登录');
  const models=await client.request('model/list',{});console.log('可见模型目录数量：'+(models.data?.length||0));
  console.log('开始真实图片识别……');
  const result=await client.recognize(resolve(process.argv[2]||out+'/vision-fixture.png'),recognitionSchema);
  await mkdir(out,{recursive:true});await writeFile(resolve(out,'vision-result.json'),JSON.stringify({verifiedAt:new Date().toISOString(),userAgent:info.userAgent,authType:account.account.type,...result},null,2),'utf8');
  console.log(JSON.stringify(result.data,null,2));
  // 页面随机标记和题目数字均未提供给模型文本提示，验证它确实读取了图像。
  if(!result.data.pageMarker.includes('42719'))throw new Error('图片页面标记校验失败');
  if(result.data.questions.length!==2)throw new Error('整页两题识别数量不符');
  if(!result.data.questions.some(q=>q.subject==='数学'&&/5/.test(q.question)&&/6/.test(q.question)&&/2/.test(q.question)&&/3/.test(q.question)))throw new Error('数学题识别不符');
  if(!result.data.questions.some(q=>q.subject==='语文'&&q.question.includes('通过这次活动')))throw new Error('语文题识别不符');
  console.log('PASS：登录、localImage 输入、两题拆分、结构化结果及页面标记校验通过。');
}catch(error){console.error('FAIL：'+error.message);if(client.stderr)console.error(client.stderr.slice(-2000));process.exitCode=1;}finally{client.close();}

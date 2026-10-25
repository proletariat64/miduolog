// 独立的进度交互测试服务：仅内存模拟，不调用 Codex，不接触真实错题数据库。
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
let current=null,result='processing',jobUnavailable=false;
const json=(res,data)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
http.createServer(async(req,res)=>{const path=new URL(req.url,'http://127.0.0.1:4320').pathname;
  if(path==='/api/status'){json(res,{loggedIn:true,authType:'测试模拟，不调用模型'});return;}
  if(path==='/api/imports'){json(res,current?[{...current,state:result}]:[]);return;}
  const questions=result==='completed'?[{id:'test-question',importId:'test-import',state:'pending',createdAt:current.createdAt,content:{number:'1',subject:'数学',question:'进度测试：计算 1/2 + 1/4',studentAnswer:'',knowledgePoint:'测试题目',possibleCause:'',observedError:'',causeStatus:'pending'}}]:[];
  if(path==='/api/questions'){json(res,questions);return;}
  if(path==='/api/import'&&req.method==='POST'){let data='';for await(const chunk of req)data+=chunk;const input=JSON.parse(data);current={id:'test-import',originalName:input.name,createdAt:new Date().toISOString()};result='processing';await new Promise(r=>setTimeout(r,1000));json(res,{id:'test-import'});return;}
  if(path==='/api/jobs/test-import'){if(jobUnavailable){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'模拟连接中断'}));return;}json(res,{state:result,count:result==='completed'?1:0,message:result==='processing'?'正在识别测试图片……':result==='completed'?'识别完成，测试结果已准备好。':'模拟识别失败，原图已保留。'});return;}
  if(path==='/test/complete'){result='completed';jobUnavailable=false;json(res,{ok:true});return;}
  if(path==='/test/fail'){result='failed';json(res,{ok:true});return;}
  if(path==='/test/disconnect'){jobUnavailable=true;json(res,{ok:true});return;}
  if(path==='/test/reconnect'){jobUnavailable=false;json(res,{ok:true});return;}
  if(path==='/test/reset'){current=null;result='processing';jobUnavailable=false;json(res,{ok:true});return;}
  if(path.startsWith('/images/')){res.writeHead(200,{'Content-Type':'image/png'});res.end(await readFile('.scratch/mistake-notebook/verification/vision-fixture.png'));return;}
  const file=({'/':'index.html','/client.js':'client.js','/styles.css':'styles.css'})[path];if(file){let bytes=await readFile(resolve('app',file));if(file==='index.html')bytes=Buffer.from(bytes.toString().replace('class="brand">米多错题本','class="brand">进度测试 · 模拟环境'));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(bytes);return;}res.writeHead(404);res.end();
}).listen(4320,'127.0.0.1',()=>console.log('进度测试服务：http://127.0.0.1:4320，不调用模型，不保存真实数据。'));

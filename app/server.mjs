import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CodexClient,recognitionSchema} from './codex-client.mjs';
import {ReviewService} from './review-service.mjs';

const appDir=dirname(fileURLToPath(import.meta.url)),root=resolve(appDir,'..');
process.chdir(root);
const dataDir=resolve(root,'data'),imageDir=resolve(dataDir,'images');
await mkdir(imageDir,{recursive:true});
const db=new DatabaseSync(resolve(dataDir,'notebook.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, image TEXT NOT NULL, originalName TEXT NOT NULL, state TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, importId TEXT NOT NULL, state TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL);');
const client=new CodexClient();let started=null,busy=false;
async function connection(){if(!started)started=client.start().catch(error=>{started=null;throw error;});return started;}
function allQuestions(){return db.prepare('SELECT * FROM questions ORDER BY createdAt DESC,rowid').all().map(q=>({...q,content:JSON.parse(q.content)}));}
const jobs=new Map();
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>24*1024*1024)throw new Error('图片过大，请使用 15 MB 以下的图片');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function imageType(bytes){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';return null;}
async function runImport(id,imagePath){const job=jobs.get(id);busy=true;try{
  await connection();job.message='Codex 正在识别题目与原作答，并分析可能错因……';
  const result=await client.recognize(imagePath,recognitionSchema);
  if(!Array.isArray(result.data.questions))throw new Error('返回结果缺少题目列表');
  if(result.data.questions.length>100)throw new Error('识别题目过多，请分批处理');
  db.exec('BEGIN IMMEDIATE');try{for(const q of result.data.questions){if(typeof q.question!=='string'||typeof q.studentAnswer!=='string'||typeof q.possibleCause!=='string')throw new Error('识别结果格式不完整');db.prepare('INSERT INTO questions VALUES (?,?,?,?,?)').run(randomUUID(),id,'pending',JSON.stringify({...q,causeStatus:'pending',unclear:result.data.unclear||[]}),new Date().toISOString());}db.prepare('UPDATE imports SET state=? WHERE id=?').run('completed',id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  job.state='completed';job.count=result.data.questions.length;job.message=job.count?'识别完成，请逐题核对。':'没有识别出可收录题目；原图已保留，可以重新选择图片。';
}catch(error){job.state='failed';job.message=error.message;db.prepare('UPDATE imports SET state=?,error=? WHERE id=?').run('failed',error.message,id);}finally{busy=false;}}
const review=new ReviewService({db,client,connection,dataDir,imageType});
const port=Number(process.env.MIDO_PORT||4318),origin='http://127.0.0.1:'+port;
const server=http.createServer(async(req,res)=>{try{
  if(req.headers.host!=='127.0.0.1:'+port){json(res,403,{error:'仅允许本机地址访问'});return;}
  const url=new URL(req.url,origin),path=url.pathname;
  if(req.method!=='GET'&&(req.headers.origin&&req.headers.origin!==origin||req.headers['x-mido-client']!=='desktop')){json(res,403,{error:'请求来源不匹配'});return;}
  if(path.startsWith('/api/review/')){await review.handle(req,res,path,{body,json});return;}
  if(req.method==='GET'&&path==='/api/status'){await connection();const account=await client.request('account/read',{refreshToken:false});json(res,200,{loggedIn:!!account.account,authType:account.account?.type||null,busy});return;}
  if(req.method==='GET'&&path==='/api/questions'){json(res,200,allQuestions());return;}
  if(req.method==='GET'&&path==='/api/imports'){json(res,200,db.prepare('SELECT id, originalName,state,error,createdAt FROM imports ORDER BY createdAt DESC').all());return;}
  if(req.method==='POST'&&path==='/api/import'){
    if(busy){json(res,409,{error:'正在识别上一张图片，请稍候'});return;}
    const input=await body(req);if(typeof input.base64!=='string'||typeof input.name!=='string')throw new Error('缺少图片文件');const bytes=Buffer.from(input.base64,'base64'),extension=imageType(bytes);if(!extension)throw new Error('请使用 PNG、JPEG 或 WebP 图片');if(bytes.length>15*1024*1024)throw new Error('单张图片不能超过 15 MB');
    const id=randomUUID(),filename=id+'.'+extension,imagePath=resolve(imageDir,filename);await writeFile(imagePath,bytes);db.prepare('INSERT INTO imports VALUES (?,?,?,?,?,?)').run(id,filename,input.name.slice(0,250),'processing',null,new Date().toISOString());jobs.set(id,{state:'processing',message:'原图已保存，正在连接 Codex……'});void runImport(id,imagePath);json(res,202,{id});return;
  }
  const jobMatch=path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);if(req.method==='GET'&&jobMatch){const job=jobs.get(jobMatch[1]);json(res,job?200:404,job||{error:'找不到本次识别任务'});return;}
  const qMatch=path.match(/^\/api\/questions\/([a-f0-9-]+)$/);if(req.method==='PATCH'&&qMatch){const previous=db.prepare('SELECT * FROM questions WHERE id=?').get(qMatch[1]);if(!previous){json(res,404,{error:'题目不存在'});return;}const input=await body(req),content=JSON.parse(previous.content);for(const key of ['question','studentAnswer','subject','knowledgePoint','observedError','possibleCause'])if(typeof input[key]==='string')content[key]=input[key].slice(0,30000);if(input.causeStatus&&['pending','confirmed','disputed'].includes(input.causeStatus))content.causeStatus=input.causeStatus;const state=input.state==='library'?'library':previous.state;if(!content.question.trim())throw new Error('题目不能为空');db.prepare('UPDATE questions SET state=?,content=? WHERE id=?').run(state,JSON.stringify(content),previous.id);json(res,200,{ok:true});return;}
  const imageMatch=path.match(/^\/images\/([a-f0-9-]+)$/);if(req.method==='GET'&&imageMatch){const row=db.prepare('SELECT image FROM imports WHERE id=?').get(imageMatch[1]);if(!row){res.writeHead(404);res.end();return;}const bytes=await readFile(resolve(imageDir,row.image));res.writeHead(200,{'Content-Type':extname(row.image)==='.jpg'?'image/jpeg':'image/'+extname(row.image).slice(1),'X-Content-Type-Options':'nosniff'});res.end(bytes);return;}
  const assets={'/':'index.html','/index.html':'index.html','/client.js':'client.js','/review-client.js':'review-client.js','/styles.css':'styles.css'};if(req.method==='GET'&&assets[path]){const file=assets[path],bytes=await readFile(resolve(appDir,file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});res.end(bytes);return;}
  json(res,404,{error:'不存在的地址'});
}catch(error){json(res,500,{error:error.message});}});
// 中断中的导入保留原图，并标记可见的失败状态。
db.prepare('UPDATE imports SET state=?,error=? WHERE state=?').run('failed','上次运行在识别完成前结束，原图仍保留，请重新识别。','processing');
server.listen(port,'127.0.0.1',()=>console.log('米多错题本已启动：'+origin));
function shutdown(){client.close();server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);

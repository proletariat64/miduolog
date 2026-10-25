import {randomUUID} from 'node:crypto';
import {writeFile,mkdir,readFile,rename,rm} from 'node:fs/promises';
import {writeImage} from './local-images.mjs';
import {resolve,extname} from 'node:path';
import {LegacyReviewCatalog} from './review-catalog.mjs';

export const gradeSchema={type:'object',additionalProperties:false,required:['verdict','recognizedAnswer','reason','referenceAnswer','explanation','nextStep','uncertainties'],properties:{verdict:{type:'string',enum:['correct','incorrect','uncertain']},recognizedAnswer:{type:'string'},reason:{type:'string'},referenceAnswer:{type:'string'},explanation:{type:'string'},nextStep:{type:'string'},uncertainties:{type:'array',items:{type:'string'}}}};
const hintSchema={type:'object',additionalProperties:false,required:['hint'],properties:{hint:{type:'string'}}};
export function outcomeFor(verdict,hintUsed){if(verdict==='uncertain')return 'pending';if(verdict==='incorrect')return 'incorrect';if(verdict==='correct')return hintUsed?'hinted_correct':'independent_correct';throw new Error('批阅结论无效');}
export function safeQuestion(q){const c=q.content;return {id:q.id,number:c.number,subject:c.subject,question:c.question,diagramType:c.question.includes('四边形ECDF')&&c.question.includes('三角形AFD')?'rectangle-ecdf':null};}
export class ReviewService{
  constructor({db,client,dataDir,imageType,catalog=new LegacyReviewCatalog(db),files={}}){Object.assign(this,{db,client,dataDir,imageType,catalog,files:{mkdir,writeFile,readFile,rename,rm,...files}});this.workers=new Set();
    db.exec(`CREATE TABLE IF NOT EXISTS review_sessions(id TEXT PRIMARY KEY,state TEXT NOT NULL,isTest INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL,completedAt TEXT);
      CREATE TABLE IF NOT EXISTS review_items(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,questionId TEXT NOT NULL,position INTEGER NOT NULL,snapshot TEXT NOT NULL,state TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',answerImage TEXT,hintUsed INTEGER NOT NULL DEFAULT 0,hint TEXT NOT NULL DEFAULT '',result TEXT,grading TEXT,error TEXT,submittedAt TEXT,gradedAt TEXT,UNIQUE(sessionId,questionId));
      CREATE TABLE IF NOT EXISTS review_disputes(itemId TEXT PRIMARY KEY,message TEXT NOT NULL,createdAt TEXT NOT NULL);`);
    if(!db.prepare('PRAGMA table_info(review_items)').all().some(c=>c.name==='workToken'))db.exec('ALTER TABLE review_items ADD COLUMN workToken TEXT');
    db.prepare("UPDATE review_items SET state='failed',workToken=NULL,error='上次运行在完成前结束；作答已保留，可重新提交，不计为做错。' WHERE state IN ('grading','hinting')").run();
  }
  track(promise){this.workers.add(promise);promise.then(()=>this.workers.delete(promise),()=>this.workers.delete(promise));}
  async idle(){while(this.workers.size)await Promise.allSettled([...this.workers]);}
  claimSubmission(id,answer){const token=randomUUID();const changed=this.db.prepare("UPDATE review_items SET answer=?,state='grading',workToken=?,result=NULL,grading=NULL,error=NULL,submittedAt=? WHERE id=? AND state IN ('unanswered','failed')").run(answer,token,new Date().toISOString(),id);return changed.changes?token:null;}
  claimHint(id){const token=randomUUID();const changed=this.db.prepare("UPDATE review_items SET state='hinting',workToken=?,error=NULL WHERE id=? AND state IN ('unanswered','failed')").run(token,id);return changed.changes?token:null;}
  item(id){return this.db.prepare('SELECT * FROM review_items WHERE id=?').get(id);}
  itemDto(row){const snapshot=JSON.parse(row.snapshot),q=safeQuestion(snapshot);return {id:row.id,question:q,state:row.state,answer:row.answer,hasAnswerImage:!!row.answerImage,answerImageUrl:row.answerImage?'/api/review/items/'+row.id+'/answer-image':null,hintUsed:!!row.hintUsed,hint:row.hint,result:row.result,error:row.error,submittedAt:row.submittedAt,gradedAt:row.gradedAt,dispute:this.db.prepare('SELECT message,createdAt FROM review_disputes WHERE itemId=?').get(row.id)||null,...(row.state==='graded'?{grading:JSON.parse(row.grading),originalAnswer:snapshot.content.studentAnswer}: {})};}
  session(id){const session=this.db.prepare('SELECT * FROM review_sessions WHERE id=?').get(id);if(!session)return null;return {...session,isTest:!!session.isTest,items:this.db.prepare('SELECT * FROM review_items WHERE sessionId=? ORDER BY position').all(id).map(row=>this.itemDto(row))};}
  sessions(){return this.db.prepare('SELECT s.*,count(i.id) AS total,sum(CASE WHEN i.state=\'graded\' THEN 1 ELSE 0 END) AS graded FROM review_sessions s LEFT JOIN review_items i ON i.sessionId=s.id GROUP BY s.id ORDER BY s.createdAt DESC').all().map(s=>({...s,isTest:!!s.isTest}));}
  recommendations(){const library=this.catalog.reviewQuestions().filter(q=>q.originalName!=='vision-fixture.png');return library.map(q=>{
    const last=this.db.prepare("SELECT i.result,i.gradedAt FROM review_items i JOIN review_sessions s ON s.id=i.sessionId WHERE i.questionId=? AND s.isTest=0 AND i.state='graded' ORDER BY i.gradedAt DESC LIMIT 1").get(q.id);
    const age=last?Math.max(0,(Date.now()-Date.parse(last.gradedAt))/86400000):0;let score=50,reason='尚未复习，先检查是否已经学会';
    if(last?.result==='incorrect'){score=100+age;reason='上次仍不会，优先巩固';}else if(last?.result==='hinted_correct'){score=80+age;reason='上次提示后做对，再独立试试';}else if(last?.result==='pending'){score=60;reason='上次批阅待确认，可再试一次';}else if(last){score=10+age;reason=age>=7?'较久未复习，检查是否记得':'上次独立做对，少量穿插检查';}
    return {...safeQuestion(q),knowledgePoint:q.content.knowledgePoint,reason,score};
  }).sort((a,b)=>b.score-a.score||Number(a.number)-Number(b.number));}
  finishSession(id){const outstanding=this.db.prepare("SELECT count(*) AS n FROM review_items WHERE sessionId=? AND state!='graded'").get(id).n;if(!outstanding)this.db.prepare("UPDATE review_sessions SET state='completed',completedAt=? WHERE id=?").run(new Date().toISOString(),id);}
  async grade(id,token){const row=this.item(id);if(row.state!=='grading'||row.workToken!==token)return;const q=JSON.parse(row.snapshot);try{
    const response=await this.client.runJson({schema:gradeSchema,images:row.answerImage?[resolve(this.dataDir,'review-images',row.answerImage)]:[],instructions:'用中文批阅。数学判断答案与必要过程，接受等值分数、小数等不同写法；题目只要求填空或选择时，不因未写过程把正确答案判错。语文接受符合题意的不同措辞。分数用 LaTeX。只批阅本次作答，不能用原作答冒充本次作答。看不清、矛盾或信息不足时 verdict=uncertain，不能计为错误。不要自动认定掌握，不确认原错因。',prompt:JSON.stringify({task:'批阅这一次复习作答，并给出判断依据、参考答案、简短讲解与下一步建议。',question:q.content.question,subject:q.content.subject,currentAnswer:row.answer,hasCurrentAnswerImage:!!row.answerImage,hintUsed:!!row.hintUsed,hint:row.hint})});
    const g=response.data;const result=outcomeFor(g.verdict,!!row.hintUsed);for(const key of ['recognizedAnswer','reason','referenceAnswer','explanation','nextStep'])if(typeof g[key]!=='string')throw new Error('批阅结果缺少必要信息');if(!Array.isArray(g.uncertainties))throw new Error('批阅结果缺少待确认说明');
    const changed=this.db.prepare("UPDATE review_items SET state='graded',workToken=NULL,result=?,grading=?,error=NULL,gradedAt=? WHERE id=? AND state='grading' AND workToken=?").run(result,JSON.stringify(g),new Date().toISOString(),id,token);if(changed.changes)this.finishSession(row.sessionId);
  }catch(error){this.db.prepare("UPDATE review_items SET state='failed',workToken=NULL,error=? WHERE id=? AND state='grading' AND workToken=?").run(error.message,id,token);}}
  async makeHint(id,token){const row=this.item(id);if(row.state!=='hinting'||row.workToken!==token)return;const q=JSON.parse(row.snapshot);try{const response=await this.client.runJson({schema:hintSchema,instructions:'给六年级孩子一个简短的思路提示。不要给出最终答案、正确选项、最终数值或完整解法。',prompt:JSON.stringify({task:'提供一个帮助孩子继续独立思考的提示',question:q.content.question})});if(typeof response.data.hint!=='string'||!response.data.hint.trim())throw new Error('未获得有效提示');this.db.prepare("UPDATE review_items SET state='unanswered',workToken=NULL,hint=?,hintUsed=1,error=NULL WHERE id=? AND state='hinting' AND workToken=?").run(response.data.hint,id,token);}catch(error){this.db.prepare("UPDATE review_items SET state='unanswered',workToken=NULL,error=? WHERE id=? AND state='hinting' AND workToken=?").run(error.message,id,token);}}
  async handle(req,res,path,{body,json}){
    if(req.method==='GET'&&path==='/api/review/recommendations'){json(res,200,this.recommendations());return;}
    if(path==='/api/review/sessions'&&req.method==='GET'){json(res,200,this.sessions());return;}
    if(path==='/api/review/sessions'&&req.method==='POST'){
      const input=await body(req),ids=input.questionIds;if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length){json(res,400,{error:'请选择1至30道不同的已入库题目'});return;}
      const rows=ids.map(id=>this.catalog.reviewQuestion(id));if(rows.some(q=>!q)){json(res,400,{error:'只能复习已经核对入库的题目'});return;}
      const id=randomUUID(),now=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO review_sessions VALUES (?,?,?,?,?)').run(id,'active',input.isTest===true?1:0,now,null);rows.forEach((q,i)=>this.db.prepare('INSERT INTO review_items(id,sessionId,questionId,position,snapshot,state) VALUES (?,?,?,?,?,?)').run(randomUUID(),id,q.id,i,JSON.stringify(q),'unanswered'));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}json(res,201,this.session(id));return;
    }
    const sessionMatch=path.match(/^\/api\/review\/sessions\/([a-f0-9-]+)$/);if(req.method==='GET'&&sessionMatch){const session=this.session(sessionMatch[1]);json(res,session?200:404,session||{error:'找不到这次复习'});return;}
    const match=path.match(/^\/api\/review\/items\/([a-f0-9-]+)(?:\/(submit|hint|dispute|answer-image))?$/);if(match){const row=this.item(match[1]);if(!row){json(res,404,{error:'复习题目不存在'});return;}
      if(req.method==='GET'&&match[2]==='answer-image'){if(!row.answerImage){json(res,404,{error:'未提交作答图片'});return;}const bytes=await this.files.readFile(resolve(this.dataDir,'review-images',row.answerImage));const ext=extname(row.answerImage);res.writeHead(200,{'Content-Type':ext==='.jpg'?'image/jpeg':'image/'+ext.slice(1),'X-Content-Type-Options':'nosniff'});res.end(bytes);return;}
      if(req.method==='GET'&&!match[2]){json(res,200,this.itemDto(row));return;}
      if(req.method==='POST'&&match[2]==='dispute'){if(row.state!=='graded'){json(res,400,{error:'请在批阅完成后提出异议'});return;}const input=await body(req),message=typeof input.message==='string'?input.message.trim().slice(0,3000):'';if(!message){json(res,400,{error:'请简短说明疑问'});return;}this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT OR REPLACE INTO review_disputes VALUES (?,?,?)').run(row.id,message,new Date().toISOString());this.db.prepare("UPDATE review_items SET result='pending' WHERE id=?").run(row.id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}json(res,200,this.itemDto(this.item(row.id)));return;}
      if(req.method==='POST'&&['submit','hint'].includes(match[2])){
        if(['grading','hinting'].includes(row.state)){json(res,409,{error:'本题正在处理中，请稍候'});return;}if(row.state==='graded'){json(res,409,{error:'这次作答已经批阅，请开始新一轮复习'});return;}
        if(match[2]==='hint'){if(row.hint){json(res,200,this.itemDto(row));return;}const token=this.claimHint(row.id);if(!token){json(res,409,{error:'本题已由其他请求占用，请查看当前进度'});return;}this.track(this.makeHint(row.id,token));json(res,202,this.itemDto(this.item(row.id)));return;}
        const input=await body(req),answer=typeof input.answer==='string'?input.answer.trim():'';if(answer.length>30000){json(res,400,{error:'作答文字过长'});return;}let image=row.answerImage,imageBytes=null;
        if(input.imageBase64){imageBytes=Buffer.from(input.imageBase64,'base64');const type=this.imageType(imageBytes);if(!type||imageBytes.length>15*1024*1024){json(res,400,{error:'作答图片需为15MB以下的PNG、JPEG或WebP'});return;}image=randomUUID()+'.'+type;}
        if(!answer&&!image){json(res,400,{error:'请先输入答案或选择作答图片'});return;}
        const token=this.claimSubmission(row.id,answer);if(!token){json(res,409,{error:'本题已经提交或正在处理，请查看当前进度'});return;}
        if(imageBytes){try{await this.files.mkdir(resolve(this.dataDir,'review-images'),{recursive:true});await writeImage(resolve(this.dataDir,'review-images',image),imageBytes,this.files);const published=this.db.prepare("UPDATE review_items SET answerImage=? WHERE id=? AND state='grading' AND workToken=?").run(image,row.id,token);if(!published.changes)await this.files.rm(resolve(this.dataDir,'review-images',image),{force:true});}catch(error){this.db.prepare("UPDATE review_items SET state='failed',workToken=NULL,error=? WHERE id=? AND workToken=?").run('作答图片保存失败：'+error.message,row.id,token);json(res,500,{error:'作答图片保存失败；文字作答已保留，本次不计错。'});return;}}
        this.track(this.grade(row.id,token));json(res,202,this.itemDto(this.item(row.id)));return;
      }
    }
    json(res,404,{error:'复习接口不存在'});
  }
}

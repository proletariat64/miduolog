import {ReviewUI} from './review-client.js';
const $=id=>document.getElementById(id);let questions=[],imports=[],view='import',selected=null,working=false;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function math(s){let t=escape(s);t=t.replace(/\\frac\{(-?[a-zA-Z0-9]+(?:\.\d+)?)\}\{(-?[a-zA-Z0-9]+(?:\.\d+)?)\}/g,(_,n,d)=>fraction(n,d));t=t.replace(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g,(_,n,d)=>fraction(n,d));t=t.replace(/\\overline\{([a-zA-Z0-9]+)\}/g,(_,n)=>'<math xmlns="http://www.w3.org/1998/Math/MathML"><mover accent="true"><mrow>'+n.match(/\d+|[a-zA-Z]/g).map(atom).join('')+'</mrow><mo>¯</mo></mover></math>');t=t.replace(/\b(\d+|[a-zA-Z])\^(?:\{(-?\d+)\}|(-?\d+))/g,(_,base,a,b)=>'<math xmlns="http://www.w3.org/1998/Math/MathML"><msup>'+atom(base)+'<mn>'+(a||b)+'</mn></msup></math>');return t.replace(/\\times/g,'×').replace(/\\div/g,'÷').replace(/\\cdots/g,'⋯').replace(/\\ldots/g,'…').replace(/\\[()[\]]/g,'').replace(/\n/g,'<br>');}
function atom(s){const tag=/^-?\d+(?:\.\d+)?$/.test(s)?'mn':'mi';return '<'+tag+'>'+s+'</'+tag+'>';}
function fraction(n,d){return '<math xmlns="http://www.w3.org/1998/Math/MathML" displaystyle="true"><mfrac>'+atom(n)+atom(d)+'</mfrac></math>';}
async function api(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Mido-Client':'desktop',...options.headers}});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data;}
const reviewUI=new ReviewUI({api,math,escape,active:()=>view==='review'});
function notice(text,error=false){$('chat').innerHTML='<div class="notice '+(error?'error':'')+'">'+escape(text)+'</div>'+$('chat').innerHTML;}
async function reload(){[questions,imports]=await Promise.all([api('/api/questions'),api('/api/imports')]);$('pendingCount').textContent=questions.filter(q=>q.state==='pending').length;$('libraryCount').textContent=questions.filter(q=>q.state==='library').length;}
function cards(list){return list.map(q=>{const c=q.content;const analysisLabel=!c.question?.trim()?'题干缺失，需补充':c.causeStatus==='confirmed'?'错因已确认':c.observedError?(c.possibleCause?'模型提示需关注':'判断有疑问，需核对'):'暂未发现明确错误';return '<div class="item '+(selected===q.id?'selected':'')+'"><span class="tag">'+escape(c.subject)+' · 第 '+escape(c.number||'?')+' 题</span><span class="tag state">'+(q.state==='pending'?'待核对':'已入库')+'</span><span class="tag">'+analysisLabel+'</span><p>'+math(c.question||'图片中未识别到完整题干，请对照原图补充。')+'</p><button data-question="'+q.id+'">'+(q.state==='pending'?'核对题目 →':'查看题目 →')+'</button></div>';}).join('');}
function render(){document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));$('heading').textContent=({import:'录入错题',pending:'待核对',library:'错题库',review:'复习'})[view];$('composer').hidden=view==='review';feedback.hidden=view==='review'||!importTask;if(view==='review'){$('subheading').textContent='先独立作答，提交后由 Codex 批阅';$('panel').hidden=true;$('toggle').hidden=true;$('original').removeAttribute('src');for(const id of ['questionPreview','answerPreview','errorText','causeText'])$(id).textContent='';$('questionEdit').value='';$('answerEdit').value='';void reviewUI.home();return;}
  const list=questions.filter(q=>view==='library'?q.state==='library':q.state==='pending');$('subheading').textContent=view==='library'?'核对完成的错题 · 已保存在本地':'识别后先核对，再进入复习库';let text=view==='import'?'<h2>从一张作业图片开始</h2><p>打开整页图片，Codex 会识别题目和原作答，并提出待确认的错因。</p>':'';if(!list.length)text+='<div class="empty">'+(view==='library'?'还没有已核对入库的错题。':'目前没有待核对题目，打开图片即可开始。')+'</div>';else text+=cards(list);const failed=imports.filter(i=>i.state==='failed');if(failed.length&&view==='import')text+='<div class="notice error">有 '+failed.length+' 张图片识别未完成，原图已保留：'+failed.map(i=>escape(i.originalName)+'（'+escape(i.error)+'）').join('；')+'</div>';$('chat').innerHTML=text;}
function choose(id){const q=questions.find(q=>q.id===id);if(!q)return;selected=id;render();$('panel').hidden=false;$('toggle').hidden=false;$('toggle').textContent='收起题目详情 →';const c=q.content;$('original').src='/images/'+q.importId;$('originalLink').href='/images/'+q.importId;$('questionEdit').value=c.question;$('answerEdit').value=c.studentAnswer;$('subjectEdit').value=c.subject;$('knowledgeEdit').value=c.knowledgePoint;$('errorText').innerHTML=math(c.observedError||'暂未判断出明确错误。');$('causeText').innerHTML=math(c.possibleCause||'待确认。');$('unclear').textContent=(c.unclear||[]).join('；');$('confirm').hidden=q.state==='library';previews();$('chat').innerHTML+='<div class="message"><div class="who">米多的小助手</div><p>请先对照原图核对右侧题目和原作答。错因是模型的建议，你可以单独确认，也可以先保留待确认。</p><div class="actions"><button data-cause="confirmed">错因符合我的情况</button><button data-cause="disputed">不是这个原因</button><button data-cause="pending">我也不清楚</button></div></div>';}
function previews(){$('questionPreview').innerHTML=math($('questionEdit').value||'题干缺失，请对照原图补充后再入库。');$('answerPreview').innerHTML=math($('answerEdit').value||'未识别到原作答');}
async function save(state){if(!selected)return;await api('/api/questions/'+selected,{method:'PATCH',body:JSON.stringify({question:$('questionEdit').value,studentAnswer:$('answerEdit').value,subject:$('subjectEdit').value,knowledgePoint:$('knowledgeEdit').value,...(state?{state}:{})})});await reload();if(state==='library'){selected=null;$('panel').hidden=true;$('toggle').hidden=true;render();notice('题目已核对，进入复习库；错因待确认不影响入库。');}else{choose(selected);notice('修改已保存到本地。');}}
$('questionEdit').oninput=previews;$('answerEdit').oninput=previews;$('save').onclick=()=>save().catch(e=>notice(e.message,true));$('confirm').onclick=()=>save('library').catch(e=>notice(e.message,true));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;selected=null;$('panel').hidden=true;$('toggle').hidden=true;render();});document.addEventListener('click',async e=>{if(e.target.dataset.question)choose(e.target.dataset.question);if(e.target.dataset.cause&&selected){try{await api('/api/questions/'+selected,{method:'PATCH',body:JSON.stringify({causeStatus:e.target.dataset.cause})});await reload();choose(selected);notice(e.target.dataset.cause==='disputed'?'已保存你的异议，错因保留待确认。当前还未接入自动追问。':'已保存你的确认。');}catch(error){notice(error.message,true);}}});
$('toggle').onclick=()=>{$('panel').hidden=!$('panel').hidden;$('toggle').textContent=$('panel').hidden?'展开题目详情 ←':'收起题目详情 →';};$('close').onclick=()=>{$('panel').hidden=true;$('toggle').textContent='展开题目详情 ←';};$('open').onclick=()=>$('file').click();
// 进度独立于对话列表，切换页面、刷新和展开题目详情都不会把它覆盖掉。
let importTask=null,previewUrl=null,watchVersion=0;
const feedback=document.createElement('section');feedback.id='importFeedback';feedback.className='import-feedback';feedback.hidden=true;feedback.setAttribute('aria-label','图片导入进度');
feedback.innerHTML='<div class="feedback-top"><img id="feedbackImage" alt="本次导入图片缩略图"><div class="feedback-copy"><div class="feedback-heading"><strong id="feedbackTitle" role="status" aria-live="polite"></strong><span id="feedbackElapsed"></span></div><div id="feedbackFile"></div><p id="feedbackMessage"></p></div></div><ol class="import-steps"><li>① 已选择图片</li><li>② 上传到本机</li><li>③ Codex 识别与分析</li><li>④ 结果待核对</li></ol><progress id="feedbackMeter" max="100" aria-label="图片上传进度" hidden></progress><div id="feedbackHint" class="muted"></div><div class="actions feedback-actions"><button id="feedbackResults" hidden>查看本次识别结果 →</button><button id="feedbackCheck" hidden>重新检查进度</button><button id="feedbackRefresh" hidden>刷新状态</button></div>';
$('chat').before(feedback);
function updateElapsed(){if(!importTask)return;const seconds=Math.max(0,Math.floor(((importTask.endedAt||Date.now())-importTask.startedAt)/1000));$('feedbackElapsed').textContent=(importTask.endedAt?'用时 ':'已等待 ')+(seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒');}
setInterval(updateElapsed,1000);
function updateTask(changes){
  importTask={...importTask,...changes};const t=importTask;feedback.hidden=view==='review';feedback.dataset.phase=t.phase;
  working=!['completed','failed','unconfirmed'].includes(t.phase);$('open').disabled=working;
  const titles={reading:'图片已选中，正在读取',uploading:'正在上传图片到本机',saving:'正在保存原图',queued:'原图已保存，排队等待识别',processing:'原图已保存，Codex 正在识别',reconnecting:'暂时无法读取识别进度',connectionLost:'连接暂时中断，请检查进度',completed:t.count?'识别完成 · '+t.count+' 道题待核对':'识别完成 · 未找到题目',failed:'本次识别未完成',unconfirmed:'上传结果尚未确认'};
  $('feedbackTitle').textContent=titles[t.phase];$('feedbackFile').textContent=t.name+(t.size?' · '+(t.size/1024/1024).toFixed(2)+' MB':'');$('feedbackMessage').textContent=t.message||'';
  $('progress').textContent=titles[t.phase];$('open').textContent=working?'正在处理本次图片…':'＋ 打开图片并识别';
  const src=previewUrl||(t.id?'/images/'+t.id:'');$('feedbackImage').hidden=!src;if(src&&$('feedbackImage').getAttribute('src')!==src)$('feedbackImage').src=src;
  const step=t.phase==='reading'?0:t.phase==='uploading'||t.phase==='unconfirmed'?1:t.phase==='completed'?3:2;
  feedback.querySelectorAll('.import-steps li').forEach((el,i)=>{el.className=i<step?'done':i===step?'current':'';if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
  $('feedbackMeter').hidden=t.phase!=='uploading';if(t.percent==null)$('feedbackMeter').removeAttribute('value');else $('feedbackMeter').value=t.percent;
  $('feedbackHint').textContent=['queued','processing','reconnecting','connectionLost'].includes(t.phase)?'整页试卷或图形较多时可能需要几分钟，完成后自动显示题目数量。你可以继续查看已有题目。':t.phase==='completed'?'原图和结果已保存在本地。题目需核对后才进入复习库。':t.phase==='failed'&&t.id?'原图仍保存在本机，可重新选择图片重试。':'';
  $('feedbackResults').hidden=t.phase!=='completed'||!t.count;$('feedbackCheck').hidden=t.phase!=='connectionLost';$('feedbackRefresh').hidden=t.phase!=='unconfirmed';
  if(t.id){try{sessionStorage.setItem('mido-last-import',JSON.stringify({id:t.id,name:t.name,startedAt:t.startedAt,size:t.size,endedAt:t.endedAt}));}catch{/* Storage is optional; the server retains task state. */}}
  updateElapsed();
}
async function readJob(id){return api('/api/jobs/'+id,{signal:AbortSignal.timeout(20000)});}
async function watchImport(id){const version=++watchVersion;let failures=0;
  while(version===watchVersion){try{const state=await readJob(id);if(version!==watchVersion)return;failures=0;
    if(state.state==='processing'){updateTask({phase:({queued:'queued',saving:'saving'})[state.stage]||'processing',message:state.message||'正在识别题目、原作答和可能错因……'});}
    else{updateTask({phase:state.state==='completed'?'completed':'failed',count:state.count||0,message:state.message,endedAt:importTask.endedAt||Date.now()});try{await reload();if(!selected&&view!=='review'){view='pending';render();}}catch{ $('feedbackMessage').textContent+=' 题目列表读取失败，请刷新页面查看。';}return;}
  }catch{failures++;updateTask({phase:failures>=3?'connectionLost':'reconnecting',message:'暂时无法连接本机服务，后台可能仍在识别。无需重复上传。'});if(failures>=3)return;}
  await new Promise(resolve=>setTimeout(resolve,1500));
  }
}
function uploadImage(payload){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/import');xhr.setRequestHeader('Content-Type','application/json');xhr.setRequestHeader('X-Mido-Client','desktop');xhr.timeout=90000;
  xhr.upload.onprogress=e=>{const percent=e.lengthComputable?Math.round(e.loaded/e.total*100):null;updateTask({phase:'uploading',percent,message:percent===100?'图片已传送完毕，等待本机确认保存……':percent==null?'正在把图片传送到本机服务……':'已上传 '+percent+'%'});};
  xhr.onload=()=>{let data;try{data=JSON.parse(xhr.responseText);}catch{reject(new Error('本机返回了无法读取的上传结果'));return;}if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||'上传失败'));};xhr.onerror=()=>reject(new Error('上传连接中断，是否保存成功尚未确认'));xhr.ontimeout=()=>reject(new Error('等待上传响应超时，是否保存成功尚未确认'));xhr.send(JSON.stringify(payload));});}
$('feedbackResults').onclick=()=>{view='pending';selected=null;render();const first=questions.find(q=>q.importId===importTask.id);if(first)choose(first.id);};$('feedbackCheck').onclick=()=>{updateTask({phase:'reconnecting',message:'正在重新读取本次任务状态……'});void watchImport(importTask.id);};$('feedbackRefresh').onclick=()=>location.reload();
$('file').onchange=async()=>{
  const f=$('file').files[0];if(!f||working)return;
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(f);++watchVersion;
  importTask=null;updateTask({phase:'reading',name:f.name,size:f.size,startedAt:Date.now(),message:'已收到你的文件选择，正在读取图片……'});
  if(f.size>15*1024*1024){updateTask({phase:'failed',endedAt:Date.now(),message:'图片超过 15 MB，请缩小后重新选择。未上传图片。'});$('file').value='';return;}
  let uploading=false;
  try{await new Promise(resolve=>requestAnimationFrame(resolve));const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('无法读取图片，未上传。'));reader.readAsDataURL(f);});
    uploading=true;updateTask({phase:'uploading',percent:0,message:'图片读取完成，开始上传到本机……'});const job=await uploadImage({name:f.name,base64});
    if(!job.id)throw new Error('本机未返回任务编号，请刷新检查是否已保存');
    updateTask({id:job.id,phase:'processing',message:'本机已确认保存原图，正在等待 Codex 返回识别结果……'});await watchImport(job.id);
  }catch(error){updateTask({phase:uploading?'unconfirmed':'failed',endedAt:Date.now(),message:error.message+(uploading?'。请先刷新状态，避免重复上传。':'')});}
  finally{$('file').value='';}
};
render();try{await reload();render();}catch(error){notice(error.message,true);}
let remembered=null;try{remembered=JSON.parse(sessionStorage.getItem('mido-last-import')||'null');}catch{/* Storage is optional; the server retains task state. */}
const processingImport=imports.find(item=>item.state==='processing');
const last=processingImport||(remembered&&imports.find(item=>item.id===remembered.id));
if(last){updateTask({id:last.id,name:last.originalName,size:remembered?.id===last.id?remembered.size:undefined,endedAt:last.state!=='processing'&&remembered?.id===last.id?remembered.endedAt:undefined,startedAt:new Date(last.startedAt||last.createdAt).getTime(),phase:'processing',message:'正在读取上次识别的状态……'});void watchImport(last.id);}
try{const status=await api('/api/status');$('connection').textContent=status.loggedIn?'● 已登录 · '+status.authType:'需要登录 Codex';}catch(error){$('connection').textContent='连接失败';notice('无法连接 Codex：'+error.message,true);}

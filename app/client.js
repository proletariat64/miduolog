import {PendingCommands, commandIdentity} from './intake-command-client.js';
import {ReviewUI} from './review-client.js';
const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states = {pending:'待确认',incorrect:'错误',correct:'正确',partial:'部分正确',unanswered:'未作答',no_answer:'无原作答'};
const marks = {unmarked:'未见批改',incorrect:'判错',correct:'判对',partial:'部分得分',unclear:'看不清'};
const stages = {queued:'排队中',saving:'保存原图',processing:'识别中',completed:'已完成',failed:'未完成',attention:'需处理',partial_failure:'部分失败'};
const completeness = {complete:'题目完整',partial:'题目残缺',unclear:'完整性待核对'};
const origins = {manual:'人工修改',recognition:'识别判断',legacy:'旧记录'};
let view='import', questions=[], batches=[], materials=[], selected=null, currentQuestion=null, batchFilter='', statusFilter='', tagFilter='', includeRemoved=false;
let dirty=false, uploading=false, uploadPending=null, refreshing=false, selectionVersion=0, editorVersion=0, fieldSerial=0, filtersDirty=false, editSerial=0, recoveryRequestId=null;
const drafts=new Map(), completedForms=new WeakMap();
const keys = new Map(), commands = new PendingCommands();
const key = name => { if(!keys.has(name))keys.set(name,crypto.randomUUID());return keys.get(name); };
const when = d => d ? new Date(d).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '';
function math(value) {
  let t=escape(value);
  const atom=s=>'<'+(/^-?\d+(?:\.\d+)?$/.test(s)?'mn':'mi')+'>'+s+'</'+(/^-?\d+(?:\.\d+)?$/.test(s)?'mn':'mi')+'>';
  const fraction=(n,d)=>'<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac>'+atom(n)+atom(d)+'</mfrac></math>';
  t=t.replace(/\\frac\{(-?[a-zA-Z0-9]+(?:\.\d+)?)\}\{(-?[a-zA-Z0-9]+(?:\.\d+)?)\}/g,(_,n,d)=>fraction(n,d));
  t=t.replace(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g,(_,n,d)=>fraction(n,d));
  t=t.replace(/\\overline\{([a-zA-Z0-9]+)\}/g,(_,n)=>'<math xmlns="http://www.w3.org/1998/Math/MathML"><mover accent="true"><mrow>'+n.match(/\d+|[a-zA-Z]/g).map(atom).join('')+'</mrow><mo>¯</mo></mover></math>');
  t=t.replace(/\b(\d+|[a-zA-Z])\^(?:\{(-?\d+)\}|(-?\d+))/g,(_,base,a,b)=>'<math xmlns="http://www.w3.org/1998/Math/MathML"><msup>'+atom(base)+'<mn>'+(a||b)+'</mn></msup></math>');
  return t.replace(/\\times/g,'×').replace(/\\div/g,'÷').replace(/\\cdots|\\ldots/g,'…').replace(/\\[()[\]]/g,'').replace(/\n/g,'<br>');
}
async function api(path,options={}) {
  const r=await fetch(path,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),'X-Mido-Client':'desktop',...options.headers}});
  let data;try{data=await r.json();}catch{throw new Error('本机返回了无法读取的结果，请检查进度后再试。');}
  if(!r.ok)throw Object.assign(new Error(data.error||'请求未完成'),{status:r.status});return data;
}
const send=(path,data,method='POST')=>api(path,{method,body:JSON.stringify(data)});
const review=new ReviewUI({api,math,escape,active:()=>view==='review'});
function notice(message,error=false){$('notice').hidden=false;$('notice').className='notice '+(error?'error':'');$('notice').textContent=message;}
const opts=(values,value)=>Object.entries(values).map(([k,label])=>'<option value="'+escape(k)+'" '+(k===value?'selected':'')+'>'+escape(label)+'</option>').join('');
function input(label,name,value='',area=false){const id='field-'+(++fieldSerial);return '<div class="field"><label for="'+id+'">'+escape(label)+'</label>'+(area?'<textarea id="'+id+'" name="'+name+'">'+escape(value)+'</textarea>':'<input id="'+id+'" name="'+name+'" value="'+escape(value)+'">')+'</div>';}
function select(label,name,values,value){const id='field-'+(++fieldSerial);return '<div class="field"><label for="'+id+'">'+escape(label)+'</label><select id="'+id+'" name="'+name+'">'+opts(values,value)+'</select></div>';}
const tags=q=>[...new Set([q.content.subject,q.content.knowledgePoint,...(q.content.tags||[])].filter(Boolean))];
const attemptStates=()=>Object.fromEntries(Object.entries(states).filter(([s])=>s!=='no_answer'));
function source(s,label='原图') {
  if(!s?.imageUrl)return '';
  const b=s.bbox,valid=b&&['x','y','width','height'].every(k=>Number.isFinite(b[k]));
  return '<figure class="source"><a href="'+escape(s.imageUrl)+'" target="_blank" rel="noopener"><div class="source-image"><img loading="lazy" decoding="async" src="'+escape(s.imageUrl)+'?preview=1" alt="'+escape(label)+'">'+(valid?'<span class="source-box" data-box="'+escape(JSON.stringify(b))+'"></span>':'')+'</div></a><figcaption>'+escape(s.location||label)+' · 点击查看完整原图</figcaption><button data-action="evidence" data-id="'+escape(s.photoId)+'">查看初始识别</button></figure>';
}
function draftKey(form){return form.dataset.form+':'+(form.dataset.id||'');}
function formSnapshot(form){return {questionId:form.closest('#detail')?selected:null,html:form.innerHTML,values:[...form.elements].filter(el=>el.name).map(el=>({name:el.name,value:el.value,checked:el.checked,type:el.type}))};}
function captureDraft(event){const form=event.target.closest('form[data-form]');if(!form||commands.has(commandName(form))||completedForms.has(form))return;++editSerial;drafts.set(draftKey(form),formSnapshot(form));dirty=true;}
function restoreDrafts(root=$('detail')){for(const form of root.querySelectorAll('form[data-form]')){const pending=commands.get(commandName(form)),d=pending?.snapshot||drafts.get(draftKey(form));if(!d||d.questionId!==(form.closest('#detail')?selected:null))continue;if(pending&&d.html)form.innerHTML=d.html;for(const v of d.values){const matches=[...form.elements].filter(el=>el.name===v.name),el=v.type==='checkbox'?matches.find(el=>el.value===v.value):matches[0];if(!el)continue;if(v.type==='checkbox')el.checked=v.checked;else el.value=v.value;}if(pending)lockCommand(form,true);}dirty=drafts.size>0;}
function renderPendingCommands(){const box=$('pendingCommands');box.hidden=!commands.size;box.innerHTML=commands.size?'<p>上次保存结果尚未确认。切换页面不会重新提交，先确认原结果再开始另一笔相同操作。</p>'+[...commands.values()].map(c=>'<button data-action="recover-command" data-id="'+escape(c.key)+'" '+(commands.isSending(c.key)?'disabled':'')+'>确认上次保存结果 · '+escape(c.label)+'</button>').join(''):'';}

function evidenceText(value) {
  if(value==null)return '未记录';
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(evidenceText).join('；');
  const labels={number:'题号',subject:'学科',question:'题干',studentAnswer:'孩子原作答',knowledgePoint:'知识点',tags:'标签',sharedMaterial:'共用材料',diagramDescription:'配图说明',statusReason:'状态说明',reason:'判断依据',observedError:'可观察错误',possibleCause:'可能错因',score:'得分',comment:'评语与订正',evidence:'批改证据',text:'材料文字',description:'材料说明'};
  const parts=value.content?[evidenceText(value.content)]:[];
  for(const [k,label] of Object.entries(labels))if(value[k]!==undefined&&value[k]!==''&&(!Array.isArray(value[k])||value[k].length))parts.push(label+'：'+evidenceText(value[k]));
  if(value.status)parts.push('作答状态：'+(states[value.status]||'待确认'));
  if(value.mark)parts.push('老师判断：'+(marks[value.mark]||value.mark));
  if(value.verdict)parts.push('AI判断：'+(states[value.verdict]||'无法判断'));
  if(value.teacherReview)parts.push('老师批改：'+evidenceText(value.teacherReview));
  if(value.aiAssessment)parts.push('AI记录：'+evidenceText(value.aiAssessment));
  if(value.verified!==undefined)parts.push(value.verified?'题目已核对':'题目待核对');
  return parts.join('\n')||'记录已保留';
}
function history(rows=[]) {
  const kinds={question_created:'初次保存题目',question_edited:'修改题目信息',question_removed:'移除误识别题',attempt_created:'保存原作答',attempt_edited:'修改原作答',material_created:'保存共用材料',material_edited:'修改共用材料',question_split:'拆分题目',question_merged:'合并题目'};
  return rows.length?'<ol class="history">'+rows.map(h=>'<li>'+escape(origins[h.source]||h.source)+' · '+escape(when(h.createdAt))+'<details><summary>'+(kinds[h.kind]||'记录变更')+' · 对照修改前后</summary><strong>修改前</strong><p>'+math(evidenceText(h.before))+'</p><strong>修改后</strong><p>'+math(evidenceText(h.after))+'</p></details></li>').join('')+'</ol>':'<p class="muted">没有修改记录。</p>';
}
async function load() {
  [questions,batches,materials]=await Promise.all([api('/api/intake/questions?includeRemoved=1'),api('/api/intake/batches'),api('/api/intake/materials')]);
  $('questionCount').textContent=questions.filter(q=>!q.removed).length;
  $('attentionCount').textContent=batches.reduce((n,b)=>n+b.warnings.filter(w=>w.type!=='answer_unlinked').length+b.decisions.filter(d=>d.state==='pending').length+b.fragments.filter(f=>f.state==='unlinked'&&f.warning).length+b.photos.filter(p=>p.state==='failed').length,0);
}
function questionCard(q) {
  return '<article class="item question-card '+(q.removed?'removed':'')+'"><span class="tag status-'+q.latestStatus+'">'+(states[q.latestStatus]||'待确认')+'</span><span class="tag">'+(q.verified?'已核对':'已保存 · 待核对')+'</span>'+(q.everWrong?'<span class="tag">曾做错</span>':'')+(q.removed?'<span class="tag">已移除</span>':'')+'<p class="question-text">'+math(q.content.question||'题干缺失，请对照原图补充')+'</p><p class="muted">'+escape(tags(q).join(' · '))+' · 第 '+escape(q.content.number||'?')+' 题 · '+q.attempts.length+' 次原作答</p><button data-action="question" data-id="'+q.id+'">查看与修改</button></article>';
}
function decisionCard(d,batch) {
  if(d.type==='photo_similarity') {
    const photo=batch.photos.find(p=>p.id===d.photoId);
    return '<section class="decision"><h3>照片看起来相似，请确认</h3><p>'+escape(photo?.name||'本次照片')+' 可能是已有照片的缩放或压缩版本。若有新答案或批改，请继续识别。</p>'+source({photoId:d.photoId,imageUrl:'/api/intake/photos/'+d.photoId+'/image'},'本次照片')+'<button class="primary" data-action="decision" data-id="'+d.id+'" data-resolution="recognize">有新内容，继续识别</button>'+d.candidates.map(c=>'<div class="candidate">'+source({photoId:c.id,imageUrl:'/api/intake/photos/'+c.id+'/image'},'已有相似照片')+'<button data-action="decision" data-id="'+d.id+'" data-resolution="skip" data-photo="'+c.id+'">与这张相同，复用结果</button></div>').join('')+'</section>';
  }
  const raw=d.question||{},content=raw.content||raw;
  return '<section class="decision"><h3>发现可能重复的题目</h3><p class="question-text">'+math(content.question||'')+'</p><p>本次原作答：'+math(raw.studentAnswer||'未识别到文字作答')+'</p>'+source(d.source,'本次题目原图')+'<button data-action="decision" data-id="'+d.id+'" data-resolution="new">这是不同题，单独保存</button>'+d.candidates.map(c=>{
    const q=c.question;if(!q)return '';
    return '<div class="candidate"><strong>已有题目</strong><p>'+math(q.content.question)+'</p><p class="muted">'+(c.kind==='exact'?'题干匹配':'高度疑似')+' · 已有'+q.attempts.length+'次原作答。数值或条件不同请单独保存。</p><details><summary>对照已有来源与作答</summary>'+q.sources.map(s=>source(s)).join('')+q.attempts.map(a=>'<p>'+escape(when(a.createdAt))+' · '+states[a.status]+'：'+math(a.studentAnswer||'见图片')+'</p>').join('')+'</details><button data-action="decision" data-id="'+d.id+'" data-resolution="link" data-question="'+q.id+'">同一道题，新增这次作答</button>'+q.attempts.map((a,i)=>'<button data-action="decision" data-id="'+d.id+'" data-resolution="same_attempt" data-question="'+q.id+'" data-attempt="'+a.id+'">是第'+(i+1)+'次作答重拍，只补来源</button>').join('')+'</div>';
  }).join('')+'</section>';
}
function batchAttention(b) {
  return b.decisions.filter(d=>d.state==='pending').map(d=>decisionCard(d,b)).join('')+b.fragments.filter(f=>f.state==='unlinked'&&f.warning).map(f=>{
    const candidates=b.questions.filter(q=>!q.removed);
    return '<section class="decision"><h3>作答尚未关联 · 第 '+escape(f.number||'?')+' 题</h3><p>'+escape(f.warning)+'</p><p>原作答：'+math(f.studentAnswer||'作答见原图')+'</p>'+source({photoId:f.photoId,imageUrl:'/api/intake/photos/'+f.photoId+'/image',location:f.sourceLocation,bbox:f.bbox},'未关联作答')+(candidates.length?'<form data-form="fragment" data-id="'+f.id+'">'+select('手动指定本批对应题目','questionId',{'':'请选择',...Object.fromEntries(candidates.map(q=>[q.id,(q.content.number||'?')+' · '+q.content.question.slice(0,80)]))},'')+'<button>关联这次作答</button></form>':'<p class="muted">本批没有可关联题目。照片和告警已保留，不搜索历史题目。</p>')+'</section>';
  }).join('');
}
function batchCard(b) {
  return '<article class="item batch-card"><div class="card-heading"><strong>'+escape(when(b.createdAt))+'</strong><span class="tag">'+(stages[b.state]||b.state)+'</span></div><p>'+b.photos.length+' 张照片 · '+b.photos.filter(p=>p.state==='completed').length+' 张处理完成 · '+b.questions.length+' 道题已保存</p><div class="photo-list">'+b.photos.map(p=>'<div class="photo-row"><a href="'+escape(p.imageUrl)+'" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="'+escape(p.imageUrl)+'?preview=1" alt="'+escape(p.name)+'"></a><div><strong>'+escape(p.name)+'</strong><p class="muted">'+(stages[p.state]||p.state)+(p.reused?' · 原图已存在，复用识别结果':'')+'</p>'+(p.error?'<p class="error-text">'+escape(p.error)+'</p>':'')+'<button data-action="evidence" data-id="'+p.id+'">原图与初始识别</button></div></div>').join('')+'</div><div class="actions"><button data-action="batch" data-id="'+b.id+'">查看本批题目</button>'+(b.photos.some(p=>p.state==='failed')||b.state==='partial_failure'?'<button data-action="retry" data-id="'+b.id+'">重试失败部分</button>':'')+'</div>'+b.warnings.filter(w=>w.type!=='answer_unlinked').map(w=>'<p class="notice">'+escape(w.message)+'</p>').join('')+batchAttention(b)+'</article>';
}
function render(){renderContent();restoreDrafts($('chat'));renderPendingCommands();}
function renderContent() {
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('heading').textContent={import:'照片录入',questions:'题目档案',attention:'待处理',review:'复习'}[view];
  $('subheading').textContent=view==='review'?'先独立作答，提交后再批阅':'全部题目自动保存；明确错误有依据，其余可以稍后核对';
  $('uploadEntry').hidden=view!=='import';
  if(view==='review'){void review.home();return;}
  if(view==='import'){$('chat').innerHTML=batches.length?batches.map(batchCard).join(''):'<div class="empty">还没有导入照片。选择这次的照片即可开始。</div>';return;}
  if(view==='attention'){$('chat').innerHTML='<h2>这些地方需要你看一眼</h2><p>其余确定的题目已正常保存。</p>'+(batches.filter(b=>b.decisions.some(d=>d.state==='pending')||b.fragments.some(f=>f.state==='unlinked'&&f.warning)||b.photos.some(p=>p.state==='failed')||b.warnings.some(w=>w.type!=='answer_unlinked')).map(batchCard).join('')||'<div class="empty">目前没有待处理的重复、作答关联或失败任务。</div>');return;}
  const list=questions.filter(q=>(includeRemoved||!q.removed)&&(!statusFilter||q.latestStatus===statusFilter)&&(!tagFilter||tags(q).some(t=>t.includes(tagFilter)))&&(!batchFilter||batches.find(b=>b.id===batchFilter)?.questions.some(other=>other.id===q.id)));
  $('chat').innerHTML='<div class="filters">'+select('作答状态','filterStatus',{'':'全部状态',...states},statusFilter)+input('标签或知识点','filterTag',tagFilter)+'<label class="check"><input name="includeRemoved" type="checkbox" '+(includeRemoved?'checked':'')+'>显示已移除记录</label><button data-action="filter">筛选</button><button data-action="clear-filter">全部题目</button><button class="primary" data-action="add">＋ 补录漏题</button></div>'+(batchFilter?'<p class="notice">当前仅查看所选上传批次的题目。</p>':'')+'<p class="muted">共 '+list.length+' 道题。保存与核对完成分开，状态不代表已经掌握。</p><div class="question-grid">'+list.map(questionCard).join('')+'</div>'+(!list.length?'<div class="empty">没有符合条件的题目。</div>':'');
}
function editorContext(){return {selectionVersion,editorVersion,editSerial,view,selected,dialogOpen:$('editorDialog').open};}
function sameEditor(context){return context.selectionVersion===selectionVersion&&context.editorVersion===editorVersion&&context.editSerial===editSerial&&context.view===view&&context.selected===selected&&context.dialogOpen===$('editorDialog').open;}
function closePanel(){drafts.clear();selected=null;currentQuestion=null;dirty=false;++selectionVersion;$('panel').hidden=true;$('closePanel').hidden=true;}
function mayLeave(){return !dirty||window.confirm('这里有尚未保存的修改，确定放弃这些修改吗？');}
async function navigate(next){if(!mayLeave())return;closePanel();if(next==='questions'){batchFilter='';statusFilter='';tagFilter='';includeRemoved=false;filtersDirty=false;}view=next;$('notice').hidden=true;await load();render();}
function contentFields(c={}) {
  return input('题号','number',c.number)+select('学科','subject',{'':'未分类',数学:'数学',语文:'语文',其他:'其他'},c.subject||'')+input('题干','question',c.question,true)+input('知识点','knowledgePoint',c.knowledgePoint)+input('标签（逗号分隔，可留空）','tags',(c.tags||[]).join('，'))+select('题目完整性','completeness',completeness,c.completeness||'unclear')+input('配图关系说明','diagramDescription',c.diagramDescription,true)+input('共用材料文字','sharedMaterial',c.sharedMaterial,true)+input('原图位置说明','sourceLocation',c.sourceLocation)+(materials.length?'<fieldset><legend>关联已有共用材料</legend>'+materials.map(m=>'<label class="check"><input type="checkbox" name="materialIds" value="'+m.id+'" '+((c.materialIds||[]).includes(m.id)?'checked':'')+'><span>'+escape((m.text||m.description||'共用材料').slice(0,120))+'</span></label>').join('')+'</fieldset>':'');
}
function contentFrom(form,previous={}) {
  const d=new FormData(form),content={...previous};
  for(const k of ['number','subject','question','knowledgePoint','completeness','diagramDescription','sharedMaterial','sourceLocation'])content[k]=String(d.get(k)||'');
  content.tags=String(d.get('tags')||'').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);content.materialIds=d.getAll('materialIds');return content;
}
function teacherFields(t={}){return select('老师批改','mark',marks,t.mark||'unmarked')+input('得分（原样记录）','score',t.score)+input('老师评语与订正','comment',t.comment,true)+input('批改痕迹与位置','evidence',t.evidence,true);}
function teacherFrom(form){const d=new FormData(form);return Object.fromEntries(['mark','score','comment','evidence'].map(k=>[k,String(d.get(k)||'')]));}
function attemptCard(a,i) {
  return '<section class="attempt"><h3>第 '+(i+1)+' 次原作答</h3><p class="muted">'+escape(when(a.createdAt))+' · '+escape(origins[a.statusSource]||a.statusSource)+'</p><form data-form="attempt" data-id="'+a.id+'"><input type="hidden" name="revision" value="'+a.revision+'">'+input('孩子原答案和过程','studentAnswer',a.studentAnswer,true)+teacherFields(a.teacherReview)+select('这次作答状态','status',attemptStates(),a.status)+input('状态修改说明','statusReason',a.statusReason,true)+'<button class="primary">保存这次作答</button></form><details><summary>查看 AI 原始判断与可能错因</summary><p>'+escape(states[a.aiAssessment?.verdict]||'无法判断')+'：'+math(a.aiAssessment?.reason||'')+'</p><p>可观察错误：'+math(a.observedError||'未记录')+'</p><p>可能错因（待确认）：'+math(a.possibleCause||'未提出')+'</p><p>'+escape((a.unclear||[]).join('；'))+'</p></details><details><summary>这次作答的来源</summary>'+a.sources.map(s=>source(s,'原作答来源')).join('')+'</details><details><summary>这次作答的修改记录</summary>'+history(a.history)+'</details></section>';
}
async function showQuestion(id,force=false) {
  if(!force){if(!mayLeave())return;drafts.clear();dirty=false;}const edits=editSerial,dialogVersion=editorVersion,dialogOpen=$('editorDialog').open,version=++selectionVersion,q=await api('/api/intake/questions/'+id);if(version!==selectionVersion||dialogVersion!==editorVersion||dialogOpen!==$('editorDialog').open)return;if(edits!==editSerial){notice('读取期间有新的修改，已保留当前输入；保存后再切换题目。');return;}
  selected=id;currentQuestion=q;dirty=false;$('panel').hidden=false;$('closePanel').hidden=false;$('panelTitle').textContent='第 '+(q.content.number||'?')+' 题 · '+(states[q.latestStatus]||'待确认');
  $('detail').innerHTML=(q.removed?'<div class="notice">此题已移除，来源和历史仍保留。'+(q.redirectId?'<button data-action="question" data-id="'+q.redirectId+'">查看合并后的题目</button>':'')+'</div>':'')+'<span class="tag">'+(q.verified?'已核对':'已保存 · 待核对')+'</span>'+(q.everWrong?'<span class="tag">曾做错</span>':'')+'<div class="math-preview">'+math(q.content.question||'题干缺失，待补充')+'</div><details open><summary>对照原图</summary>'+q.sources.map(s=>source(s)).join('')+(!q.sources.length?'<p class="muted">手动补录题，尚未关联照片。</p>':'')+'</details><form data-form="question" data-id="'+q.id+'"><h3>题目信息</h3><input type="hidden" name="revision" value="'+q.revision+'">'+contentFields(q.content)+'<label class="check"><input name="verified" type="checkbox" '+(q.verified?'checked':'')+'>我已核对题干与必要配图</label><button class="primary">保存题目修改</button></form>'+q.materials.map(m=>'<details><summary>编辑关联共用材料</summary><form data-form="material" data-id="'+m.id+'"><input type="hidden" name="revision" value="'+m.revision+'">'+input('材料文字','text',m.text,true)+input('材料说明','description',m.description,true)+'<button>保存共用材料</button></form><p class="muted">共用此材料的小题一起更新，初始识别保留。</p>'+history(m.history)+'</details>').join('')+'<h3>原作答记录 · '+q.attempts.length+' 次</h3>'+q.attempts.map(attemptCard).join('')+(!q.attempts.length?'<p class="notice">本题没有原作答，不计为做错。</p>':'')+(!q.removed?'<details><summary>＋ 补录一次原作答</summary><form data-form="new-attempt" data-id="'+q.id+'">'+input('孩子原答案和过程','studentAnswer','',true)+teacherFields()+select('作答状态','status',attemptStates(),'pending')+input('状态说明','statusReason')+'<button>保存新增作答</button></form></details><details><summary>整理题目边界</summary><p class="muted">来源与历史继续保留。</p><div class="actions"><button data-action="split" data-id="'+q.id+'">拆分小题</button><button data-action="merge" data-id="'+q.id+'">合并重复题</button><button class="danger" data-action="remove" data-id="'+q.id+'">移除误识别题</button></div></details>':'')+'<details><summary>题目初始记录与修改历史</summary>'+history(q.history)+'</details>';restoreDrafts();
}
function dialog(title,body){++editorVersion;$('dialogTitle').textContent=title;$('dialogBody').innerHTML=body;$('editorDialog').showModal();restoreDrafts($('dialogBody'));}
function openAdd(){dialog('补录漏题','<form data-form="add">'+contentFields()+select('关联来源照片（可不选）','photoId',{'':'不关联照片',...Object.fromEntries([...new Map(batches.flatMap(b=>b.photos).map(p=>[p.id,p])).values()].map(p=>[p.id,p.name]))},'')+'<button class="primary">保存题目</button></form>');}
function openSplit(q){
  dialog('拆分为独立小题','<form data-form="split" data-id="'+q.id+'"><p>用一行“---”分隔小题。其他信息、材料与来源保留。</p>'+input('小题题干，每题之间一行 ---','parts',q.content.question,true)+'<h3>原作答归属</h3><p class="muted">不确定的作答留在原记录，不删除。</p>'+q.attempts.map((a,i)=>select('第'+(i+1)+'次：'+(a.studentAnswer.slice(0,70)||'见图片'),'attempt-'+a.id,{'':'保留在原记录',...Object.fromEntries(Array.from({length:10},(_,n)=>[n+1,'移到第'+(n+1)+'个小题']))},'')).join('')+'<button class="primary">保存拆分</button></form>');
}
function openMerge(q){dialog('合并到当前题目','<form data-form="merge" data-id="'+q.id+'"><p>同一道题才合并，各次作答、材料与来源保留。</p>'+questions.filter(other=>!other.removed&&other.id!==q.id).map(other=>'<label class="check"><input name="questionIds" type="checkbox" value="'+other.id+'"><span>'+escape(other.content.question.slice(0,150)||'题干缺失')+'</span></label>').join('')+'<button class="primary">合并选中的题目</button></form>');}
async function evidence(id){
  const context=editorContext(),p=await api('/api/intake/photos/'+id),e=p.extraction;if(!sameEditor(context))return;
  const records=e?[...(e.questions||[]),...(e.answers||[])]:[];
  dialog('原图与初始识别 · '+p.name,'<a href="'+escape(p.imageUrl)+'" target="_blank" rel="noopener"><img class="evidence-image" decoding="async" src="'+escape(p.imageUrl)+'?preview=1" alt="初始照片"></a><p class="muted">初始识别不会被人工修改覆盖，可与当前题目对照。</p>'+(e?'<p>'+escape([e.paper?.title,e.paper?.subject,e.paper?.grade,e.paper?.pageNumber].filter(Boolean).join(' · '))+'</p>'+records.map(r=>'<section class="item"><p>'+math(evidenceText(r))+'</p></section>').join('')+((e.unclear||[]).length?'<p class="notice">'+escape(e.unclear.join('；'))+'</p>':''):'<p>尚未取得识别结果。原图已保存。</p>'));
}
async function saved(message,id,context,options={}){
  dirty=drafts.size>0;let owned=sameEditor(context);
  if(owned){
    if(options.closeDialog)$('editorDialog').close();
    if(options.archive)view='questions';
    if(options.clearFilters){batchFilter='';statusFilter='';tagFilter='';includeRemoved=false;}
    context=editorContext();
  }
  try{
    await load();
    owned=owned&&sameEditor(context);
    if(!owned){notice(message+' 当前编辑已保留。');return;}
    if(view!=='review')render();
    if(id)await showQuestion(id,true);
    notice(message);
  }catch{notice(message+' 结果已保存，暂时无法刷新；当前未保存修改仍保留。',true);}
  finally{dirty=drafts.size>0;}
}
function recoveryTarget(kind,result){switch(kind){case 'split':return result[0]?.id;case 'new-attempt':return result.questionId;default:return result.id;}}
function commandName(form){return commandIdentity(form.dataset.form,form.dataset.id);}
function lockCommand(form,locked){locked=locked||completedForms.has(form);for(const el of form.querySelectorAll('input,textarea,select')){el.inert=locked;if('readOnly'in el)el.readOnly=locked;}for(const button of form.querySelectorAll('button'))button.disabled=commands.isSending(commandName(form));}
function rememberCommandResult(name,result){for(const form of document.querySelectorAll('form[data-form]'))if(commandName(form)===name){completedForms.set(form,result);lockCommand(form,true);}}
function refreshCommandForms(name){for(const form of document.querySelectorAll('form[data-form]'))if(commandName(form)===name)lockCommand(form,commands.has(name));}
async function command(form,path,payload){
  const name=commandName(form),labels={'new-attempt':'新增原作答',add:'补录漏题',split:'拆分题目',merge:'合并题目'};
  commands.start({kind:form.dataset.form,targetId:form.dataset.id,path,payload,snapshot:formSnapshot(form),label:labels[form.dataset.form]+(currentQuestion?' · '+currentQuestion.content.question.slice(0,50):'')});
  dirty=drafts.size>0;const work=commands.reconcile(name,send);lockCommand(form,true);renderPendingCommands();
  try{const result=await work;rememberCommandResult(name,result);return result;}catch(error){if(commands.has(name))error.message+=' 上次保存结果尚未确认，已保留原内容；可再次保存或通过页面上的确认入口找回原结果。';throw error;}
  finally{refreshCommandForms(name);renderPendingCommands();}
}
function commandCompletion(form,result,context){
  switch(form.dataset.form){
    case 'new-attempt':return saved('新增原作答已保存，旧作答不变。',result.questionId,context);
    case 'add':return saved('补录题目已保存，可以继续补充原作答。',result.id,context,{closeDialog:true,archive:true,clearFilters:true});
    case 'split':return saved('小题已拆分。未分配作答保留在原记录，可显示已移除记录查看。',result[0].id,context,{closeDialog:true,clearFilters:true});
    case 'merge':return saved('题目已合并，各次作答、来源和历史均保留。',result.id,context,{closeDialog:true});
  }
}
async function submitForm(form){
  const type=form.dataset.form,id=form.dataset.id,d=new FormData(form),context=editorContext();
  if(completedForms.has(form))return commandCompletion(form,completedForms.get(form),context);
  switch(type){
    case 'question':await send('/api/intake/questions/'+id,{content:contentFrom(form,currentQuestion.content),verified:d.has('verified'),expectedRevision:Number(d.get('revision'))},'PATCH');return saved('题目信息已保存，初始识别与作答历史仍保留。',id,context);
    case 'attempt':{const old=currentQuestion.attempts.find(a=>a.id===id),reason=d.get('status')!==old.status&&d.get('statusReason')===old.statusReason?'手动修改作答状态':d.get('statusReason');await send('/api/intake/attempts/'+id,{studentAnswer:String(d.get('studentAnswer')),teacherReview:teacherFrom(form),status:d.get('status'),statusReason:reason,expectedRevision:Number(d.get('revision'))},'PATCH');return saved('这次原作答与状态已保存。',context.selected,context);}
    case 'new-attempt':{const result=await command(form,'/api/intake/questions/'+id+'/attempts',{studentAnswer:d.get('studentAnswer'),teacherReview:teacherFrom(form),status:d.get('status'),statusReason:d.get('statusReason')});return commandCompletion(form,result,context);}
    case 'material':await send('/api/intake/materials/'+id,{text:d.get('text'),description:d.get('description'),expectedRevision:Number(d.get('revision'))},'PATCH');return saved('共用材料已保存。',context.selected,context);
    case 'fragment':if(!d.get('questionId'))throw new Error('请选择本批对应题目。');await send('/api/intake/fragments/'+id+'/link',{requestId:key('fragment:'+id),questionId:d.get('questionId')});return saved('已将作答关联到本批题目。',null,context);
    case 'add':{
      const content=contentFrom(form);if(!content.question.trim())throw new Error('请填写题干；残缺题可说明已知部分。');
      const photoId=d.get('photoId'),q=await command(form,'/api/intake/questions',{content,sources:photoId?[{photoId,location:content.sourceLocation}]:[]});
      return commandCompletion(form,q,context);
    }
    case 'split':{
      const texts=String(d.get('parts')).split(/\r?\n\s*---\s*\r?\n/).map(s=>s.trim()).filter(Boolean);if(texts.length<2)throw new Error('至少填写两道小题，用独占一行的 --- 分隔。');
      const parts=texts.map((text,i)=>({content:{...currentQuestion.content,question:text,number:currentQuestion.content.number+'('+(i+1)+')'},sources:currentQuestion.sources,attemptIds:currentQuestion.attempts.filter(a=>Number(d.get('attempt-'+a.id))===i+1).map(a=>a.id)}));
      if(currentQuestion.attempts.some(a=>Number(d.get('attempt-'+a.id))>parts.length))throw new Error('原作答分配的小题不存在。');
      const result=await command(form,'/api/intake/questions/'+id+'/split',{parts});return commandCompletion(form,result,context);
    }
    case 'merge':{
      const questionIds=d.getAll('questionIds');if(!questionIds.length)throw new Error('请至少选择一道需要合并的题。');
      const q=await command(form,'/api/intake/questions/'+id+'/merge',{questionIds});return commandCompletion(form,q,context);
    }
  }
}
async function action(b){
  const a=b.dataset.action,id=b.dataset.id,context=editorContext();
  switch(a){
    case 'recover-command':{
      const pending=commands.get(id);if(!pending||!mayLeave())return;closePanel();const recoveryContext=editorContext();
      const work=commands.reconcile(id,send);renderPendingCommands();
      try{const result=await work;rememberCommandResult(id,result);return await saved('已确认上次保存结果，没有重复新增。',recoveryTarget(pending.kind,result),recoveryContext,{archive:true});}
      finally{renderPendingCommands();}
    }
    case 'question':return showQuestion(id);
    case 'close-panel':if(mayLeave())closePanel();return;
    case 'batch':if(!mayLeave())return;closePanel();batchFilter=id;view='questions';render();return;
    case 'retry':{const result=await send('/api/intake/batches/'+id+'/retry',{});await load();render();if(result.warnings.some(w=>w.type==='upload_interrupted')||result.photos.some(p=>/原图缺失/.test(p.error||''))){recoveryRequestId=result.requestId;notice('请重新选择这批全部原照片，补齐上传后会复用已完成结果。');$('file').click();return;}return notice('已重试失败部分，成功结果继续复用。');}
    case 'decision':await send('/api/intake/decisions/'+id,{action:b.dataset.resolution,...(b.dataset.photo?{photoId:b.dataset.photo}:{}),...(b.dataset.question?{questionId:b.dataset.question}:{}),...(b.dataset.attempt?{attemptId:b.dataset.attempt}:{})});await load();render();return notice('处理选择已保存，其他题目不受影响。');
    case 'filter':filtersDirty=false;statusFilter=document.querySelector('[name=filterStatus]').value;tagFilter=document.querySelector('[name=filterTag]').value.trim();includeRemoved=document.querySelector('[name=includeRemoved]').checked;render();return;
    case 'clear-filter':filtersDirty=false;statusFilter='';tagFilter='';includeRemoved=false;batchFilter='';render();return;
    case 'add':if(!mayLeave())return;closePanel();return openAdd();
    case 'split':if(mayLeave()){drafts.clear();dirty=false;openSplit(currentQuestion);}return;
    case 'merge':if(mayLeave()){drafts.clear();dirty=false;openMerge(currentQuestion);}return;
    case 'remove':if(!window.confirm('移除误识别题？原图、原作答和历史仍保留。'))return;await api('/api/intake/questions/'+id,{method:'DELETE'});return saved('题目已移除，可显示已移除记录查看。',id,context);
    case 'evidence':return evidence(id);
  }
}
async function execute(button,fn){const context=editorContext();if(button)button.disabled=true;try{await fn();}catch(e){const message=e.message+(/已更新/.test(e.message)?' 请先保留当前输入，再重新打开记录核对。':'');notice(message,true);if(sameEditor(context)&&$('editorDialog').open){let box=$('dialogError');if(!box){box=document.createElement('p');box.id='dialogError';box.className='notice error';box.setAttribute('role','alert');$('dialogBody').prepend(box);}box.textContent=message;}}finally{if(button?.isConnected)button.disabled=false;}}
document.addEventListener('input',e=>{if(e.target.closest('.filters')){filtersDirty=true;++editSerial;}});
document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)void execute(b,()=>action(b));});
document.addEventListener('submit',e=>{const form=e.target;if(!form.dataset.form){if(form.closest('#editorDialog')&&!mayLeave())e.preventDefault();return;}e.preventDefault();void execute(e.submitter,async()=>{const id=draftKey(form),d=drafts.get(id);drafts.delete(id);try{await submitForm(form);}catch(error){if(d&&!commands.has(commandName(form)))drafts.set(id,d);dirty=drafts.size>0;throw error;}});});
document.addEventListener('input',captureDraft);document.addEventListener('change',captureDraft);
$('editorDialog').addEventListener('cancel',e=>{if(!mayLeave())e.preventDefault();});
$('editorDialog').addEventListener('close',()=>{for(const form of $('dialogBody').querySelectorAll('form[data-form]'))drafts.delete(draftKey(form));dirty=drafts.size>0;});
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{void execute(b,()=>navigate(b.dataset.view));});
$('closePanel').onclick=()=>{if(mayLeave())closePanel();};$('open').onclick=()=>{recoveryRequestId=null;$('file').click();};
$('file').addEventListener('cancel',()=>{recoveryRequestId=null;});
async function upload(){
  if(!uploadPending||uploading)return;uploading=true;$('open').disabled=true;$('retryUpload').hidden=true;$('uploadStatus').textContent='正在保存'+uploadPending.files.length+'张照片并检查重复……';
  try{const form=new FormData();form.append('requestId',uploadPending.requestId);for(const file of uploadPending.files)form.append('photos',file,file.name);await api('/api/intake/batches',{method:'POST',body:form});uploadPending=null;$('uploadStatus').textContent='原图已保存，可在下方查看每张照片进度，结果自动保存。';await load();if(view!=='review')render();}
  catch(e){$('retryUpload').hidden=false;notice(e.message+' 上传结果可能尚未确认，请先查看批次进度；重试使用同一请求，不重复创建批次。',true);}
  finally{uploading=false;$('open').disabled=false;}
}
$('retryUpload').onclick=()=>{void upload();};
$('file').onchange=async()=>{
  const requestId=recoveryRequestId||crypto.randomUUID();recoveryRequestId=null;
  const files=Array.from($('file').files);$('file').value='';if(!files.length||uploading)return;
  if(files.length>30||files.some(f=>f.size>15*1024*1024)){notice('一次最多30张照片，每张不超过15MB。',true);return;}
  $('uploadStatus').textContent='正在读取'+files.length+'张照片……';$('open').disabled=true;
  try{uploadPending={requestId,files};view='import';await upload();}
  catch(e){notice(e.message,true);}finally{$('open').disabled=false;}
};
async function poll(){if(refreshing)return;refreshing=true;try{if(batches.some(b=>b.state==='processing'||b.photos.some(p=>['queued','processing','saving'].includes(p.state)))){await load();if(!filtersDirty&&!$('editorDialog').open&&view!=='review')render();}}catch{notice('暂时无法读取处理进度，后台可能仍在继续，无需重复上传。',true);}finally{refreshing=false;}}
setInterval(()=>{void poll();},1800);
window.addEventListener('beforeunload',e=>{if(dirty||commands.size){e.preventDefault();e.returnValue='';}});
const boxes=new MutationObserver(()=>{document.querySelectorAll('.source-box[data-box]').forEach(el=>{if(el.style.left)return;const b=JSON.parse(el.dataset.box);el.style.left=Math.max(0,b.x)*100+'%';el.style.top=Math.max(0,b.y)*100+'%';el.style.width=Math.min(1,b.width)*100+'%';el.style.height=Math.min(1,b.height)*100+'%';});});boxes.observe(document.body,{childList:true,subtree:true});
try{await load();render();}catch(e){notice(e.message,true);}
try{const s=await api('/api/status');$('connection').textContent=s.loggedIn?'● 本机 Codex 已连接':'需要登录 Codex';}catch{$('connection').textContent='本机连接暂不可用';}

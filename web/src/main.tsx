import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { HerdrPanel } from './herdr-panel';
import { CreateWork } from './create-work';
import { latestProjectReport } from './project-report';
import { snapshotRefresh, watchVisibleRefresh, type SnapshotFreshness } from './refresh';

import { goalWorkLinks, taskNoticeKey, hiddenLocalWork, pinLocalVisibility, localVisibilityRequest, type LocalVisibilityTarget, previousBlockedAttempts, type Project, type Task, creationProjectName, parseWorkFragment, workItemLink, workLinkIntent, pinNewAttempt, newAttemptRequest, type NewAttemptTarget, canNameProject, projectName, validProjectName, taskProjectLabel, taskProjectView, workProjectGroups, projectWorkCounts, taskBadge, pending, answered, needsDecision, evidenceLink, evidenceOrigin, evidenceExcerpt, taskOrigin, shellArgument, loopbackCLIAddress, canContinueCodex, codexRunCommand, type WorkFilter, matchesWorkFilter, matchesWorkView, hiddenActiveSearchCount, matchesTaskSearch, hasWorkIssue, workIssueLabel, activeWork, endedLocalFollowUp, localFollowUpMarker, localFollowUpRequest, pinRowFollowUp, rowFollowUpRequest, pendingDeliveryReview, pinDeliveryReview, deliveryReviewRequest, deliveryHandoffText, type DeliveryReviewTarget, currentReadyReportID, reviewedDelivery, previousDeliveryEvidence, previousEvidenceUnretained, reviewEvidencePreview, codexStartObservation, taskSummary, codexLaunchNotice, codexTaskBrief, codexTaskBriefCommand } from './model';
const stamp=(v:string)=>{const d=new Date(v);return Number.isNaN(d.valueOf())?'尚未观察':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})};
async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{const res=await fetch('/api'+path,{signal,cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(!res.ok){const err=await res.json().catch(()=>({error:`请求失败 (${res.status})`}));throw new Error(err.error||'请求失败')}return res.json()}
function Badge({task}:{task:Task}){const [label,tone]=taskBadge(task);return <span className={'badge '+tone}>{label}</span>}
function ReviewEvidence({task}:{task:Task}){
 const preview=reviewEvidencePreview(task);
 if(!preview)return null;
 return <div className="review-evidence"><strong>交付证据 · {preview.count} 项</strong>{preview.excerpt?<p>{preview.excerpt}</p>:<p>{preview.count?'未提供内联摘录，打开详情查看引用。':'尚无交付证据，需打开详情核实。'}</p>}<small>{preview.origin||'执行者填报 · 未独立核验'}</small></div>;
}
function TaskBrief({task}:{task:Task}){
 const brief=codexTaskBrief(task),text=useRef<HTMLTextAreaElement>(null);
 const [status,setStatus]=useState(''),[copying,setCopying]=useState(false);
 useEffect(()=>{setStatus('')},[brief]);
 if(!brief)return null;
 async function copy(){
  if(copying||!brief)return;
  setCopying(true);setStatus('');
  try{await navigator.clipboard.writeText(brief);setStatus('已复制说明。仅用于下方自定义标准输入模式，可先编辑。')}
  catch{text.current?.focus();text.current?.select();setStatus('未能自动复制。请手动复制上方已选中的任务说明。')}
  finally{setCopying(false)}
 }
 return <div className="task-brief"><label>任务说明（已保存的标题、目标 + 默认交付要求）<textarea ref={text} readOnly rows={8} value={brief}/></label><button type="button" disabled={copying} onClick={()=>void copy()}>{copying?'复制中…':'复制任务说明'}</button><small role="status">{status||'先核对这份说明。上方 -use-task-brief 命令会直接使用它，无需再粘贴；要编辑本次输入，请用下方自定义模式。'}</small></div>;
}
function TaskBriefCommand({task,address}:{task:Task;address:string}){
 const command=codexTaskBriefCommand(task,address),text=useRef<HTMLElement>(null);
 const [status,setStatus]=useState(''),[copying,setCopying]=useState(false);
 useEffect(()=>{setStatus('')},[command]);
 if(!command)return null;
 async function copy(){
  if(copying||!command)return;
  setCopying(true);setStatus('');
  try{await navigator.clipboard.writeText(command);setStatus('已复制命令。先确认当前目录，再在终端手动运行。')}
  catch{if(text.current){const range=document.createRange();range.selectNodeContents(text.current);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range)}setStatus('未能自动复制。请手动复制上方已选中的命令。')}
  finally{setCopying(false)}
 }
 return <div><code ref={text}>{command}</code><button type="button" disabled={copying} onClick={()=>void copy()}>{copying?'复制中…':'复制使用已存说明的命令'}</button><small role="status">{status||'显式使用下方已存任务说明，不再等待标准输入；不改变目录、沙箱或授权。'}</small></div>;
}
function WorkItemLink({task}:{task:Task}){
 const link=workItemLink(window.location,task),text=useRef<HTMLInputElement>(null);
 const [manual,setManual]=useState(false),[copying,setCopying]=useState(false),[status,setStatus]=useState('');
 useEffect(()=>{if(manual){text.current?.focus();text.current?.select()}},[manual]);
 if(!link)return null;
 async function copy(){
  if(copying||!link)return;
  setCopying(true);setStatus('');
  try{await navigator.clipboard.writeText(link);setStatus('链接已复制。')}
  catch{setManual(true);text.current?.focus();text.current?.select();setStatus('自动复制不可用，请手动复制选中的链接。')}
  finally{setCopying(false)}
 }
 return <div className="work-item-link"><button type="button" disabled={copying} onClick={()=>void copy()}>{copying?'复制中…':'复制事项链接'}</button>{manual&&<input ref={text} readOnly aria-label="事项链接" value={link}/>}<small role="status">{status}</small></div>;
}
function EvidenceItems({task}:{task:Task}){return <>{task.evidence?.length?task.evidence.map((e,i)=><div className="evidence" key={i}><span>↳</span><div className="evidence-content"><strong>{e.label?.trim()||(evidenceExcerpt(e)?'内联证据':'未提供可审阅内容')}</strong><small className="evidence-origin">{evidenceOrigin(e)}</small>{evidenceExcerpt(e)&&<p className="evidence-excerpt">{evidenceExcerpt(e)}</p>}{evidenceLink(e)?<a href={evidenceLink(e)} target="_blank" rel="noopener noreferrer">打开证据 ↗</a>:e.url?<><code>{e.url}</code><small>仅显示引用，不会读取本地文件或自动打开。</small></>:null}</div></div>):<p className="muted">还没有交付证据。不会因为 Agent 说完成就标为已交付。</p>}</>}
function CurrentEvidence({task}:{task:Task}){
 if(task.status==='needs_evidence'&&task.evidence?.length)return <details className="detail-section unconfirmed-evidence"><summary>记录中的证据 · 本次有效性未确认 · {task.evidence.length}</summary><p className="muted">这些内容尚未确认为本次有效交付证据，不用于待审或已查看。</p><EvidenceItems task={task}/></details>;
 return <section className="detail-section"><h3>交付证据 <span>{task.evidence?.length||0}</span></h3><EvidenceItems task={task}/></section>;
}
function DeliveryHandoff({task,target}:{task:Task;target:DeliveryReviewTarget|undefined}){
 const current=deliveryHandoffText(task,target),[preview]=useState(()=>current);
 const text=useRef<HTMLTextAreaElement>(null),latest=useRef(current);
 latest.current=current;
 const [status,setStatus]=useState(''),[copying,setCopying]=useState(false);
 const valid=preview!==undefined&&current===preview;
 if(preview===undefined&&!currentReadyReportID(task))return null;
 async function copy(){
  if(!valid||!preview||copying)return;
  setCopying(true);setStatus('');
  try{await navigator.clipboard.writeText(preview);if(latest.current===preview)setStatus('已复制本次交付文本。请自行选择交接对象和相关内容；不会自动提交。')}
  catch{if(latest.current===preview){text.current?.focus();text.current?.select();setStatus('未能自动复制。请手动复制上方已选中的本次交付文本。')}}
  finally{setCopying(false)}
 }
 return <details className="detail-section handoff-material"><summary>交接材料</summary>{valid?<><p className="muted">仅包含本次交付的填报文本，未独立核验。先核对预览；不会添加目标、引用地址、内部标识或历史材料，不会传输文件或自动提交。</p><label>本次交付文本<textarea ref={text} readOnly rows={10} value={preview}/></label>{Array.from(preview!).length>2000&&<p className="muted">材料超过 2,000 字符，不要整段粘贴到「目标与边界」。请选择相关摘录，或使用现有的自定义标准输入。</p>}</>:<p className="muted" role="status">交付已更新，或未在打开时定位到有效的本次交付。请关闭详情，重新打开核对后再复制。</p>}<button type="button" disabled={!valid||copying} onClick={()=>void copy()}>{copying?'复制中…':'复制本次交付'}</button>{valid&&<small role="status">{status||'保留摘录原文，不是文件或字节归档。链接请在原工作查看。'}</small>}</details>;
}
function PreviousEvidence({task}:{task:Task}){
 const previous=previousDeliveryEvidence(task),unretained=previousEvidenceUnretained(task);
 if(!previous)return unretained?<details key={`${task.id}:${unretained.report_event_id}`} className="detail-section previous-evidence"><summary>上一份交付证据 · 未保留</summary><p className="muted">上一份超出保存上限，未保留。这里没有旧证据副本，不影响当前交付或查看状态。</p></details>:null;
 const omitted=previous.total_count-previous.evidence.length;
 return <details key={`${task.id}:${previous.report_event_id}`} className="detail-section previous-evidence"><summary>上一份交付证据 · 历史</summary><p className="muted">仅保留上一份回报的有限快照，不是当前交付，不参与本次已查看、待审或本地跟进判断；来源仍为填报，未独立核验。</p><small>原回报 <code>{previous.report_event_id}</code> · <time dateTime={previous.reported_at}>{new Date(previous.reported_at).toLocaleString('zh-CN',{hour12:false})}</time></small><small>来源（填报）：{previous.origin||'未说明'}</small>{previous.summary&&<p>{previous.summary}{previous.summary_truncated?'（摘要已截短）':''}</p>}<p className="muted">保留 {previous.evidence.length} / {previous.total_count} 项{omitted?`；受保存上限限制，另 ${omitted} 项未保留。`:'。'}</p>{previous.evidence.map((e,i)=><div className="evidence" key={i}><span>↳</span><div className="evidence-content"><strong>{e.label?.trim()||(evidenceExcerpt(e)?'历史内联证据':'历史引用')}</strong><small className="evidence-origin">{evidenceOrigin(e)}</small>{evidenceExcerpt(e)&&<p className="evidence-excerpt">{evidenceExcerpt(e)}</p>}{evidenceLink(e)?<a href={evidenceLink(e)} target="_blank" rel="noopener noreferrer">打开历史引用 ↗</a>:e.url?<><code>{e.url}</code><small>仅显示历史引用，不会读取本地文件或自动打开。</small></>:null}</div></div>)}</details>;
}
function GoalText({task,tasks,onNavigate}:{task:Task;tasks:Task[];onNavigate:(id:string)=>void}){
 return <p className="detail-goal">{goalWorkLinks(task.goal,window.location).map((part,index)=>part.taskID&&tasks.some(item=>item.id===part.taskID&&item.source==='local'&&item.project_id!=='demo')?<a key={index} href={'#work='+encodeURIComponent(part.taskID)} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onNavigate(part.taskID!)}}>{part.text}</a>:<React.Fragment key={index}>{part.text}</React.Fragment>)}</p>;
}
function PreviousBlocked({task}:{task:Task}){
 const previous=previousBlockedAttempts(task);
 return <>{previous.map(attempt=>{const report=task.events.find(event=>event.id===attempt.report_event_id&&event.run_id===attempt.run_id)!;return <details className="detail-section previous-evidence" key={attempt.run_id}><summary>上一尝试受阻记录 · 历史</summary><p className="muted">原生首轮已开始后的受阻快照，不是本次进展或交付；保留填报原文，未独立核验。</p><small>原执行 <code>{attempt.run_id}</code> · 首轮开始于 <time dateTime={attempt.codex_start.observed_at}>{new Date(attempt.codex_start.observed_at).toLocaleString('zh-CN',{hour12:false})}</time> · 受阻回报 <time dateTime={report.created_at}>{new Date(report.created_at).toLocaleString('zh-CN',{hour12:false})}</time> · {report.origin}</small><p>{report.message}</p><EvidenceItems task={{...task,evidence:attempt.evidence}}/></details>})}</>;
}
function ProjectNameEditor({task,busy,onSave,drafts}:{task:Task;busy:boolean;onSave:(name:string)=>Promise<Task>;drafts:Map<string,string>}){
 // A draft belongs to this explicit drawer open. Polling must never replace it.
 const [draft,setDraft]=useState(drafts.get(task.id)??task.project_name??''),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);
 const submitting=useRef(false);
 async function save(name:string){
  if(submitting.current||busy||!validProjectName(name))return;
  submitting.current=true;setSaving(true);setMessage('');setFailed(false);
  try{const next=await onSave(name.trim());setDraft(next.project_name||'');drafts.set(task.id,next.project_name||'');setMessage('项目名已保存；只改变本地分组，不改变执行或交付状态。')}
  catch(e){setFailed(true);setMessage('未能确认保存：'+(e as Error).message+'。请先刷新核实。')}
  finally{submitting.current=false;setSaving(false)}
 }
 return <details className="project-name-editor"><summary>修改项目名</summary><form onSubmit={e=>{e.preventDefault();void save(draft)}}><fieldset disabled={busy||saving}><label>项目名（可选）<input maxLength={120} value={draft} onChange={e=>{setDraft(e.target.value);drafts.set(task.id,e.target.value);setMessage('')}} placeholder="留空为未归类"/></label><small>当前已保存：{projectName(task)||'未归类'}。最多 60 字；输入不会被刷新替换。</small>{!validProjectName(draft)&&<small role="alert">项目名请控制在 60 字以内。</small>}<div><button type="submit" disabled={!validProjectName(draft)||draft.trim()===projectName(task)}>{saving?'保存中…':'保存项目名'}</button><button type="button" disabled={!projectName(task)} onClick={()=>void save('')}>清除项目名</button></div></fieldset></form>{message&&<p role={failed?'alert':'status'}>{message}</p>}</details>;
}
function App(){
 const [projects,setProjects]=useState<Project[]>([]),[tasks,setTasks]=useState<Task[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null),[view,setView]=useState('overview'),[filter,setFilter]=useState<WorkFilter>('active'),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[answer,setAnswer]=useState('');
 const taskSnapshots=useRef<Task[]>(tasks);taskSnapshots.current=tasks;
 const projectDrafts=useRef(new Map<string,string>()),answerDrafts=useRef(new Map<string,string>()),selectedRef=useRef<string|null>(null);
 const noticeScope=useRef('');
 const [visibilityTarget,setVisibilityTarget]=useState<LocalVisibilityTarget|undefined>();
 const [reviewTarget,setReviewTarget]=useState<DeliveryReviewTarget|undefined>();
 const [attemptTarget,setAttemptTarget]=useState<NewAttemptTarget|undefined>(),[confirmStopped,setConfirmStopped]=useState(false),[attemptUncertain,setAttemptUncertain]=useState(false);
 const [freshness,setFreshness]=useState<SnapshotFreshness>({lastSuccessAt:null,stale:false});
 const [endingRow,setEndingRow]=useState<string|null>(null),[listNotice,setListNotice]=useState<{text:string;error:boolean}|null>(null);
 const rowDetails=useRef(new Map<string,HTMLButtonElement>()),rowFocus=useRef<{trigger:HTMLButtonElement;taskID:string;neighborID?:string}|null>(null);
 const workSection=useRef<HTMLElement>(null),newAttemptFocus=useRef<string|null>(null);
 const pendingWorkLink=useRef(workLinkIntent());
 const reads=useRef<ReturnType<typeof snapshotRefresh<[Project[],Task[]]>>|null>(null),mutating=useRef(false);
 const cliAddress=loopbackCLIAddress(window.location);
 const closeRef=useRef<HTMLButtonElement>(null); const active=tasks.find(t=>t.id===selected); const needs=tasks.filter(t=>needsDecision(t));
 function refresh(){return reads.current?.refresh()}
 useEffect(()=>{
  const reader=snapshotRefresh<[Project[],Task[]]>({load:signal=>Promise.all([api<Project[]>('/projects',undefined,signal),api<Task[]>('/tasks',undefined,signal)]),apply:([p,t])=>{setProjects(p);setTasks(t);const linked=pendingWorkLink.current.consume(t);if(linked.kind==='found'){setListNotice(null);open(linked.task,false)}else if(linked.kind==='missing'){selectedRef.current=null;setSelected(null);setListNotice({text:'当前工作台未找到此本地事项。请核对链接和工作台地址。',error:true})}},loading:setLoading,error:setError,freshness:setFreshness,canRefresh:()=>!mutating.current});
  const followWorkFragment=()=>{
   setListNotice(null);const id=parseWorkFragment(window.location.hash);
   const known=id&&taskSnapshots.current.find(task=>task.id===id&&task.source==='local'&&task.project_id!=='demo');
   if(known){open(known,false);return}
   if(pendingWorkLink.current.navigate(window.location.hash))void reader.refresh();
   else{selectedRef.current=null;setSelected(null);setNotice('')}
  };
  reads.current=reader;pendingWorkLink.current.navigate(window.location.hash);void reader.refresh();
  window.addEventListener('hashchange',followWorkFragment);window.addEventListener('popstate',followWorkFragment);
  const stop=watchVisibleRefresh(()=>void reader.refresh(true));
  return()=>{stop();window.removeEventListener('hashchange',followWorkFragment);window.removeEventListener('popstate',followWorkFragment);reader.dispose();reads.current=null};
 },[]);
 // Keep a draft choice through refreshes of the same question, not across a new run/question.
 const decisionKey=JSON.stringify([active?.id,active?.run_id,active?.decision]);
 useEffect(()=>{setAnswer(answerDrafts.current.get(decisionKey)||'')},[decisionKey]);
 useEffect(()=>{if(selected){const trigger=document.activeElement as HTMLElement;closeRef.current?.focus();const previous=document.body.style.overflow;document.body.style.overflow='hidden';const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!mutating.current)closeDetail();if(e.key==='Tab'){const nodes=Array.from(document.querySelectorAll<HTMLElement>('.detail button:not(:disabled), .detail input:not(:disabled), .detail textarea:not(:disabled), .detail a, .detail summary'));const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener('keydown',escape);return()=>{document.body.style.overflow=previous;document.removeEventListener('keydown',escape);if(trigger?.isConnected)trigger.focus();else workSection.current?.focus()}}},[selected]);
 function showWorkFilter(next:'review'|'issues'){setFilter(next);setQuery('');workSection.current?.focus({preventScroll:true});workSection.current?.scrollIntoView({block:'start'})}
 function closeDetail(){pendingWorkLink.current.cancel();if(parseWorkFragment(window.location.hash))window.history.pushState(window.history.state,'',window.location.pathname+window.location.search);selectedRef.current=null;setSelected(null);setReviewTarget(undefined);setAttemptTarget(undefined);setVisibilityTarget(undefined);setConfirmStopped(false);setAttemptUncertain(false);setNotice('')}
 function open(t:Task,pushHistory=true){
  pendingWorkLink.current.cancel();
  if(pushHistory&&parseWorkFragment(window.location.hash)!==t.id)window.history.pushState(window.history.state,'',window.location.pathname+window.location.search+'#work='+encodeURIComponent(t.id));
  if(selectedRef.current===t.id)return;
  selectedRef.current=t.id;setSelected(t.id);setReviewTarget(pinDeliveryReview(t));setAttemptTarget(pinNewAttempt(t));setVisibilityTarget(pinLocalVisibility(t));setConfirmStopped(false);setAttemptUncertain(false);setAnswer(answerDrafts.current.get(JSON.stringify([t.id,t.run_id,t.decision]))||'');setNotice('');
 }
 function navigateToWork(id:string){
  if(mutating.current)return;
  const task=tasks.find(task=>task.id===id&&task.source==='local'&&task.project_id!=='demo');
  if(task){setListNotice(null);open(task);return}
  window.history.pushState(window.history.state,'',window.location.pathname+window.location.search+'#work='+encodeURIComponent(id));pendingWorkLink.current.navigate(window.location.hash);void refresh();
 }
 async function changeVisibility(task:Task,target:LocalVisibilityTarget|undefined,operation:'hide'|'restore',trigger?:HTMLButtonElement){
  if(mutating.current)return;
  const request=localVisibilityRequest(task,target,operation);if(!request)return;
  if(trigger){const index=visible.findIndex(item=>item.id===task.id);rowFocus.current={trigger,taskID:task.id,neighborID:(visible[index+1]||visible[index-1])?.id}}
  mutating.current=true;reads.current?.invalidate();setBusy(true);setNotice('');setListNotice(null);
  try{const next=await api<Task>(`/tasks/${encodeURIComponent(task.id)}/local-visibility`,request);setTasks(old=>old.map(item=>item.id===next.id?next:item));if(selectedRef.current===task.id)setVisibilityTarget(pinLocalVisibility(next));}
  catch(error){const text='未能确认本地显示设置：'+(error as Error).message+'。请刷新核实后再操作。';if(trigger)setListNotice({text,error:true});else{noticeScope.current=taskNoticeKey(task);setNotice(text)}}
  finally{mutating.current=false;setBusy(false)}
 }
 async function mutate(action:'decisions'|'follow-up'|'review-delivery'|'local-follow-up',operation?:'end'|'resume'){if(!active||mutating.current)return;const reviewRequest=action==='review-delivery'?deliveryReviewRequest(active,reviewTarget):action==='local-follow-up'&&operation?localFollowUpRequest(active,reviewTarget,operation):undefined;if((action==='review-delivery'||action==='local-follow-up')&&!reviewRequest)return;mutating.current=true;reads.current?.invalidate();setBusy(true);setNotice('');try{const next=await api<Task>(`/tasks/${encodeURIComponent(active.id)}/${action}`,{run_id:active.run_id,...(action==='decisions'?{answer,decision:active.decision}:(action==='review-delivery'||action==='local-follow-up')?reviewRequest:{})});setTasks(old=>old.map(t=>t.id===next.id?next:t));noticeScope.current=taskNoticeKey(next);setNotice(action==='local-follow-up'?(operation==='end'?'已结束这次本地跟进；记录仍保留在「全部」。这不是完成、验收或合并、部署授权。':'已恢复这次本地跟进；原查看标记保留，不启动执行。'):action==='review-delivery'?'已记录本次交付已查看。仅移出这次待审，不代表验收、完成或独立核验；新的交付回报仍会再次待审。':action==='follow-up'?'已记录一次补交要求，仍待有效证据；不会启动或自动通知 Agent。':'已保存到原执行的指令记录。保存本身不证明送达或 Agent 已继续；回执与进展会随记录刷新。');if(selectedRef.current===active.id){answerDrafts.current.delete(JSON.stringify([active.id,active.run_id,active.decision]));setAnswer('')}}catch(e){noticeScope.current=taskNoticeKey(active);setNotice('未能确认保存：'+(e as Error).message+'。请先刷新核实，不要重复发送。')}finally{mutating.current=false;setBusy(false)}}
 async function prepareNewAttempt(){
  if(!active||mutating.current||attemptUncertain)return;
  const target=attemptTarget,request=newAttemptRequest(active,target,confirmStopped);
  if(!target||!request)return;
  mutating.current=true;reads.current?.invalidate();setBusy(true);setNotice('');
  try{
   const next=await api<Task>(`/tasks/${encodeURIComponent(target.task_id)}/new-attempt`,request);
   setTasks(old=>old.map(task=>task.id===next.id?next:task));if(selectedRef.current===target.task_id){setAttemptTarget(undefined);setConfirmStopped(false);setReviewTarget(undefined);newAttemptFocus.current=target.task_id;setVisibilityTarget(pinLocalVisibility(next));setNotice('')};
  }catch(e){noticeScope.current=taskNoticeKey(active);if(selectedRef.current===target.task_id){setAttemptUncertain(true);setConfirmStopped(false)}setNotice('未能确认新尝试已保存：'+(e as Error).message+'。请刷新核实后重新打开详情，不要重复提交。')}
  finally{mutating.current=false;setBusy(false)}
 }
 async function saveProjectName(task:Task,name:string):Promise<Task>{
  if(mutating.current)throw new Error('请等待当前保存完成');
  mutating.current=true;reads.current?.invalidate();setBusy(true);
  try{const next=await api<Task>(`/tasks/${encodeURIComponent(task.id)}/project-name`,{project_name:name});setTasks(old=>old.map(item=>item.id===next.id?next:item));return next}
  finally{mutating.current=false;setBusy(false)}
 }
 function showProject(key:string){setView(key);setFilter('active');setQuery('');workSection.current?.focus({preventScroll:true})}
 async function endRow(task:Task,trigger:HTMLButtonElement){
  if(mutating.current)return;
  // Capture all identifiers and versions synchronously from this clicked row.
  const target=pinRowFollowUp(task),request=rowFollowUpRequest(task,target);
  if(!target||!request)return;
  const index=visible.findIndex(item=>item.id===task.id);
  rowFocus.current={trigger,taskID:target.task_id,neighborID:(visible[index+1]||visible[index-1])?.id};
  mutating.current=true;reads.current?.invalidate();setBusy(true);setEndingRow(task.id);setListNotice(null);
  try{
   const next=await api<Task>(`/tasks/${encodeURIComponent(target.task_id)}/local-follow-up`,request);
   setTasks(old=>old.map(item=>item.id===next.id?next:item));
   setListNotice({text:`「${task.title}」已结束本地跟进；仍在「全部」，可打开详情恢复。不代表完成或验收。`,error:false});
  }catch(e){setListNotice({text:'未能确认结束本地跟进：'+(e as Error).message+'。请先刷新核实，不要重复发送。',error:true})}
  finally{mutating.current=false;setBusy(false);setEndingRow(null)}
 }
 useEffect(()=>{
  if(newAttemptFocus.current&&!busy){const taskID=newAttemptFocus.current;newAttemptFocus.current=null;if(selectedRef.current===taskID)document.querySelector<HTMLElement>('.detail .start-help>summary')?.focus()}
  const pendingFocus=rowFocus.current;
  if(!pendingFocus||busy)return;
  rowFocus.current=null;
  if(selectedRef.current)return;
  // Do not steal focus if the operator navigated elsewhere while saving.
  if(document.activeElement!==pendingFocus.trigger&&document.activeElement!==document.body)return;
  const next=rowDetails.current.get(pendingFocus.taskID)||rowDetails.current.get(pendingFocus.neighborID||'')||workSection.current?.querySelector<HTMLButtonElement>('.work:not(:disabled)')||workSection.current;
  next?.focus();
 },[tasks,busy]);
 const visible=tasks.filter(t=>matchesWorkView(t,view)&&matchesWorkFilter(t,filter)&&matchesTaskSearch(t,query)).sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at));
 const hiddenMatches=hiddenActiveSearchCount(tasks,view,filter,query);
 const groups=workProjectGroups(tasks,projects),scopedGroup=groups.find(group=>group.key===view);
 const isGroupView=view.startsWith('project-name:')||view.startsWith('legacy-project:')||view==='source-demo';
 const createProjectName=creationProjectName(view);
 return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">↗</span> 工作台</div><nav aria-label="主导航">{[['overview','总览','◫'],['attention','需要我决定','◇'],['decisions','已留的决定','↳']].map(([id,label,icon])=><button key={id} className={view===id?'nav active':'nav'} onClick={()=>{setView(id);setFilter('active')}}><span>{icon}</span>{label}{id==='attention'&&needs.length>0&&<b>{needs.length}</b>}</button>)}</nav><p className="nav-label">项目</p>{groups.map(group=><button className={view===group.key?'nav active':'nav'} key={group.key} onClick={()=>showProject(group.key)}><span className="project-dot"/>{group.name}{group.kind==='demo'?' · 演示':group.kind==='legacy'?' · 历史':''}</button>)}<div className="sidebar-foot">本地记录</div></aside>
 <main><header className="top"><div><h1>{view==='attention'?'待决定':view==='decisions'?'决定记录':view==='overview'?'工作台':scopedGroup?.name||'项目工作'}</h1>{isGroupView&&<button type="button" className="back-overview" onClick={()=>{setView('overview');setFilter('active');workSection.current?.focus({preventScroll:true})}}>← 全部项目总览</button>}</div><button onClick={()=>void refresh()} disabled={loading} className="refresh">{loading?'读取中…':'↻ 刷新'}</button></header>
 {tasks.some(t=>t.project_id==='demo')&&<p className="demo-boundary">当前数据库含合成演示。实际使用请另选空白 -db 并移除 -demo；不能在此创建真实工作。</p>}
 {error&&(freshness.stale&&freshness.lastSuccessAt!==null?<div className="read-stale" role="status"><span>读取失败，显示上次记录 · 上次读取 <time dateTime={new Date(freshness.lastSuccessAt).toISOString()}>{new Date(freshness.lastSuccessAt).toLocaleString('zh-CN',{hour12:false})}</time></span><button type="button" onClick={()=>void refresh()} disabled={loading}>重新读取</button></div>:<div className="error" role="alert">读取失败：{error}。暂无可验证的数据，请确认本地服务已启动后刷新。</div>)}
 {!loading&&!error&&tasks.length===0&&<div className="empty">暂无工作。点击「新建工作」记录目标。</div>}
 {view==='overview'&&tasks.length>0&&<><section className="overview-counts" aria-label="工作状态"><div aria-label={`在办 ${tasks.filter(activeWork).length} 件，本地跟进数，不代表正在执行`}><span>在办跟进</span><b>{tasks.filter(activeWork).length}</b></div><button type="button" onClick={()=>{setView('attention');setFilter('active');setQuery('');workSection.current?.focus({preventScroll:true});workSection.current?.scrollIntoView({block:'start'})}} aria-label={`查看待决定，${needs.length} 件`}><span>待决定</span><b>{needs.length}</b></button><button type="button" onClick={()=>showWorkFilter('issues')} aria-label={`查看受阻、待补与启动问题，${tasks.filter(hasWorkIssue).length} 件`}><span>{workIssueLabel}</span><b>{tasks.filter(hasWorkIssue).length}</b></button><button type="button" onClick={()=>showWorkFilter('review')} aria-label={`查看待审交付，${tasks.filter(pendingDeliveryReview).length} 件`}><span>待审交付</span><b>{tasks.filter(pendingDeliveryReview).length}</b></button><div title="已记录的指令，尚未确认送达；不代表已执行" aria-label={`指令待回执 ${tasks.filter(t=>pending(t)).length} 条，已记录但未确认送达，不代表已执行`}><span>指令待回执</span><b>{tasks.filter(t=>pending(t)).length}</b></div></section><div className="section-heading"><h2>项目</h2></div><section className="projects">{groups.map(group=>{const counts=projectWorkCounts(group.items),report=latestProjectReport(group);return <button key={group.key} className="project-card" onClick={()=>showProject(group.key)}><div className="project-top"><h3>{group.name}</h3><span>{group.kind==='demo'?'合成演示':group.kind==='legacy'?'历史':'↗'}</span></div><div className="project-bottom"><span>在办 <b>{counts.active}</b></span><span>待定 {counts.decision}</span><span>{workIssueLabel} {counts.issues}</span><span>待审 {counts.review}</span></div>{report&&<div className="project-report"><small>最近回报 · 未核验、非验收</small><p><strong>{report.title}</strong> · {report.excerpt}</p></div>}</button>})}</section></>}
 {createProjectName!==undefined&&!tasks.some(t=>t.project_id==='demo')&&<CreateWork defaultProjectName={createProjectName} onCreated={t=>{reads.current?.invalidate();setTasks(old=>[t,...old.filter(item=>item.id!==t.id)]);setView(taskProjectView(t));setFilter('active');setQuery('');open(t)}}/>}
 <section className="work-section" ref={workSection} tabIndex={-1} aria-labelledby="work-heading"><div className="section-heading"><h2 id="work-heading">{view==='attention'?'待决定事项':view==='decisions'?'决定与回执':filter==='review'?'待审交付':filter==='issues'?workIssueLabel:'工作事项'}</h2><span>按最近更新排序</span></div><div className="toolbar"><div className="filters">{(['active',...(view==='attention'||view==='decisions'?[]:['review','issues']),'all'] as WorkFilter[]).map(id=><button className={filter===id?'selected':''} aria-pressed={filter===id} onClick={()=>setFilter(id)} key={id}>{id==='active'?'在办':id==='review'?'待审交付':id==='issues'?workIssueLabel:'全部'}</button>)}</div><input aria-label="搜索工作" placeholder="搜索目标、进展或来源…" value={query} onChange={e=>setQuery(e.target.value)}/></div>{hiddenMatches>0&&<div className="search-scope-hint"><p role="status">当前范围另有 {hiddenMatches} 条匹配记录未在「在办」显示。</p><button type="button" onClick={()=>{setFilter('all');workSection.current?.focus({preventScroll:true})}}>在全部查看</button></div>}{listNotice&&<p className={listNotice.error?'list-notice error':'list-notice'} role={listNotice.error?'alert':'status'}>{listNotice.text}</p>}<div className="worklist">{visible.map(t=><div className="work-row" key={t.id}><button ref={node=>{if(node)rowDetails.current.set(t.id,node);else rowDetails.current.delete(t.id)}} className="work" onClick={()=>open(t)}><div className="work-title"><Badge task={t}/><small className="task-origin">{taskOrigin(t)}</small>{taskProjectLabel(t)&&<small className="task-project">{taskProjectLabel(t)}</small>}<h3>{t.title}</h3><p>{t.goal}</p></div><div className="work-update"><p>{taskSummary(t)||'尚无执行回报'}</p><small>{hiddenLocalWork(t)?'仅隐藏本地记录；仍在「全部」可恢复，不停止执行':endedLocalFollowUp(t)?'仅结束本地跟进；在「全部」可恢复，执行状态未改变':pending(t)?'指令仅已记录 · 送达待核实':answered(t)?'决定已留，不再重复催问':reviewedDelivery(t)?'这次交付已查看；保留证据，不代表验收':t.status==='ready'?'检查交付证据 · 非验收':''}</small>{filter==='review'&&<ReviewEvidence task={t}/>}</div><div className="work-time"><span>最近更新</span><time>{stamp(t.updated_at)}</time><b>↗</b></div></button>{pinLocalVisibility(t)&&<div className="work-row-actions"><button type="button" disabled={busy} className="end-row-follow-up" onClick={event=>void changeVisibility(t,pinLocalVisibility(t),hiddenLocalWork(t)?'restore':'hide',event.currentTarget)}>{hiddenLocalWork(t)?'恢复事项显示':'收起事项'}</button></div>}{pinRowFollowUp(t)&&<div className="work-row-actions"><button type="button" className="end-row-follow-up" disabled={busy} aria-label={`结束本地跟进：${t.title}`} onClick={e=>void endRow(t,e.currentTarget)}>{endingRow===t.id?'保存中…':'结束本地跟进'}</button></div>}</div>)}{visible.length===0&&<div className="empty">{loading?'正在读取工作…':query?'没有找到匹配的工作。':filter==='review'?'没有待审交付。可切回「在办」查看其他工作。':filter==='issues'?'没有已记录的受阻、待补或启动问题。可切回「在办」查看其他工作。':'这里没有待处理的事项。'}</div>}</div>{filter==='review'&&<p className="footnote">待审仅为填报 ready；已查看不代表验收，新回报会再次待审。</p>}{filter==='issues'&&<p className="footnote">包括待补证据、受阻、失败和启动检查；不会自动启动或重试。</p>}</section>{view==='overview'&&<details className="secondary-observation"><summary>本机执行观察 · Herdr（只读）</summary><HerdrPanel/></details>}</main>
 {active&&<div className="overlay" onClick={e=>{if(e.target===e.currentTarget&&!busy)closeDetail()}}><section className="detail" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div className="detail-top"><span className="eyebrow">{active.source==='local'?'事项详情 · 本地工作记录':'事项详情 · 原执行上下文'}</span><button ref={closeRef} aria-label="关闭事项详情" onClick={()=>closeDetail()} disabled={busy}>✕</button></div><Badge task={active}/><h2 id="detail-title">{active.title}</h2><WorkItemLink key={active.id} task={active}/><GoalText task={active} tasks={tasks} onNavigate={navigateToWork}/><p className="task-origin">{taskOrigin(active)}</p>{taskProjectLabel(active)&&<p className="task-project">{taskProjectLabel(active)}</p>}{canNameProject(active)&&<ProjectNameEditor key={active.id} task={active} busy={busy} drafts={projectDrafts.current} onSave={name=>saveProjectName(active,name)}/>}<div className="fact"><h3>最近知道的事实</h3><p>{taskSummary(active)||'暂无回报'}</p>{codexLaunchNotice(active)&&<small>上次启动检查记录于 <time dateTime={codexLaunchNotice(active)!.recorded_at}>{new Date(codexLaunchNotice(active)!.recorded_at).toLocaleString('zh-CN',{hour12:false})}</time> · 未领取或启动；不会自动重试。</small>}<small>最后观察于 {stamp(active.observed_at)} · 当前在线状态未核实</small></div>{codexStartObservation(active)&&<div className="fact"><h3>CLI 报告：曾观察到 Codex 首轮开始</h3><p>显式 CLI 报告已读到初次原生执行的 turn.started。</p><small>记录于 <time dateTime={codexStartObservation(active)!.observed_at}>{new Date(codexStartObservation(active)!.observed_at).toLocaleString('zh-CN',{hour12:false})}</time> · CLI 填报，未独立核验；历史事实不表示当前在线、已续跑或已完成</small></div>}<div className="run"><span>回报必须绑定此记录（非已启动证明）</span><code>{active.run_id}</code></div>
 {pinLocalVisibility(active)&&<section className="local-visibility"><h3>{hiddenLocalWork(active)?'已隐藏 · 本地':'本地显示'}</h3><p className="muted">只从在办、问题计数和项目最近回报中隐藏，仍可在「全部」查找并恢复。不完成、不删除、不停止执行；同次执行有新实质回报会恢复显示。</p>{localVisibilityRequest(active,visibilityTarget,hiddenLocalWork(active)?'restore':'hide')?<button type="button" disabled={busy} onClick={()=>void changeVisibility(active,visibilityTarget,hiddenLocalWork(active)?'restore':'hide')}>{hiddenLocalWork(active)?'恢复事项显示':'收起事项'}</button>:<p role="status">记录已更新，请重新打开核对后再操作。</p>}</section>}
 {active.status==='blocked'&&(attemptTarget||pinNewAttempt(active))&&<section className="new-attempt"><h3>在本事项准备新尝试</h3>{newAttemptRequest(active,attemptTarget,true)&&!attemptUncertain?<><p>先核实原执行已停止。原失败回报与证据作为历史保留，不作为本次交付。这里只重置为新尝试，不自动启动、不复用旧线程、不改变权限。</p><label><input type="checkbox" disabled={busy} checked={confirmStopped} onChange={e=>setConfirmStopped(e.target.checked)}/>已核实原执行已停止</label><button type="button" disabled={busy||!confirmStopped} onClick={()=>void prepareNewAttempt()}>{busy?'保存中…':'准备新尝试'}</button></>:<p role="status">记录已更新或上次保存结果未确认。请刷新核实后重新打开详情。</p>}</section>}
 {active.source==='local'&&active.status==='not_started'&&<details className="report-help start-help"><summary>用 Codex 开始这件工作</summary><p>先在同一台电脑的终端 cd 到你要处理的仓库，再手工执行下面的命令。需要已安装并登录的 Codex CLI；默认只读，网页不会启动进程或授予权限。</p>{cliAddress?<TaskBriefCommand task={active} address={cliAddress}/>:<p>请从本机 localhost、127.0.0.1 或 [::1] 打开工作台，才能显示安全的本地命令。</p>}<TaskBrief key={`${active.id}:${active.run_id}`} task={active}/><small>先核对任务说明，再手动运行；仍由你选择当前目录和沙箱，默认只读。保持终端前台运行。自定义安装请替换二进制目录；结果未知时先核实，不要重复启动。</small><details><summary>改用自定义标准输入</summary>{cliAddress&&<code>{codexRunCommand(active,cliAddress)}</code>}<small>不加 -use-task-brief 的原命令仍等待标准输入：可粘贴并编辑上方说明（最多 64 KiB），按回车后在空行按 Ctrl+D（EOF）开始。也可显式使用 -prompt；不能与 -use-task-brief 或 -continue 混用。</small></details></details>}
 {active.source==='local'&&<details className="report-help"><summary>如何回报这件工作</summary><p>请在同一台电脑手工执行以下 CLI，替换摘要、来源和摘录；不会自动执行任务。</p>{cliAddress?<code>~/.local/share/agent-workbench/current/agent-workbench report -addr {shellArgument(cliAddress)} -task {shellArgument(active.id)} -run {shellArgument(active.run_id)} -kind ready -message '填写实际进展' -origin '填写执行者与来源' -excerpt '填写测试或交付证据'</code>:<p>请从本机 localhost、127.0.0.1 或 [::1] 打开工作台以显示本地命令。</p>}<small>默认使用安装目录内的二进制，不要求加入 PATH；自定义安装时请替换目录。ready 仅表示填报证据待审。不要填写凭据；命令不读取文件。</small></details>}
 {active.decision&&active.status==='needs_decision'&&!answered(active)&&<section className="decision"><h3>需要你定方向</h3><p>{active.decision.question}</p><fieldset disabled={busy}><legend>选择本次决定</legend>{active.decision.options.map(option=><label key={option} className={answer===option?'option checked':'option'}><input type="radio" name="answer" checked={answer===option} onChange={()=>{answerDrafts.current.set(decisionKey,option);setAnswer(option)}}/><span>{option}</span></label>)}<button className="primary" disabled={!answer.trim()} onClick={()=>void mutate('decisions')}>{busy?'保存中…':'保存决定到原执行'}</button></fieldset><small>这里只记录指令；回执仅表示消费者填报已收到，不证明 Agent 已继续或完成。</small></section>}
 {active.status==='needs_evidence'&&<section className="decision"><h3>交付待补</h3><p>本次尚无有效交付证据。</p><button className="primary" disabled={busy||active.follow_up_count>=1} onClick={()=>void mutate('follow-up')}>{active.follow_up_count>=1?'已记录补交要求，仍待证据':'记录一次补交要求'}</button><small>只保存补交要求，不启动或自动通知 Agent；请自行交给原执行。记录要求不等于补齐证据。</small></section>}
 {notice&&noticeScope.current===taskNoticeKey(active)&&<div className="notice" role="status">{notice}</div>}
 {answered(active)&&<div className="notice">{canContinueCodex(active)?'决定已记录，待回执。原命令若仍在等待，会自动读取决定续办，勿另开；若已退出，核实后用下方 -continue 手动继续。等待或回执都不证明已续跑。':<>这个问题已有决定，不再重复提交。{pending(active)?'仍待原执行回执。':'消费者已填报收到；是否继续仍需新的进展或证据。'}</>}</div>}
 {canContinueCodex(active)&&<details className="report-help"><summary>原命令已退出？继续同一 Codex 工作</summary><p>确认原命令已退出后，在原电脑的同一工作目录手工执行：</p>{cliAddress?<code>{codexRunCommand(active,cliAddress,true)}</code>:<p>请从本机 localhost、127.0.0.1 或 [::1] 打开工作台以显示本地命令。</p>}<small>继续已绑定的原生线程，不新建线程，无需重新输入任务说明。继续使用已保存的原沙箱限制，不改变权限；网页不会启动进程或授予权限。若结果未知，先核实原执行与证据，不要重复启动。自定义安装请替换二进制目录。</small></details>}
 <CurrentEvidence task={active}/>
 <DeliveryHandoff key={`${active.id}:${reviewTarget?.run_id||''}:${reviewTarget?.report_event_id||''}`} task={active} target={reviewTarget}/>
 <PreviousEvidence task={active}/>
 <PreviousBlocked task={active}/>
 {currentReadyReportID(active)&&<section className="delivery-review" aria-label="本次交付查看记录">{reviewedDelivery(active)?<><span className="badge gray">已查看本次交付 · 非验收</span><small>记录于 <time dateTime={reviewedDelivery(active)!.reviewed_at}>{new Date(reviewedDelivery(active)!.reviewed_at).toLocaleString('zh-CN',{hour12:false})}</time>。新的交付回报仍会再次待审。</small>{deliveryReviewRequest(active,reviewTarget)?<>{endedLocalFollowUp(active)&&<small>本地跟进结束于 <time dateTime={localFollowUpMarker(active)!.recorded_at}>{new Date(localFollowUpMarker(active)!.recorded_at).toLocaleString('zh-CN',{hour12:false})}</time> · 已结束跟进 · 本地</small>}<button type="button" disabled={busy} onClick={()=>void mutate('local-follow-up',endedLocalFollowUp(active)?'resume':'end')}>{endedLocalFollowUp(active)?'恢复本地跟进':'结束本地跟进'}</button><small>只改变本地「在办」列表；不代表完成、验收或独立核验，不取消执行，也不授权合并、部署。在「全部」可恢复。</small></>:<p className="muted" role="status">交付已更新，重新打开核对后再操作。</p>}</>:deliveryReviewRequest(active,reviewTarget)?<><button type="button" disabled={busy} onClick={()=>void mutate('review-delivery')}>{busy?'保存中…':'标记本次已查看'}</button><small>只记录你已查看这次交付并移出本次待审；不代表验收、完成、独立核验或授权合并、部署。</small></>:<p className="muted" role="status">交付已更新，重新打开核对后再标记。</p>}</section>}
 <section className="detail-section"><h3>决定与回执</h3>{active.commands?.length?active.commands.map(c=><div className="command" key={c.id}><div><strong>{c.kind==='decision'?'你的决定':'补交要求'}</strong><span className="badge gray">{c.status==='recorded'?'仅记录 · 未确认送达':c.status==='acknowledged'||c.status==='received'?'已收到回执 · 非完成':c.status}</span></div><p>{c.message}</p><small>{stamp(c.created_at)} · <code>{c.run_id}</code></small></div>):<p className="muted">暂无指令记录。</p>}</section>
 <details className="timeline"><summary>查看原始回报 · {active.events?.length||0} 条</summary>{active.events?.map(e=><div key={e.id}><small>{stamp(e.created_at)} · {e.kind}{e.origin?` · 来源（填报）：${e.origin}`:''}</small><p>{e.message}</p></div>)}</details><p className="footnote">网页提交只保存记录，不会直接启动或控制 Agent；你主动运行的本地 CLI 可读取决定并继续执行。回执仅是消费者填报收到，进展与证据未经独立核验。</p></section></div>}
 </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

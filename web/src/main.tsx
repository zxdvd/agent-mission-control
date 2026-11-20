import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { taskDetailBrief, type TaskDetailBrief } from './task-brief';
import { codeDelivery } from './code-delivery';
import { HerdrPanel } from './herdr-panel';
import { CreateWork } from './create-work';
import {composerAttachmentPath} from './composer-files';
import { latestProjectReport } from './project-report';
import { CodexCardControls, ManagedCodexProvider, ManagedTaskContent, type ManagedDraft } from './managed-codex-panel';
import { snapshotRefresh, watchVisibleRefresh, type SnapshotFreshness } from './refresh';

import { goalWorkLinks, taskNoticeKey, hiddenLocalWork, pinLocalVisibility, localVisibilityRequest, type LocalVisibilityTarget, previousBlockedAttempts, type Project, type Task, creationProjectName, parseWorkFragment, workItemLink, workLinkIntent, pinNewAttempt, newAttemptRequest, type NewAttemptTarget, taskProjectLabel, taskProjectView, workProjectGroups, projectWorkCounts, taskBadge, pending, answered, needsDecision, evidenceLink, evidenceOrigin, evidenceExcerpt, taskOrigin, type WorkFilter, matchesWorkFilter, matchesWorkView, hiddenActiveSearchCount, matchesTaskSearch, hasWorkIssue, workIssueLabel, activeWork, endedLocalFollowUp, localFollowUpRequest, pinRowFollowUp, rowFollowUpRequest, pendingDeliveryReview, pinDeliveryReview, deliveryReviewRequest, type DeliveryReviewTarget, currentReadyReportID, reviewedDelivery, previousDeliveryEvidence, previousEvidenceUnretained, codexStartObservation, taskSummary, codexLaunchNotice } from './model';
const stamp=(v:string)=>{const d=new Date(v);return Number.isNaN(d.valueOf())?'尚未观察':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})};
async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{const res=await fetch('/api'+path,{signal,cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});if(!res.ok){const err=await res.json().catch(()=>({error:`请求失败 (${res.status})`}));throw new Error(err.error||'请求失败')}return res.json()}
function Badge({task}:{task:Task}){const [label,tone]=taskBadge(task);return <span className={'badge '+tone}>{label}</span>}
function BackgroundText({brief}:{brief:TaskDetailBrief}){
 const [expanded,setExpanded]=useState(false),contentID=useId();
 return <div className="brief-background"><p id={contentID}>{expanded?brief.background:brief.backgroundPreview??brief.background}</p>{brief.backgroundPreview!==undefined&&<button type="button" className="background-toggle" aria-expanded={expanded} aria-controls={contentID} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起背景':'展开完整背景'}</button>}</div>;
}
function ReviewEvidence({task}:{task:Task}){
 const brief=taskDetailBrief(task);
 return <div className="review-evidence review-focus"><strong>本次审阅</strong><p>{brief.reviewFocus||'未写明审阅重点'}</p></div>;
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
function CodeDelivery({task}:{task:Task}){
 const delivery=codeDelivery(task);
 return <section className="code-delivery" id="detail-delivery" tabIndex={-1} aria-label="交付物链接"><h3>交付物{(delivery.links.length>0||delivery.localPatch)&&<span>填报 · 未独立核验</span>}</h3>{delivery.links.length?<><ul>{delivery.links.map(link=><li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer">{new URL(link.url).host} · {link.kind} #{link.number} ↗</a></li>)}</ul><small>不代表已合并、通过审查或验收。</small></>:<p title={delivery.localPatch?undefined:'链接缺失不表示没有代码改动。'}>{delivery.localPatch?'有本地改动证据，未记录提交链接':'未记录 MR / CR 链接'}</p>}</section>;
}
function CurrentEvidence({task}:{task:Task}){
 if(task.status==='needs_evidence'&&task.evidence?.length)return <details className="detail-section unconfirmed-evidence"><summary>记录中的证据 · 本次有效性未确认 · {task.evidence.length}</summary><p className="muted">这些内容尚未确认为本次有效交付证据，不用于待审或已查看。</p><EvidenceItems task={task}/></details>;
 return <section className="detail-section"><h3>交付证据 <span>{task.evidence?.length||0}</span></h3><EvidenceItems task={task}/></section>;
}
function PreviousEvidence({task}:{task:Task}){
 const previous=previousDeliveryEvidence(task),unretained=previousEvidenceUnretained(task);
 if(!previous)return unretained?<details key={`${task.id}:${unretained.report_event_id}`} className="detail-section previous-evidence"><summary>上一份交付证据 · 未保留</summary><p className="muted">上一份超出保存上限，未保留。这里没有旧证据副本，不影响当前交付或查看状态。</p></details>:null;
 const omitted=previous.total_count-previous.evidence.length;
 return <details key={`${task.id}:${previous.report_event_id}`} className="detail-section previous-evidence"><summary>上一份交付证据 · 历史</summary><p className="muted">仅保留上一份回报的有限快照，不是当前交付，不参与本次已查看、待审或本地跟进判断；来源仍为填报，未独立核验。</p><small>原回报 <code>{previous.report_event_id}</code> · <time dateTime={previous.reported_at}>{new Date(previous.reported_at).toLocaleString('zh-CN',{hour12:false})}</time></small><small>来源（填报）：{previous.origin||'未说明'}</small>{previous.summary&&<p>{previous.summary}{previous.summary_truncated?'（摘要已截短）':''}</p>}<p className="muted">保留 {previous.evidence.length} / {previous.total_count} 项{omitted?`；受保存上限限制，另 ${omitted} 项未保留。`:'。'}</p>{previous.evidence.map((e,i)=><div className="evidence" key={i}><span>↳</span><div className="evidence-content"><strong>{e.label?.trim()||(evidenceExcerpt(e)?'历史内联证据':'历史引用')}</strong><small className="evidence-origin">{evidenceOrigin(e)}</small>{evidenceExcerpt(e)&&<p className="evidence-excerpt">{evidenceExcerpt(e)}</p>}{evidenceLink(e)?<a href={evidenceLink(e)} target="_blank" rel="noopener noreferrer">打开历史引用 ↗</a>:e.url?<><code>{e.url}</code><small>仅显示历史引用，不会读取本地文件或自动打开。</small></>:null}</div></div>)}</details>;
}
function TaskAttachments({task}:{task:Task}){
 if(!task.attachments?.length)return null;
 return <div className="task-attachments"><small>本地附件 · 不发送给 Codex</small><ul>
  {task.attachments.map((file,index)=>{const path=composerAttachmentPath(task.id,index);return path?<li key={path}><a href={path} download={file.name}>{file.name}</a></li>:null})}
 </ul></div>;
}
function GoalText({task,tasks,onNavigate}:{task:Task;tasks:Task[];onNavigate:(id:string)=>void}){
 return <p className="detail-goal">{goalWorkLinks(task.goal,window.location).map((part,index)=>part.taskID&&tasks.some(item=>item.id===part.taskID&&item.source==='local'&&item.project_id!=='demo')?<a key={index} href={'#work='+encodeURIComponent(part.taskID)} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onNavigate(part.taskID!)}}>{part.text}</a>:<React.Fragment key={index}>{part.text}</React.Fragment>)}</p>;
}
function PreviousBlocked({task}:{task:Task}){
 const previous=previousBlockedAttempts(task);
 return <>{previous.map(attempt=>{const report=task.events.find(event=>event.id===attempt.report_event_id&&event.run_id===attempt.run_id)!;return <details className="detail-section previous-evidence" key={attempt.run_id}><summary>上一尝试受阻记录 · 历史</summary><p className="muted">原生首轮已开始后的受阻快照，不是本次进展或交付；保留填报原文，未独立核验。</p><small>原执行 <code>{attempt.run_id}</code> · 首轮开始于 <time dateTime={attempt.codex_start.observed_at}>{new Date(attempt.codex_start.observed_at).toLocaleString('zh-CN',{hour12:false})}</time> · 受阻回报 <time dateTime={report.created_at}>{new Date(report.created_at).toLocaleString('zh-CN',{hour12:false})}</time> · {report.origin}</small><p>{report.message}</p><EvidenceItems task={{...task,evidence:attempt.evidence}}/></details>})}</>;
}
function App(){
 const [projects,setProjects]=useState<Project[]>([]),[tasks,setTasks]=useState<Task[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null),[view,setView]=useState('overview'),[filter,setFilter]=useState<WorkFilter>('active'),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[answer,setAnswer]=useState('');
 const taskSnapshots=useRef<Task[]>(tasks);taskSnapshots.current=tasks;
 const managedDrafts=useRef(new Map<string,ManagedDraft>());
 const answerDrafts=useRef(new Map<string,string>()),selectedRef=useRef<string|null>(null);
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
 useEffect(()=>{if(selected){const trigger=document.activeElement as HTMLElement;closeRef.current?.focus();const previous=document.body.style.overflow;document.body.style.overflow='hidden';const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!mutating.current)closeDetail();if(e.key==='Tab'){const nodes=Array.from(document.querySelectorAll<HTMLElement>('.detail button:not(:disabled), .detail input:not(:disabled), .detail textarea:not(:disabled), .detail a, .detail summary')).filter(node=>node.getClientRects().length>0);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener('keydown',escape);return()=>{document.body.style.overflow=previous;document.removeEventListener('keydown',escape);if(trigger?.isConnected)trigger.focus();else workSection.current?.focus()}}},[selected]);
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
 async function mutate(action:'decisions'|'follow-up'|'review-delivery'|'local-follow-up',operation?:'end'|'resume'){if(!active||mutating.current)return;const reviewRequest=action==='review-delivery'?deliveryReviewRequest(active,reviewTarget):action==='local-follow-up'&&operation?localFollowUpRequest(active,reviewTarget,operation):undefined;if((action==='review-delivery'||action==='local-follow-up')&&!reviewRequest)return;mutating.current=true;reads.current?.invalidate();setBusy(true);setNotice('');try{const next=await api<Task>(`/tasks/${encodeURIComponent(active.id)}/${action}`,{run_id:active.run_id,...(action==='decisions'?{answer,decision:active.decision}:(action==='review-delivery'||action==='local-follow-up')?reviewRequest:{})});setTasks(old=>old.map(t=>t.id===next.id?next:t));noticeScope.current=taskNoticeKey(next);setNotice(action==='local-follow-up'?(operation==='end'?'本地跟进已结束，可在「全部」恢复。':'本地跟进已恢复。'):action==='review-delivery'?'本次交付已标记查看，非验收。':action==='follow-up'?'补交要求已记录，未自动通知执行者。':'决定已保存，送达与继续执行待核实。');if(selectedRef.current===active.id){answerDrafts.current.delete(JSON.stringify([active.id,active.run_id,active.decision]));setAnswer('')}}catch(e){noticeScope.current=taskNoticeKey(active);setNotice('未能确认保存：'+(e as Error).message+'。请先刷新核实，不要重复发送。')}finally{mutating.current=false;setBusy(false)}}
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
  if(newAttemptFocus.current&&!busy){const taskID=newAttemptFocus.current;newAttemptFocus.current=null;if(selectedRef.current===taskID)document.querySelector<HTMLElement>('.detail .detail-brief')?.focus()}
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
 const detailBrief=active?taskDetailBrief(active):undefined;
 const unviewedDelivery=!!active&&!!currentReadyReportID(active)&&!reviewedDelivery(active);
 const primaryAction=!!active&&(needsDecision(active)||unviewedDelivery&&!!detailBrief?.reviewFocus||!!detailBrief?.operatorNote||active.status==='needs_evidence'&&active.follow_up_count<1);
 const reviewOnly=unviewedDelivery&&!primaryAction;
 const actionSection=active&&<section className={primaryAction?'brief-section detail-action-required':'brief-section'} aria-labelledby="detail-actions-heading"><h3 id="detail-actions-heading">{reviewOnly?'交付待查看':'需要我做的'}</h3>
  {active.decision&&needsDecision(active)?<div className="decision"><p>{active.decision.question}</p><fieldset disabled={busy}><legend>选择本次决定</legend>{active.decision.options.map(option=><label key={option} className={answer===option?'option checked':'option'}><input type="radio" name="answer" checked={answer===option} onChange={()=>{answerDrafts.current.set(decisionKey,option);setAnswer(option)}}/><span>{option}</span></label>)}<button className="primary" disabled={!answer.trim()} onClick={()=>void mutate('decisions')}>{busy?'保存中…':'保存决定'}</button></fieldset><small>只记录决定，回执与新进展另行确认。</small></div>:null}
  {unviewedDelivery&&<div className="brief-review">{detailBrief?.reviewFocus?<><p className="brief-review-label">审阅重点（填报）</p><p>{detailBrief.reviewFocus}</p></>:<p className="muted">未记录需要你判断的事项。</p>}{codeDelivery(active).links.length>0&&<button type="button" className="jump-delivery" onClick={()=>{const target=document.getElementById('detail-delivery');target?.scrollIntoView({block:'nearest'});target?.focus({preventScroll:true})}}>查看交付物 ↓</button>}{deliveryReviewRequest(active,reviewTarget)?<button type="button" disabled={busy} onClick={()=>void mutate('review-delivery')}>{busy?'保存中…':'标记本次已查看'}</button>:<p className="muted" role="status">交付已更新，请重新打开核对。</p>}<small>已查看不代表验收。</small></div>}
  {active.status==='needs_evidence'&&<div className="brief-review"><p>{active.follow_up_count>=1?'补交要求已记录，仍待有效证据。':'交付证据待补齐。'}</p>{active.follow_up_count<1&&<button type="button" disabled={busy} onClick={()=>void mutate('follow-up')}>{busy?'保存中…':'记录一次补交要求'}</button>}</div>}
  {!primaryAction&&!reviewOnly&&active.status!=='needs_evidence'&&(answered(active)?<p>{pending(active)?'决定已记录，待回执。':'决定已有回执，等待新进展。'}</p>:reviewedDelivery(active)?<p>本次交付已查看。</p>:!detailBrief?.operatorNote?<p className="muted">未记录待处理动作</p>:null)}
  {detailBrief?.operatorNote&&<p className="reported-note"><small>填报</small>{detailBrief.operatorNote}</p>}
 </section>;
 return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">↗</span> 工作台</div><nav aria-label="主导航">{[['overview','总览','◫'],['attention','需要我决定','◇'],['decisions','已留的决定','↳']].map(([id,label,icon])=><button key={id} className={view===id?'nav active':'nav'} onClick={()=>{setView(id);setFilter('active')}}><span>{icon}</span>{label}{id==='attention'&&needs.length>0&&<b>{needs.length}</b>}</button>)}</nav><p className="nav-label">项目</p>{groups.map(group=><button className={view===group.key?'nav active':'nav'} key={group.key} onClick={()=>showProject(group.key)}><span className="project-dot"/>{group.name}{group.kind==='demo'?' · 演示':group.kind==='legacy'?' · 历史':''}</button>)}<div className="sidebar-foot">本地记录</div></aside>
 <main><header className="top"><div><h1>{view==='attention'?'待决定':view==='decisions'?'决定记录':view==='overview'?'工作台':scopedGroup?.name||'项目工作'}</h1>{isGroupView&&<button type="button" className="back-overview" onClick={()=>{setView('overview');setFilter('active');workSection.current?.focus({preventScroll:true})}}>← 全部项目总览</button>}</div><button onClick={()=>void refresh()} disabled={loading} className="refresh">{loading?'读取中…':'↻ 刷新'}</button></header>
 {tasks.some(t=>t.project_id==='demo')&&<p className="demo-boundary">当前数据库含合成演示。实际使用请另选空白 -db 并移除 -demo；不能在此创建真实工作。</p>}
 {error&&(freshness.stale&&freshness.lastSuccessAt!==null?<div className="read-stale" role="status"><span>读取失败，显示上次记录 · 上次读取 <time dateTime={new Date(freshness.lastSuccessAt).toISOString()}>{new Date(freshness.lastSuccessAt).toLocaleString('zh-CN',{hour12:false})}</time></span><button type="button" onClick={()=>void refresh()} disabled={loading}>重新读取</button></div>:<div className="error" role="alert">读取失败：{error}。暂无可验证的数据，请确认本地服务已启动后刷新。</div>)}
 {!loading&&!error&&tasks.length===0&&<div className="empty">暂无工作。点击「新建工作」记录目标。</div>}
 {view==='overview'&&tasks.length>0&&<><section className="overview-counts" aria-label="工作状态"><div aria-label={`在办 ${tasks.filter(activeWork).length} 件，本地跟进数，不代表正在执行`}><span>在办跟进</span><b>{tasks.filter(activeWork).length}</b></div><button type="button" onClick={()=>{setView('attention');setFilter('active');setQuery('');workSection.current?.focus({preventScroll:true});workSection.current?.scrollIntoView({block:'start'})}} aria-label={`查看待决定，${needs.length} 件`}><span>待决定</span><b>{needs.length}</b></button><button type="button" onClick={()=>showWorkFilter('issues')} aria-label={`查看受阻、待补与启动问题，${tasks.filter(hasWorkIssue).length} 件`}><span>{workIssueLabel}</span><b>{tasks.filter(hasWorkIssue).length}</b></button><button type="button" onClick={()=>showWorkFilter('review')} aria-label={`查看待审交付，${tasks.filter(pendingDeliveryReview).length} 件`}><span>待审交付</span><b>{tasks.filter(pendingDeliveryReview).length}</b></button><div title="已记录的指令，尚未确认送达；不代表已执行" aria-label={`指令待回执 ${tasks.filter(t=>pending(t)).length} 条，已记录但未确认送达，不代表已执行`}><span>指令待回执</span><b>{tasks.filter(t=>pending(t)).length}</b></div></section><div className="section-heading"><h2>项目</h2></div><section className="projects">{groups.map(group=>{const counts=projectWorkCounts(group.items),report=latestProjectReport(group);return <button key={group.key} className="project-card" onClick={()=>showProject(group.key)}><div className="project-top"><h3>{group.name}</h3><span>{group.kind==='demo'?'合成演示':group.kind==='legacy'?'历史':'↗'}</span></div><div className="project-bottom"><span>在办 <b>{counts.active}</b></span><span>待定 {counts.decision}</span><span>{workIssueLabel} {counts.issues}</span><span>待审 {counts.review}</span></div>{report&&<div className="project-report"><small>最近回报 · 未核验、非验收</small><p><strong>{report.title}</strong> · {report.excerpt}</p></div>}</button>})}</section></>}
 {createProjectName!==undefined&&!tasks.some(t=>t.project_id==='demo')&&<CreateWork defaultProjectName={createProjectName} onCreated={t=>{reads.current?.invalidate();setTasks(old=>[t,...old.filter(item=>item.id!==t.id)]);setView(taskProjectView(t));setFilter('active');setQuery('');open(t)}}/>}
 <section className="work-section" ref={workSection} tabIndex={-1} aria-labelledby="work-heading"><div className="section-heading"><h2 id="work-heading">{view==='attention'?'待决定事项':view==='decisions'?'决定与回执':filter==='review'?'待审交付':filter==='issues'?workIssueLabel:'工作事项'}</h2><span>按最近更新排序</span></div><div className="toolbar"><div className="filters">{(['active',...(view==='attention'||view==='decisions'?[]:['review','issues']),'all'] as WorkFilter[]).map(id=><button className={filter===id?'selected':''} aria-pressed={filter===id} onClick={()=>setFilter(id)} key={id}>{id==='active'?'在办':id==='review'?'待审交付':id==='issues'?workIssueLabel:'全部'}</button>)}</div><input aria-label="搜索工作" placeholder="搜索目标、进展或来源…" value={query} onChange={e=>setQuery(e.target.value)}/></div>{hiddenMatches>0&&<div className="search-scope-hint"><p role="status">当前范围另有 {hiddenMatches} 条匹配记录未在「在办」显示。</p><button type="button" onClick={()=>{setFilter('all');workSection.current?.focus({preventScroll:true})}}>在全部查看</button></div>}{listNotice&&<p className={listNotice.error?'list-notice error':'list-notice'} role={listNotice.error?'alert':'status'}>{listNotice.text}</p>}<div className="worklist">{visible.map(t=><div className="work-row" key={t.id}><button ref={node=>{if(node)rowDetails.current.set(t.id,node);else rowDetails.current.delete(t.id)}} className="work" onClick={()=>open(t)}><div className="work-title"><Badge task={t}/><small className="task-origin">{taskOrigin(t)}</small>{taskProjectLabel(t)&&<small className="task-project">{taskProjectLabel(t)}</small>}<h3>{t.title}</h3><p>{t.goal}</p></div><div className="work-update">{filter==='review'?<ReviewEvidence task={t}/>:<><p>{taskSummary(t)||'尚无执行回报'}</p><small>{hiddenLocalWork(t)?'仅隐藏本地记录；仍在「全部」可恢复，不停止执行':endedLocalFollowUp(t)?'仅结束本地跟进；在「全部」可恢复，执行状态未改变':pending(t)?'指令仅已记录 · 送达待核实':answered(t)?'决定已留，不再重复催问':reviewedDelivery(t)?'这次交付已查看；保留证据，不代表验收':t.status==='ready'?'检查交付证据 · 非验收':''}</small></>}</div><div className="work-time"><span>最近更新</span><time>{stamp(t.updated_at)}</time><b>↗</b></div></button>{pinLocalVisibility(t)&&<div className="work-row-actions"><button type="button" disabled={busy} className="end-row-follow-up" onClick={event=>void changeVisibility(t,pinLocalVisibility(t),hiddenLocalWork(t)?'restore':'hide',event.currentTarget)}>{hiddenLocalWork(t)?'恢复事项显示':'收起事项'}</button></div>}{pinRowFollowUp(t)&&<div className="work-row-actions"><button type="button" className="end-row-follow-up" disabled={busy} aria-label={`结束本地跟进：${t.title}`} onClick={e=>void endRow(t,e.currentTarget)}>{endingRow===t.id?'保存中…':'结束本地跟进'}</button></div>}</div>)}{visible.length===0&&<div className="empty">{loading?'正在读取工作…':query?'没有找到匹配的工作。':filter==='review'?'没有待审交付。可切回「在办」查看其他工作。':filter==='issues'?'没有已记录的受阻、待补或启动问题。可切回「在办」查看其他工作。':'这里没有待处理的事项。'}</div>}</div>{filter==='review'&&<p className="footnote">待审仅为填报 ready；已查看不代表验收，新回报会再次待审。</p>}{filter==='issues'&&<p className="footnote">包括待补证据、受阻、失败和启动检查；不会自动启动或重试。</p>}</section>{view==='overview'&&<details className="secondary-observation"><summary>本机执行观察 · Herdr（只读）</summary><HerdrPanel/></details>}</main>
 {active&&detailBrief&&<div className="overlay" onClick={e=>{if(e.target===e.currentTarget&&!busy)closeDetail()}}><section className="detail" role="dialog" aria-modal="true" aria-labelledby="detail-title">
 <div className="detail-top"><Badge task={active}/><button ref={closeRef} aria-label="关闭事项详情" onClick={()=>closeDetail()} disabled={busy}>✕</button></div>
 <h2 id="detail-title">{active.title}</h2><div className="detail-meta">{taskProjectLabel(active)&&<span>{taskProjectLabel(active)}</span>}<span>更新于 {stamp(active.updated_at)}</span><WorkItemLink key={active.id} task={active}/></div>
 <ManagedCodexProvider key={JSON.stringify([active.id,active.run_id])} task={active} drafts={managedDrafts.current}>
 <div className="detail-brief" tabIndex={-1}>
 {primaryAction&&actionSection}
 <section className="brief-section"><h3>背景 / 解决什么</h3><ManagedTaskContent taskID={active.id}><BackgroundText key={JSON.stringify([active.id,active.run_id,active.goal])} brief={detailBrief}/></ManagedTaskContent><TaskAttachments task={active}/>{detailBrief.outcome&&<p className="brief-outcome"><small>结果（填报）</small>{detailBrief.outcome}</p>}</section>
 <section className="brief-section"><h3>如何解决</h3><p className={detailBrief.approach?'':'muted'}>{detailBrief.approach||'未单独记录解决方式'}</p></section>
 <section className="brief-section"><h3>验证了哪些</h3>{detailBrief.verification.length?<ul>{detailBrief.verification.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p className="muted">未单独记录验证结果</p>}</section>
 {!primaryAction&&actionSection}
 <CodeDelivery task={active}/>
 <CodexCardControls task={active}/>
 </div>
 </ManagedCodexProvider>
 {notice&&noticeScope.current===taskNoticeKey(active)&&<div className="notice" role="status">{notice}</div>}
 {(pinLocalVisibility(active)||currentReadyReportID(active)&&reviewedDelivery(active)||active.status==='blocked'&&(attemptTarget||pinNewAttempt(active)))&&<details className="detail-admin"><summary>记录操作</summary>
 {pinLocalVisibility(active)&&<div className="record-action"><p>{hiddenLocalWork(active)?'已收起，仅影响本地显示。':'只影响本地显示，可在「全部」恢复。'}</p>{localVisibilityRequest(active,visibilityTarget,hiddenLocalWork(active)?'restore':'hide')?<button type="button" disabled={busy} onClick={()=>void changeVisibility(active,visibilityTarget,hiddenLocalWork(active)?'restore':'hide')}>{hiddenLocalWork(active)?'恢复事项显示':'收起事项'}</button>:<p role="status">记录已更新，请重新打开核对。</p>}</div>}
 {currentReadyReportID(active)&&reviewedDelivery(active)&&<div className="record-action">{deliveryReviewRequest(active,reviewTarget)?<><button type="button" disabled={busy} onClick={()=>void mutate('local-follow-up',endedLocalFollowUp(active)?'resume':'end')}>{endedLocalFollowUp(active)?'恢复本地跟进':'结束本地跟进'}</button><small>不改变执行或验收状态。</small></>:<p role="status">交付已更新，请重新打开核对。</p>}</div>}
 {active.status==='blocked'&&(attemptTarget||pinNewAttempt(active))&&<section className="new-attempt"><h3>准备新尝试</h3>{newAttemptRequest(active,attemptTarget,true)&&!attemptUncertain?<><label><input type="checkbox" disabled={busy} checked={confirmStopped} onChange={e=>setConfirmStopped(e.target.checked)}/>已核实原执行已停止</label><button type="button" disabled={busy||!confirmStopped} onClick={()=>void prepareNewAttempt()}>{busy?'保存中…':'准备新尝试'}</button><small>保留原失败记录，不自动启动。</small></>:<p role="status">记录已更新或保存结果未确认，请刷新后重新打开。</p>}</section>}
 </details>}
 <details className="detail-raw"><summary>原始记录</summary>
 <section className="detail-section"><h3>完整目标与边界</h3><GoalText task={active} tasks={tasks} onNavigate={navigateToWork}/></section>
 <section className="detail-section"><h3>当前摘要（填报）</h3><p className="raw-summary">{active.summary||'未记录'}</p></section><CurrentEvidence task={active}/><PreviousEvidence task={active}/><PreviousBlocked task={active}/>
 <section className="detail-section"><h3>来源与观察</h3><p className="muted">{taskOrigin(active)}</p><p className="muted">最后观察 {stamp(active.observed_at)}</p>{codexLaunchNotice(active)&&<p className="muted">上次启动检查未通过 · {stamp(codexLaunchNotice(active)!.recorded_at)}</p>}{codexStartObservation(active)&&<p className="muted">CLI 曾观察到首轮开始 · {stamp(codexStartObservation(active)!.observed_at)}</p>}<code>{active.run_id}</code></section>
 {active.commands?.length>0&&<section className="detail-section"><h3>决定与回执</h3>{active.commands.map(c=><div className="command" key={c.id}><div><strong>{c.kind==='decision'?'你的决定':'补交要求'}</strong><span className="badge gray">{c.status==='recorded'?'仅记录 · 待回执':c.status==='acknowledged'||c.status==='received'?'已回执 · 非完成':c.status}</span></div><p>{c.message}</p><small>{stamp(c.created_at)} · <code>{c.run_id}</code></small></div>)}</section>}
 <details className="timeline"><summary>原始回报 · {active.events?.length||0} 条</summary>{active.events?.map(e=><div key={e.id}><small>{stamp(e.created_at)} · {e.kind}{e.origin?` · ${e.origin}`:''}</small><p>{e.message}</p></div>)}</details>
 </details>
 </section></div>}

 </div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

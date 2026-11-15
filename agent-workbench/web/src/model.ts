// UI facts, not a scheduler: saved commands must not imply delivery or completion.
export type Project={id:string;name:string;goal:string};
export type Command={id:string;kind:string;message:string;run_id:string;status:string;created_at:string;question?:string};
export type CodexBinding={version:number;native_thread_id:string;task_id:string;run_id:string;question:string;options:string[];cwd_fingerprint:string;sandbox:string};
export type Evidence={label?:string;url?:string;excerpt?:string;origin?:string};
export type CodexStartObservation={run_id:string;native_thread_id:string;observed_at:string};
export type CodexLaunchNotice={category:string;recorded_at:string};
export type DeliveryReview={run_id:string;report_event_id:string;reviewed_at:string};
export type LocalFollowUp={run_id:string;report_event_id:string;state:'ended'|'open';recorded_at:string};
export type PreviousDeliveryEvidence={run_id:string;report_event_id:string;reported_at:string;origin:string;summary:string;summary_truncated?:boolean;total_count:number;evidence:Evidence[]};
export type PreviousEvidenceUnretained={run_id:string;report_event_id:string;reason:'task_size_limit'};
export type Task={project_name?:string;previous_evidence_unretained?:PreviousEvidenceUnretained|null;previous_delivery_evidence?:PreviousDeliveryEvidence|null;local_follow_up?:LocalFollowUp|null;delivery_review?:DeliveryReview|null;codex_launch_notice?:CodexLaunchNotice|null;codex_start?:CodexStartObservation|null;codex_binding?:CodexBinding|null;source?:string;origin?:string;id:string;project_id:string;title:string;goal:string;status:string;run_id:string;summary:string;updated_at:string;observed_at:string;evidence:Evidence[];decision:{question:string;options:string[]}|null;follow_up_count:number;events:{origin?:string;id:string;kind:string;message:string;run_id:string;created_at:string}[];commands:Command[]};
export const states:Record<string,[string,string]>={not_started:['尚未开始 · 等执行回报','gray'],working:['进行中','green'],needs_decision:['需要你的决定','amber'],needs_evidence:['交付待补齐','amber'],ready:['证据已就绪 · 待审','green'],done:['已完成','gray'],unknown:['当前状态未知','gray'],failed:['执行遇到问题','amber'],blocked:['执行受阻','amber'],paused:['已暂停','gray']};
export const pending=(task:Task)=>task.commands?.some(c=>c.status==='recorded');
export const answered=(task:Task)=>!!task.decision&&task.commands?.some(c=>c.kind==='decision'&&c.run_id===task.run_id&&c.question===task.decision?.question);
export const needsDecision=(task:Task)=>task.status==='needs_decision'&&!answered(task);

// The reporter supplies the origin/excerpt. Neither proves independent review.
export function evidenceLink(evidence:Evidence):string|undefined {
 const raw=evidence.url?.trim();
 if(!raw||!/^https?:\/\/[^/?#]+/i.test(raw)||/[\s\\]/.test(raw))return;
 try{const url=new URL(raw);if(url.hostname)return raw}catch{/* inert text only */}
}
export const evidenceOrigin=(evidence:Evidence)=>`来源（填报）：${evidence.origin?.trim()||'执行者回报'} · 未独立核验`;
export const evidenceExcerpt=(evidence:Evidence)=>evidence.excerpt?.trim()||undefined;

export type WorkFilter='active'|'review'|'issues'|'all';
// Review is only the reporter's ready state, not a new lifecycle or human decision.
// This bucket combines reported stop states and historical fresh-work preflight notices only.
export const workIssueLabel='受阻/待补';
export const hasWorkIssue=(task:Task)=>task.status==='blocked'||task.status==='failed'||task.status==='needs_evidence'||!!codexLaunchNotice(task);
export const matchesWorkFilter=(task:Task,filter:WorkFilter)=>filter==='review'?pendingDeliveryReview(task):filter==='issues'?hasWorkIssue(task):filter==='active'?activeWork(task):true;
export function reviewEvidencePreview(task:Task):{count:number;excerpt?:string;origin?:string}|undefined {
 if(task.status!=='ready')return;
 const entries=task.evidence||[];
 const entry=entries.find(e=>evidenceExcerpt(e))||entries[0];
 const excerpt=entry&&evidenceExcerpt(entry);
 const characters=excerpt?Array.from(excerpt.replace(/\s+/g,' ')):[];
 // No URL is returned: references and clickable links belong in the detail panel.
 return {count:entries.length,excerpt:characters.length?characters.slice(0,160).join('')+(characters.length>160?'…':''):undefined,origin:entry?evidenceOrigin(entry):undefined};
}

export function taskBadge(task:Task):[string,string] {
 if(endedLocalFollowUp(task))return ['已结束跟进 · 本地','gray'];
 if(reviewedDelivery(task))return ['已查看本次交付 · 非验收','gray'];
 if(task.status==='needs_decision'&&answered(task)){
  const receipt=task.commands.find(c=>c.kind==='decision'&&c.run_id===task.run_id&&c.question===task.decision?.question&&(c.status==='acknowledged'||c.status==='received'));
  return receipt?['决定已回执 · 等进展','gray']:['决定已记录 · 待回执','amber'];
 }
 return states[task.status]||['状态待核实','gray'];
}

export const taskOrigin=(task:Task)=>task.source==='local'?`本地工作 · 来源（填报）：${task.origin||'未说明'}`:task.source==='synthetic'||task.project_id==='demo'?'合成演示 · 非真实执行':'来源未记录 · 真实性未核实';

// Copyable terminal examples must not treat browser/server text as shell syntax.
export const shellArgument=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
export function loopbackCLIAddress(location:Pick<Location,'hostname'|'port'|'protocol'>):string|undefined {
 if(location.protocol!=='http:'&&location.protocol!=='https:')return;
 const host=location.hostname==='localhost'?'127.0.0.1':location.hostname;
 if(host!=='127.0.0.1'&&host!=='[::1]'&&host!=='::1')return;
 const port=location.port||(location.protocol==='https:'?'443':'80');
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)return;
 return `${host==='::1'?'[::1]':host}:${port}`;
}


// This is an instruction affordance, not proof the original foreground process exited.
export function canContinueCodex(task:Task):boolean {
 const binding=task.codex_binding,decision=task.decision;
 if(task.source!=='local'||task.status!=='needs_decision'||!binding||binding.version!==1||!decision)return false;
 if(binding.task_id!==task.id||binding.run_id!==task.run_id||binding.question!==decision.question)return false;
 if(!Array.isArray(binding.options)||binding.options.length!==decision.options.length||binding.options.some((option,i)=>option!==decision.options[i]))return false;
 if(!binding.native_thread_id||!binding.cwd_fingerprint||!['read-only','workspace-write'].includes(binding.sandbox))return false;
 const answers=task.commands?.filter(command=>command.kind==='decision'&&command.run_id===task.run_id&&command.question===decision.question)||[];
 return answers.length===1&&answers[0].status==='recorded'&&decision.options.includes(answers[0].message);
}
export function codexRunCommand(task:Task,address:string|undefined,continuation=false):string|undefined {
 if(!address)return;
 return `~/.local/share/agent-workbench/current/agent-workbench codex-run${continuation?' -continue':''} -addr ${shellArgument(address)} -task ${shellArgument(task.id)} -run ${shellArgument(task.run_id)} -cwd "$PWD"`;
}

// Historical initial-turn fact only. Older records and stale-run facts stay inert.
export function codexStartObservation(task:Task):CodexStartObservation|undefined {
 const start=task.codex_start;
 if(task.source!=='local'||!start||start.run_id!==task.run_id||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(start.native_thread_id)||!start.observed_at||Number.isNaN(Date.parse(start.observed_at)))return;
 return start;
}

// Only replace the exact initial claim placeholder, never subsequent business progress.
// The independent start observation remains historical, not a live-running signal.
export function taskSummary(task:Task):string {
 if(codexLaunchNotice(task))return '上次启动检查未通过：CLI 未在当时的 PATH 找到 Codex；请在终端检查 Codex 是否可用，再手动重试。';
 if(task.status==='working'&&codexStartObservation(task)&&task.summary==='已领取一次显式 Codex 执行；尚未证明启动或交付。'){
  for(let i=(task.events||[]).length-1;i>=0;i--){
   const event=task.events[i];
   if(event.run_id!==task.run_id||event.kind==='reports:receipt')continue;
   return event.kind==='codex-start:'?'CLI 已报告首轮开始，等待结果':task.summary;
  }
 }
 return task.summary;
}

// A visible stdin draft only; no command, context lookup, or execution permission.
export function codexTaskBrief(task:Pick<Task,'source'|'status'|'title'|'goal'>):string|undefined {
 if(task.source!=='local'||task.status!=='not_started')return;
 return `任务：${task.title.trim()}\n\n目标与边界：\n${task.goal.trim()}\n\n交付要求：说明实际改动、验证结果与未完成项。`;
}

export function codexLaunchNotice(task:Task):CodexLaunchNotice|undefined {
 const notice=task.codex_launch_notice;
 if(task.source!=='local'||task.status!=='not_started'||!notice||notice.category!=='missing_executable'||!notice.recorded_at||Number.isNaN(Date.parse(notice.recorded_at)))return;
 return notice;
}

export const isDeliveryReportKind=(kind:string)=>kind==='reports:ready'||kind==='reports:completed';

// Only the exact current local ready report can be marked seen. No lifecycle change.
export function currentReadyReportID(task:Task):string|undefined {
 if(task.source!=='local'||task.project_id==='demo'||task.status!=='ready'||!(task.evidence||[]).some(e=>evidenceExcerpt(e)||evidenceLink(e)))return;
 for(let i=(task.events||[]).length-1;i>=0;i--){
  const event=task.events[i];
  if(event.run_id!==task.run_id||!event.kind.startsWith('reports:')||event.kind==='reports:receipt')continue;
  return isDeliveryReportKind(event.kind)&&event.id?event.id:undefined;
 }
}
export function reviewedDelivery(task:Task):DeliveryReview|undefined {
 const review=task.delivery_review,report=currentReadyReportID(task);
 if(!review||!report||review.run_id!==task.run_id||review.report_event_id!==report||!review.reviewed_at||Number.isNaN(Date.parse(review.reviewed_at)))return;
 return review;
}
export const pendingDeliveryReview=(task:Task)=>task.status==='ready'&&!reviewedDelivery(task);

// The drawer captures this only on explicit open, never during snapshot refresh.
export type DeliveryReviewTarget={task_id:string;run_id:string;report_event_id:string};
export function pinDeliveryReview(task:Task):DeliveryReviewTarget|undefined {
 const report=currentReadyReportID(task);
 return report?{task_id:task.id,run_id:task.run_id,report_event_id:report}:undefined;
}
export function deliveryReviewRequest(task:Task,target:DeliveryReviewTarget|undefined):{run_id:string;report_event_id:string}|undefined {
 if(!target||target.task_id!==task.id||target.run_id!==task.run_id||target.report_event_id!==currentReadyReportID(task))return;
 // Submit the explicitly pictured target, not a newly derived report token.
 return {run_id:target.run_id,report_event_id:target.report_event_id};
}

// Search only the card's explicit text, not raw metadata or hidden historic reports.
export function matchesTaskSearch(task:Task,query:string):boolean {
 const term=query.trim().toLowerCase();
 return !term||[task.title,task.goal,taskSummary(task),taskOrigin(task),taskProjectLabel(task)||''].join(' ').toLowerCase().includes(term);
}

export function localFollowUpMarker(task:Task):LocalFollowUp|undefined {
 const marker=task.local_follow_up,review=reviewedDelivery(task);
 if(!marker||!review||marker.run_id!==task.run_id||marker.report_event_id!==review.report_event_id||!['ended','open'].includes(marker.state)||!marker.recorded_at||Number.isNaN(Date.parse(marker.recorded_at)))return;
 return marker;
}
export const endedLocalFollowUp=(task:Task)=>localFollowUpMarker(task)?.state==='ended';
export const activeWork=(task:Task)=>task.status!=='done'&&!endedLocalFollowUp(task);
export function localFollowUpRequest(task:Task,target:DeliveryReviewTarget|undefined,operation:'end'|'resume'):{run_id:string;report_event_id:string;operation:'end'|'resume';expected_recorded_at:string}|undefined {
 const pictured=deliveryReviewRequest(task,target);
 if(!pictured||!reviewedDelivery(task))return;
 return {...pictured,operation,expected_recorded_at:localFollowUpMarker(task)?.recorded_at||''};
}

// The row action pins one pictured, viewed report and its existing marker version.
export type RowFollowUpTarget=DeliveryReviewTarget&{reviewed_at:string;expected_recorded_at:string};
export function pinRowFollowUp(task:Task):RowFollowUpTarget|undefined {
 if(!activeWork(task))return;
 const target=pinDeliveryReview(task),review=reviewedDelivery(task),request=localFollowUpRequest(task,target,'end');
 return target&&review&&request?{...target,reviewed_at:review.reviewed_at,expected_recorded_at:request.expected_recorded_at}:undefined;
}
export function rowFollowUpRequest(task:Task,target:RowFollowUpTarget|undefined):ReturnType<typeof localFollowUpRequest> {
 if(!target||!activeWork(task)||reviewedDelivery(task)?.reviewed_at!==target.reviewed_at)return;
 const request=localFollowUpRequest(task,target,'end');
 if(!request||request.expected_recorded_at!==target.expected_recorded_at)return;
 // Never upgrade the clicked report or marker to one supplied by a later poll.
 return {run_id:target.run_id,report_event_id:target.report_event_id,operation:'end',expected_recorded_at:target.expected_recorded_at};
}

// The explicit opt-in command contains only identifiers/flags, never saved task text.
export function codexTaskBriefCommand(task:Task,address:string|undefined):string|undefined {
 const command=codexRunCommand(task,address);
 return codexTaskBrief(task)&&command?command.replace('codex-run ','codex-run -use-task-brief '):undefined;
}

// Historical content is never used by current evidence/review/follow-up predicates.
export function previousDeliveryEvidence(task:Task):PreviousDeliveryEvidence|undefined {
 const previous=task.previous_delivery_evidence;
 if(task.source!=='local'||task.project_id==='demo'||!previous||previous.run_id!==task.run_id||!previous.report_event_id||previous.report_event_id===currentReadyReportID(task)||!previous.reported_at||Number.isNaN(Date.parse(previous.reported_at))||typeof previous.origin!=='string'||typeof previous.summary!=='string'||Array.from(previous.summary).length>500||!Array.isArray(previous.evidence)||previous.evidence.length>8||!Number.isInteger(previous.total_count)||previous.total_count<Math.max(1,previous.evidence.length)||previous.evidence.some(entry=>!entry||typeof entry!=='object'||['label','url','excerpt','origin'].some(key=>entry[key as keyof Evidence]!==undefined&&typeof entry[key as keyof Evidence]!=='string'))||new TextEncoder().encode(JSON.stringify(previous)).length>32*1024)return;
 const report=task.events?.find(event=>event.id===previous.report_event_id&&event.run_id===task.run_id&&isDeliveryReportKind(event.kind)&&event.created_at===previous.reported_at);
 return report?previous:undefined;
}

export function previousEvidenceUnretained(task:Task):PreviousEvidenceUnretained|undefined {
 const omitted=task.previous_evidence_unretained;
 if(task.source!=='local'||task.project_id==='demo'||!omitted||omitted.reason!=='task_size_limit'||omitted.run_id!==task.run_id||!omitted.report_event_id||omitted.report_event_id===currentReadyReportID(task)||previousDeliveryEvidence(task))return;
 return task.events?.some(event=>event.id===omitted.report_event_id&&event.run_id===task.run_id&&isDeliveryReportKind(event.kind))?omitted:undefined;
}

// Plain text from the exact pinned current delivery only. No references or hidden context.
// Excerpts retain their literal stored contents; this is not a file/byte archive.
export function deliveryHandoffText(task:Task,target:DeliveryReviewTarget|undefined):string|undefined {
 if(!deliveryReviewRequest(task,target))return;
 const report=task.events.find(event=>event.id===target!.report_event_id&&event.run_id===target!.run_id&&isDeliveryReportKind(event.kind));
 if(!report||!report.created_at||Number.isNaN(Date.parse(report.created_at)))return;
 const entries=(task.evidence||[]).map((entry,index)=>{
  const excerpt=evidenceExcerpt(entry);
  const label=entry.label?.trim()||(excerpt?'内联证据':'未提供可审阅内容');
  return `${index+1}. ${label}\n${excerpt?entry.excerpt:entry.url?'链接请在原工作查看':'未提供内联摘录'}`;
 });
 return `本次交付（填报 · 未独立核验）\n工作：${task.title}\n回报时间：${report.created_at}\n来源（填报）：${report.origin?.trim()||'未说明'} · 未独立核验\n\n摘要（填报）：\n${taskSummary(task)||'暂无回报'}\n\n交付证据（填报 · 未独立核验）：\n${entries.join('\n\n')}\n\n仅为当前记录中的文本材料，不是文件或字节归档，不代表验收、完成或文件传输。`;
}

// Project names are explicit local display metadata, not inferred categories/entities.
export const canNameProject=(task:Task)=>task.source==='local'&&task.project_id==='local';
export const projectName=(task:Task)=>canNameProject(task)?task.project_name?.trim()||'':'';
export const validProjectName=(name:string)=>Array.from(name.trim()).length<=60;
export const taskProjectLabel=(task:Task)=>canNameProject(task)?`项目：${projectName(task)||'未归类'}`:undefined;
export function taskProjectView(task:Task):string {
 if(task.source==='synthetic'||task.project_id==='demo')return 'source-demo';
 return canNameProject(task)?'project-name:'+JSON.stringify(projectName(task)):'legacy-project:'+JSON.stringify(task.project_id);
}
export type WorkProjectGroup={key:string;name:string;kind:'local'|'demo'|'legacy';items:Task[]};
export function workProjectGroups(tasks:Task[],projects:Project[]):WorkProjectGroup[] {
 const groups=new Map<string,WorkProjectGroup>();
 for(const task of tasks){
  const key=taskProjectView(task);
  if(!groups.has(key)){
   const kind=key==='source-demo'?'demo':canNameProject(task)?'local':'legacy';
   groups.set(key,{key,kind,name:kind==='demo'?'合成演示':kind==='local'?projectName(task)||'未归类':projects.find(project=>project.id===task.project_id)?.name||'历史记录',items:[]});
  }
  groups.get(key)!.items.push(task);
 }
 const rank={local:0,legacy:1,demo:2};
 return [...groups.values()].sort((a,b)=>rank[a.kind]-rank[b.kind]||a.name.localeCompare(b.name,'zh-CN'));
}
export function projectWorkCounts(items:Task[]) {
 return {active:items.filter(activeWork).length,decision:items.filter(needsDecision).length,issues:items.filter(hasWorkIssue).length,review:items.filter(pendingDeliveryReview).length};
}

// Shared view scope for both displayed work and the opt-in wider-search hint.
export function matchesWorkView(task:Task,view:string):boolean {
 if(view.startsWith('project-name:')||view.startsWith('legacy-project:')||view==='source-demo')return taskProjectView(task)===view;
 return (view!=='attention'||needsDecision(task))&&(view!=='decisions'||task.commands?.length>0)&&(view==='overview'||view==='attention'||view==='decisions'||task.project_id===view);
}
export function hiddenActiveSearchCount(tasks:Task[],view:string,filter:WorkFilter,query:string):number {
 if(filter!=='active'||!query.trim())return 0;
 return tasks.filter(task=>matchesWorkView(task,view)&&matchesTaskSearch(task,query)&&!activeWork(task)).length;
}

// This is only a display eligibility guard. The backend rechecks the transaction.
export type NewAttemptTarget={task_id:string;run_id:string;failed_event_id:string};
export function pinNewAttempt(task:Task):NewAttemptTarget|undefined {
 if(!canNameProject(task)||task.status!=='blocked'||!task.id||!task.run_id||task.codex_launch_notice||task.codex_start||task.codex_binding||task.decision||task.previous_delivery_evidence||task.previous_evidence_unretained||task.delivery_review||task.local_follow_up||task.follow_up_count!==0||!Array.isArray(task.commands)||task.commands.length||!Array.isArray(task.evidence)||task.evidence.length||!Array.isArray(task.events))return;
 const safeKinds=['local_created','local_retry_created','codex-start:','reports:failed'];
 if(task.events.some(event=>!safeKinds.includes(event.kind)))return;
 const current=task.events.filter(event=>event.run_id===task.run_id);
 if(current.length!==3||!['local_created','local_retry_created'].includes(current[0].kind)||current[1].kind!=='codex-start:'||current[2].kind!=='reports:failed'||current[2].origin!=='Codex CLI bridge; no successful delivery claimed'||!current[2].id||task.events.at(-1)!==current[2])return;
 return {task_id:task.id,run_id:task.run_id,failed_event_id:current[2].id};
}
export function newAttemptRequest(task:Task,target:NewAttemptTarget|undefined,confirmedStopped:boolean):{run_id:string;failed_event_id:string;confirm_stopped:true}|undefined {
 if(!confirmedStopped||!target)return;
 const current=pinNewAttempt(task);
 if(!current||current.task_id!==target.task_id||current.run_id!==target.run_id||current.failed_event_id!==target.failed_event_id)return;
 return {run_id:target.run_id,failed_event_id:target.failed_event_id,confirm_stopped:true};
}

// A same-board display link, never an action token or evidence of task state.
export function parseWorkFragment(hash:string):string|undefined {
 const match=/^#work=([^&]*)$/.exec(hash);
 if(!match)return;
 try{const id=decodeURIComponent(match[1]);return id.trim()&&!/[\u0000-\u001f\u007f]/.test(id)?id:undefined}catch{return}
}
export function workItemLink(location:Pick<Location,'origin'|'pathname'>,task:Task):string|undefined {
 if(task.source!=='local'||task.project_id==='demo'||!task.id)return;
 try{
  const url=new URL(location.origin);
  if(!['http:','https:'].includes(url.protocol))return;
  url.pathname=location.pathname;url.search='';url.hash='work='+encodeURIComponent(task.id);
  return parseWorkFragment(url.hash)===task.id?url.href:undefined;
 }catch{return}
}
export function resolveWorkLink(tasks:Task[],id:string|undefined,readSucceeded:boolean):{kind:'none'|'waiting'|'missing'}|{kind:'found';task:Task} {
 if(!id)return {kind:'none'};
 if(!readSucceeded)return {kind:'waiting'};
 const task=tasks.find(task=>task.id===id&&task.source==='local'&&task.project_id!=='demo');
 return task?{kind:'found',task}:{kind:'missing'};
}

// Only explicit fragment navigation owns a pending link open. A card/create open
// or Close cancels it; a successful read consumes it exactly once.
export function workLinkIntent(){
 let pending:string|undefined;
 return {
  navigate(hash:string){pending=parseWorkFragment(hash);return pending!==undefined},
  cancel(){pending=undefined},
  consume(tasks:Task[]){const id=pending;pending=undefined;return resolveWorkLink(tasks,id,true)},
 };
}

// Creation remains the same local-record form; only explicit local name scopes
// supply a default. No inference from origin, query, or legacy/demo group labels.
export function creationProjectName(view:string):string|undefined {
 if(view==='overview')return '';
 if(!view.startsWith('project-name:'))return;
 try{const name=JSON.parse(view.slice('project-name:'.length));return typeof name==='string'&&name===name.trim()&&validProjectName(name)?name:undefined}catch{return}
}
export function projectNameForNewDraft(draft:{title:string;goal:string;projectName:string;touched:boolean},scopedName:string):string {
 return draft.touched||draft.title.trim()||draft.goal.trim()?draft.projectName:scopedName;
}

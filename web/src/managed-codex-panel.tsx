import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {type Task} from './model';
import {
 FOLLOW_UP_LIMIT, managedImageURL, managedPath, managedRequest, managedRequestModeMatches, managedStateLabel,
 parseManagedReceipt, receiptConfirmed, type ManagedAction, type ManagedReceipt, type ManagedRequest,
 type ManagedSnapshot,
} from './managed-codex';
import {ReportFollowUps} from './report-follow-ups-panel';
import {InlineEditor,type InlineEditorHandle} from './inline-editor';
import {inlineText,inlineImageCount,MAX_INLINE_IMAGES,scopedInlineParts,type InlineDraftPart,type InlineSavedPart} from './inline-message';
import {composerFileBase64,MAX_LOCAL_FILES,planComposerFiles} from './composer-files';
import {snapshotRefresh, watchVisibleRefresh} from './refresh';

export type ManagedDraft = {parts: InlineDraftPart[]; sent?: ManagedRequest};
type ManagedContext = {
 snapshot?: ManagedSnapshot; readError: string; submitError: string; loading: boolean; sending: boolean; checked: boolean;
 receipt?: ManagedReceipt; draft: ManagedDraft; changeDraft: (change: (draft: ManagedDraft) => ManagedDraft) => void;
 refresh: () => void; send: (action: ManagedAction) => void; canRetry: boolean;
 receiptModeChanged: boolean; discardOldReceipt: () => void;
};
const Context = createContext<ManagedContext | undefined>(undefined);

class ManagedRequestError extends Error {
 constructor(message: string, readonly status: number) { super(message); }
}
async function readSnapshot(path: string, runID: string, signal: AbortSignal, body?: ManagedRequest): Promise<ManagedSnapshot> {
 const res = await fetch(path,{cache:'no-store',signal,...(body ? {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
 } : {})});
 if (!res.ok) {
  const error = await res.json().catch(() => undefined);
  throw new ManagedRequestError(typeof error?.error === 'string' ? error.error : `请求失败 (${res.status})`, res.status);
 }
 const data = await res.json();
 if (typeof data?.enabled !== 'boolean' || typeof data?.managed !== 'boolean' || typeof data?.can_start !== 'boolean' ||
     typeof data?.can_follow_up !== 'boolean' || !Array.isArray(data?.turns) ||
     (data.mode !== undefined && data.mode !== 'read_only' && data.mode !== 'no_sandbox')) throw new Error('无法读懂 Codex 执行状态');
 if (data.run_id !== runID) throw new Error('事项执行轮次已更新，请先刷新事项');
 return data;
}

export function ManagedCodexProvider({task, drafts, children}: {
 task: Task; drafts: Map<string, ManagedDraft>; children: ReactNode;
}) {
 const key = JSON.stringify([task.id, task.run_id]), path = managedPath(task.id);
 const storageKey = 'awb:managed-receipt:' + key;
 const local = task.source === 'local' && task.project_id !== 'demo';
 const [draft,setDraft] = useState<ManagedDraft>(()=>drafts.get(key) ?? {parts:[]});
 const [snapshot,setSnapshot] = useState<ManagedSnapshot>();
 const [loading,setLoading] = useState(local), [readError,setReadError] = useState(''), [submitError,setSubmitError] = useState('');
 const [sending,setSending] = useState(false), [checked,setChecked] = useState(false);
 const [receipt,setReceipt] = useState(() => {
  try { return parseManagedReceipt(sessionStorage.getItem(storageKey)); }
  catch { return undefined; }
 });
 const pending = useRef(receipt), writing = useRef(false), mounted = useRef(false);
 const reader = useRef<ReturnType<typeof snapshotRefresh<ManagedSnapshot>> | undefined>(undefined);

 function changeDraft(change: (draft: ManagedDraft) => ManagedDraft) {
  const next = change(drafts.get(key) ?? {parts:[]});
  if (next.parts.length || next.sent) drafts.set(key,next);
  else drafts.delete(key);
  if (mounted.current) setDraft(next);
 }
 function forget(known: ManagedReceipt, confirmed: boolean) {
  try {
   const stored = parseManagedReceipt(sessionStorage.getItem(storageKey));
   if (stored?.request_id === known.request_id) sessionStorage.removeItem(storageKey);
  } catch {/* Reload can still confirm a receipt by its turn ID. */}
  if (pending.current?.request_id === known.request_id) {
   pending.current = undefined;
   if (mounted.current) setReceipt(undefined);
  }
  const saved = drafts.get(key);
  if (saved?.sent?.request_id === known.request_id) {
   changeDraft(current=>confirmed && known.action === 'follow_up' ? {parts:[]} : {parts:current.parts});
  } else if (mounted.current) setDraft(saved ?? {parts:[]});
  if (confirmed && mounted.current) setSubmitError('');
 }
 function apply(next: ManagedSnapshot) {
  setSnapshot(next);
  const marker = pending.current;
  if (marker && receiptConfirmed(next,marker)) forget(marker,true);
  else if (marker) {
   // A closed drawer's request can settle after this drawer has been opened.
   // Resync with that instance only after reading an authoritative snapshot.
   try {
    if (!parseManagedReceipt(sessionStorage.getItem(storageKey))) forget(marker,false);
   } catch {/* Keep the receipt until the server confirms it. */}
  }
  setChecked(true);
 }
 useEffect(() => {
  mounted.current = true;
  if (!local) return () => { mounted.current = false; };
  const next = snapshotRefresh<ManagedSnapshot>({
   load: signal => readSnapshot(path,task.run_id,signal), apply, loading: setLoading,
   error: setReadError, canRefresh: () => !writing.current,
   freshness: value => { if (value.stale) setChecked(false); },
  });
  reader.current = next;
  void next.refresh();
  const stop = watchVisibleRefresh(() => void next.refresh(true));
  return () => { mounted.current = false; stop(); next.dispose(); reader.current = undefined; };
 },[path,local]);

 async function submit(action: ManagedAction) {
  if (writing.current || loading || !checked || !snapshot) return;
  const marker = pending.current;
  const saved = drafts.get(key);
  if (marker && (marker.action !== action || (action === 'follow_up' && saved?.sent?.request_id !== marker.request_id))) return;
  if (!(action === 'start' ? snapshot.can_start : snapshot.can_follow_up)) return;
  const message=inlineText(draft.parts);
  const unsafe = snapshot.mode === 'no_sandbox';
  if (action === 'follow_up' && (!draft.parts.length || Array.from(message).length>FOLLOW_UP_LIMIT ||
   (!message.trim() && (unsafe || !inlineImageCount(draft.parts))))) return;
  const nextMarker: ManagedReceipt = marker ?? {action,request_id:crypto.randomUUID(),...(unsafe ? {mode:'no_sandbox'} : {})};
  if (!managedRequestModeMatches(snapshot,nextMarker)) return;
  const payload = marker && saved?.sent?.request_id === marker.request_id ? saved.sent : managedRequest(nextMarker,task.run_id,message,undefined,draft.parts);
  try { sessionStorage.setItem(storageKey,JSON.stringify(nextMarker)); }
  catch { setSubmitError('浏览器无法保存请求编号，尚未发送。'); return; }
  writing.current = true;
  reader.current?.invalidate();
  pending.current = nextMarker;
  setReceipt(nextMarker); setSending(true); setChecked(false); setSubmitError(''); setReadError('');
  changeDraft(current=>({...current,sent:payload}));
  try {
   const next = await readSnapshot(path,task.run_id,AbortSignal.timeout(15000),payload);
   if (!receiptConfirmed(next,nextMarker)) throw new Error('响应未包含对应的执行记录');
   forget(nextMarker,true);
   if (mounted.current) apply(next);
  } catch (e) {
   if (e instanceof ManagedRequestError && [400,403,404,409,413,415].includes(e.status)) {
    forget(nextMarker,false);
    if (mounted.current) setSubmitError(e.message);
   } else if (mounted.current) setSubmitError(`未能确认提交：${(e as Error).message}。不会自动重发，请先刷新核实。`);
  } finally {
   writing.current = false;
   if (mounted.current) { setSending(false); void reader.current?.refresh(); }
  }
 }
 const receiptModeChanged = !!receipt && checked && !!snapshot?.enabled &&
  !managedRequestModeMatches(snapshot,receipt) && !receiptConfirmed(snapshot,receipt);
 const canRetry = !!receipt && checked && !!snapshot && managedRequestModeMatches(snapshot,receipt) &&
  (receipt.action === 'start'
  ? !!snapshot?.can_start
  : !!snapshot?.can_follow_up && draft.sent?.request_id === receipt.request_id);
 return <Context.Provider value={{
  snapshot,readError,submitError,loading,sending,checked,receipt,draft,changeDraft,canRetry,
  receiptModeChanged,discardOldReceipt:()=>{if (receipt && receiptModeChanged && !writing.current) forget(receipt,false);},
  refresh:()=>void reader.current?.refresh(),send:action=>void submit(action),
 }}>{children}</Context.Provider>;
}

function InlineReadback({parts}:{parts:InlineSavedPart[]}) {
 return <div className="inline-message">{parts.map((part,i)=>'text' in part
  ? <span key={i}>{part.text}</span>
  : <img key={i} className="saved-task-screenshot" src={part.image_url} alt="截图" loading="lazy"/>)}</div>;
}

export function ManagedTaskContent({taskID,children}: {taskID: string;children:ReactNode}) {
 const snapshot=useContext(Context)?.snapshot;
 const parts=scopedInlineParts(taskID,snapshot?.initial_parts);
 if(parts)return <InlineReadback parts={parts}/>;
 const url=managedImageURL(taskID,snapshot?.initial_image_url);
 return <>{children}{url&&<img className="saved-task-screenshot" src={url} alt="任务截图"/>}</>;
}

export function ManagedCodexPanel({task}: {task: Task}) {
 const context = useContext(Context)!;
 const {snapshot,readError,submitError,loading,sending,checked,receipt,draft,changeDraft,canRetry,refresh,send,receiptModeChanged,discardOldReceipt} = context;
 const unsafe = snapshot?.mode === 'no_sandbox';
 const editor=useRef<InlineEditorHandle>(null),picker=useRef<HTMLInputElement>(null),pickerAt=useRef<Range>(undefined);
 const picking=useRef(false);
 const [reading,setReading]=useState(false),[imageError,setImageError]=useState('');
 const message=inlineText(draft.parts), images=inlineImageCount(draft.parts), tooLong=Array.from(message).length>FOLLOW_UP_LIMIT;
 async function addImages(files:File[],at?:Range,plain='') {
  if(sending||receipt||picking.current)return;
  if(plain){editor.current?.insert([{text:plain}],at);at=editor.current?.capture();}
  at?.collapse(false);
  const {accepted,errors}=planComposerFiles(files,images,MAX_LOCAL_FILES,MAX_INLINE_IMAGES);
  if(accepted.length!==files.length && !errors.some(error=>error.includes('截图')))errors.push('补充只支持 PNG 或 JPEG 截图。');
  picking.current=true;setReading(true);
  const added:InlineDraftPart[]=[];
  for(const {file,mime} of accepted)if(mime){
   try{added.push({image:{mime_type:mime,data_base64:await composerFileBase64(file)}});}
   catch{errors.push('有截图无法读取，未添加。');}
  }
  editor.current?.insert(added,at,true);
  setImageError(errors.join(' '));picking.current=false;setReading(false);
 }
 const show = snapshot && (snapshot.can_start || snapshot.can_follow_up || snapshot.managed || snapshot.initial_image_url || snapshot.initial_parts || snapshot.turns.length > 0);
 if (task.source !== 'local' || task.project_id === 'demo' || (!show && !receipt && !readError && !submitError && !draft.parts.length)) return null;
 return <section className="brief-section managed-codex" aria-label="Codex 执行">
  <h3>Codex 执行</h3>
  {unsafe && <p><strong>无 Codex 沙箱</strong> · Codex 可用当前电脑账号的权限访问或修改文件。设定工作目录不等于隔离。须有文字指示，截图仅作为参考。</p>}
  {unsafe && task.status === 'not_started' && !task.goal.trim() && (snapshot?.initial_image_url || snapshot?.initial_parts?.length) && <p>无沙箱模式须有文字任务；只有截图的事项可保存，但不能在此模式开工。</p>}
  {snapshot?.can_start && !receipt && <div className="managed-actions">
   <button type="button" className="primary" disabled={loading || sending || !checked} onClick={()=>send('start')}>{unsafe?'开始无沙箱执行':'开始执行'}</button>
   <small>{unsafe?'任务文字及参考截图会发送给 Codex；请先核对。':'任务文字和截图随执行发送给已配置的 Codex。只读检查，不修改工作区。'}</small>
  </div>}
  {receipt && <p role="status">{sending ? '提交中…' : '上次提交待核实。刷新只读取，不会重发。'}</p>}
  {(receipt || readError) && <div className="managed-actions">
   <button type="button" disabled={loading || sending} onClick={refresh}>{loading?'读取中…':'刷新执行状态'}</button>
   {receiptModeChanged && <button type="button" disabled={loading || sending} onClick={discardOldReceipt}>清除不同模式的旧请求标记</button>}
   {canRetry && <button type="button" disabled={loading || sending} onClick={()=>send(receipt!.action)}>重试同一请求</button>}
  </div>}
  {readError && <p className="error" role="alert">未能读取 Codex 状态：{readError}</p>}
  {submitError && <p className="error" role="alert">{submitError}</p>}
  {snapshot && !snapshot.enabled && <p className="muted">本机未启用受管 Codex。已保存的截图和记录仍可查看。</p>}
  {snapshot?.turns.length ? <ol className="managed-turns" aria-label="Codex 执行记录">{snapshot.turns.map(turn => {
   const url = managedImageURL(task.id,turn.image_url), parts=scopedInlineParts(task.id,turn.parts);
   return <li key={turn.id}>
    <strong>{turn.kind==='start'?'首次执行':'补充指示'} · {managedStateLabel[turn.state] || '状态未知'}</strong>
    {parts ? <InlineReadback parts={parts}/> : <>{turn.message && <p>{turn.message}</p>}{url && <img className="saved-task-screenshot" src={url} alt="补充截图" loading="lazy"/>}</>}
    {turn.reply && <p className="managed-reply"><small>Codex 回报</small>{turn.reply}</p>}
   </li>;
  })}</ol> : null}
  {(snapshot?.can_follow_up || draft.parts.length>0) && <form className="managed-composer" onSubmit={e=>{e.preventDefault();if(!picking.current)send('follow_up')}}>
   <InlineEditor editorRef={editor} label="补充给同一个 Codex 会话" placeholder="补充要求、解释问题或验证目标，可在文字中粘贴截图…"
    parts={draft.parts} onChange={parts=>changeDraft(current=>({...current,parts}))} onFiles={(files,at,plain)=>void addImages(files,at,plain)}
    disabled={sending||!!receipt} invalid={tooLong}/>
   <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg" onChange={e=>{
    const files=Array.from(e.currentTarget.files??[]);e.currentTarget.value='';void addImages(files,pickerAt.current);
   }}/>
   <button type="button" disabled={sending||!!receipt||reading||images>=MAX_INLINE_IMAGES} onClick={()=>{pickerAt.current=editor.current?.capture();picker.current?.click()}}>添加截图</button>
   {reading&&<small role="status">正在读取截图…</small>}
   {imageError&&<p role="alert" className="error">{imageError}</p>}
   {tooLong&&<p role="alert" className="error">补充指示最多 2000 字。</p>}
   <small>{unsafe?'须有文字指示，截图仅作参考；沿用同一无沙箱会话。':'文字和截图按原顺序发送给同一个只读会话。'} 最多 3 张截图，每张 4 MiB。</small>
   <button type="submit" className="primary" disabled={loading || sending || !checked || !!receipt || reading || !snapshot?.can_follow_up || tooLong || (!message.trim()&&(unsafe||!images))}>{unsafe?'在无沙箱模式继续':'让 Codex 继续'}</button>
   {!snapshot?.can_follow_up && !receipt && <small>暂不可发送，草稿保留在此页面。</small>}
  </form>}
 </section>;
}

export function CodexCardControls({task}: {task:Task}) {
 const {snapshot,readError} = useContext(Context)!;
 return <><ManagedCodexPanel task={task}/>{(snapshot ? !snapshot.managed : !!readError) && <ReportFollowUps key={task.id} task={task}/>}</>;
}

import {createContext, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {type Task} from './model';
import {
 FOLLOW_UP_LIMIT, managedImageURL, managedPath, managedRequest, managedRequestModeMatches, managedStateLabel,
 parseManagedReceipt, receiptConfirmed, type ManagedAction, type ManagedReceipt, type ManagedRequest,
 type ManagedSnapshot, type ScreenshotInput as Screenshot,
} from './managed-codex';
import {ReportFollowUps} from './report-follow-ups-panel';
import {ScreenshotInput, useScreenshotInput} from './screenshot-input';
import {snapshotRefresh, watchVisibleRefresh} from './refresh';

export type ManagedDraft = {message: string; image?: Screenshot; sent?: ManagedRequest};
type ManagedContext = {
 snapshot?: ManagedSnapshot; readError: string; submitError: string; loading: boolean; sending: boolean; checked: boolean;
 receipt?: ManagedReceipt; draft: ManagedDraft; changeDraft: (change: (draft: ManagedDraft) => ManagedDraft) => void;
 refresh: () => void; send: (action: ManagedAction) => void; canRetry: boolean;
 runCode: string; changeRunCode: (value: string) => void;
 receiptModeChanged: boolean; discardOldReceipt: () => void;
};
const Context = createContext<ManagedContext | undefined>(undefined);
const validRunCode = (value: string) => /^[a-f0-9]{32}$/.test(value.trim());
// Shared by drawers in this tab only. Never write the launch secret to storage.
let tabRunCode = '';

class ManagedRequestError extends Error {
 constructor(message: string, readonly status: number) { super(message); }
}
async function readSnapshot(path: string, runID: string, signal: AbortSignal, body?: ManagedRequest, runCode?: string): Promise<ManagedSnapshot> {
 const res = await fetch(path,{cache:'no-store',signal,...(body ? {
  method:'POST', headers:{'Content-Type':'application/json',...(runCode ? {'X-Workbench-Run-Code':runCode} : {})}, body:JSON.stringify(body),
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
 const [draft,setDraft] = useState<ManagedDraft>(()=>drafts.get(key) ?? {message:''});
 const [snapshot,setSnapshot] = useState<ManagedSnapshot>();
 const [runCode,setRunCode] = useState(tabRunCode);
 const [loading,setLoading] = useState(local), [readError,setReadError] = useState(''), [submitError,setSubmitError] = useState('');
 const [sending,setSending] = useState(false), [checked,setChecked] = useState(false);
 const [receipt,setReceipt] = useState(() => {
  try { return parseManagedReceipt(sessionStorage.getItem(storageKey)); }
  catch { return undefined; }
 });
 const pending = useRef(receipt), writing = useRef(false), mounted = useRef(false);
 const reader = useRef<ReturnType<typeof snapshotRefresh<ManagedSnapshot>> | undefined>(undefined);

 function changeDraft(change: (draft: ManagedDraft) => ManagedDraft) {
  const next = change(drafts.get(key) ?? {message:''});
  if (next.message || next.image || next.sent) drafts.set(key,next);
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
   changeDraft(current=>confirmed && known.action === 'follow_up' ? {message:''} : {message:current.message,image:current.image});
  } else if (mounted.current) setDraft(saved ?? {message:''});
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
  if (action === 'follow_up' && !draft.message.trim() && !draft.image) return;
  const unsafe = snapshot.mode === 'no_sandbox';
  if (unsafe && (!validRunCode(runCode) || (action === 'follow_up' && (draft.image || !draft.message.trim())))) return;
  const nextMarker: ManagedReceipt = marker ?? {action,request_id:crypto.randomUUID(),...(unsafe ? {mode:'no_sandbox'} : {})};
  if (!managedRequestModeMatches(snapshot,nextMarker)) return;
  const sentCode = unsafe ? runCode.trim() : undefined;
  const payload = marker && saved?.sent?.request_id === marker.request_id ? saved.sent : managedRequest(nextMarker,task.run_id,draft.message,draft.image);
  try { sessionStorage.setItem(storageKey,JSON.stringify(nextMarker)); }
  catch { setSubmitError('浏览器无法保存请求编号，尚未发送。'); return; }
  writing.current = true;
  reader.current?.invalidate();
  pending.current = nextMarker;
  setReceipt(nextMarker); setSending(true); setChecked(false); setSubmitError(''); setReadError('');
  changeDraft(current=>({...current,sent:payload}));
  try {
   const next = await readSnapshot(path,task.run_id,AbortSignal.timeout(15000),payload,sentCode);
   if (!receiptConfirmed(next,nextMarker)) throw new Error('响应未包含对应的执行记录');
   if (sentCode) tabRunCode = sentCode;
   forget(nextMarker,true);
   if (mounted.current) apply(next);
  } catch (e) {
   if (e instanceof ManagedRequestError && [400,403,404,409,413,415].includes(e.status)) {
    if (sentCode && e.status === 403) {
     if (tabRunCode === sentCode) tabRunCode = '';
     if (mounted.current) setRunCode('');
    }
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
  (snapshot.mode !== 'no_sandbox' || validRunCode(runCode)) && (receipt.action === 'start'
  ? !!snapshot?.can_start
  : !!snapshot?.can_follow_up && draft.sent?.request_id === receipt.request_id);
 return <Context.Provider value={{
  snapshot,readError,submitError,loading,sending,checked,receipt,draft,changeDraft,canRetry,runCode,changeRunCode:setRunCode,
  receiptModeChanged,discardOldReceipt:()=>{if (receipt && receiptModeChanged && !writing.current) forget(receipt,false);},
  refresh:()=>void reader.current?.refresh(),send:action=>void submit(action),
 }}>{children}</Context.Provider>;
}

export function ManagedTaskScreenshot({taskID}: {taskID: string}) {
 const url = managedImageURL(taskID,useContext(Context)?.snapshot?.initial_image_url);
 return url ? <img className="saved-task-screenshot" src={url} alt="任务截图"/> : null;
}

export function ManagedCodexPanel({task}: {task: Task}) {
 const context = useContext(Context)!;
 const {snapshot,readError,submitError,loading,sending,checked,receipt,draft,changeDraft,canRetry,refresh,send,runCode,changeRunCode,receiptModeChanged,discardOldReceipt} = context;
 const unsafe = snapshot?.mode === 'no_sandbox';
 const codeNeeded = unsafe && !validRunCode(runCode);
 const screenshot = useScreenshotInput(draft.image, image=>changeDraft(current=>({...current,image})));
 const show = snapshot && (snapshot.can_start || snapshot.can_follow_up || snapshot.managed || snapshot.initial_image_url || snapshot.turns.length > 0);
 if (task.source !== 'local' || task.project_id === 'demo' || (!show && !receipt && !readError && !submitError && !draft.message && !draft.image)) return null;
 return <section className="brief-section managed-codex" aria-label="Codex 执行">
  <h3>Codex 执行</h3>
  {unsafe && <p><strong>无 Codex 沙箱</strong> · Codex 可用当前电脑账号的权限访问或修改文件。设定工作目录不等于隔离。本模式不发送截图。</p>}
  {unsafe && task.status === 'not_started' && snapshot?.initial_image_url && <p>此卡含截图，不能在无沙箱模式开始。请新建无截图的文字事项，或切换到只读模式。</p>}
  {unsafe && (snapshot?.can_start || snapshot?.can_follow_up || receipt) && <label className="follow-up-message">本次启动的执行码
   <input type="password" autoComplete="off" spellCheck={false} disabled={sending} value={runCode}
    onChange={e=>changeRunCode(e.currentTarget.value)} placeholder="从工作台启动终端复制"/>
  </label>}
  {snapshot?.can_start && !receipt && <div className="managed-actions">
   <button type="button" className="primary" disabled={loading || sending || !checked || codeNeeded} onClick={()=>send('start')}>{unsafe?'开始无沙箱执行':'开始执行'}</button>
   <small>{unsafe?'确认要执行本卡的文字任务后再开始。':'任务文字和截图随执行发送给已配置的 Codex。只读检查，不修改工作区。'}</small>
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
   const url = managedImageURL(task.id,turn.image_url);
   return <li key={turn.id}>
    <strong>{turn.kind==='start'?'首次执行':'补充指示'} · {managedStateLabel[turn.state] || '状态未知'}</strong>
    {turn.message && <p>{turn.message}</p>}
    {url && <img className="saved-task-screenshot" src={url} alt="补充截图" loading="lazy"/>}
    {turn.reply && <p className="managed-reply"><small>Codex 回报</small>{turn.reply}</p>}
   </li>;
  })}</ol> : null}
  {(snapshot?.can_follow_up || draft.message || draft.image) && <form className="managed-composer" onSubmit={e=>{e.preventDefault();send('follow_up')}}>
   <label className="follow-up-message">补充给同一个 Codex 会话
    <textarea rows={3} maxLength={FOLLOW_UP_LIMIT} value={draft.message} disabled={sending || !!receipt}
     onPaste={unsafe ? undefined : screenshot.onPaste} onChange={e=>{const message=e.currentTarget.value;changeDraft(current=>({...current,message}))}}
     placeholder="补充要求、解释问题或验证目标…"/>
   </label>
   {!unsafe && <ScreenshotInput draft={screenshot} disabled={sending || !!receipt}/>}
   {unsafe && draft.image && <button type="button" disabled={sending || !!receipt} onClick={screenshot.clear}>移除草稿中的截图</button>}
   <small>{unsafe?'只发送文字补充，沿用同一无沙箱会话。':'提交后，文字和截图会交给同一 Codex 会话；仍为只读检查。'}</small>
   <button type="submit" className="primary" disabled={loading || sending || !checked || !!receipt || screenshot.loading || !snapshot?.can_follow_up || codeNeeded || (unsafe ? !!draft.image || !draft.message.trim() : !draft.message.trim() && !draft.image)}>{unsafe?'在无沙箱模式继续':'让 Codex 继续'}</button>
   {!snapshot?.can_follow_up && !receipt && <small>暂不可发送，草稿保留在此页面。</small>}
  </form>}
 </section>;
}

export function CodexCardControls({task}: {task:Task}) {
 const {snapshot,readError} = useContext(Context)!;
 return <><ManagedCodexPanel task={task}/>{(snapshot ? !snapshot.managed : !!readError) && <ReportFollowUps key={task.id} task={task}/>}</>;
}

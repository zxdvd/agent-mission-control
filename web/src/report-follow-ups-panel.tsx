import React,{useEffect,useRef,useState} from 'react';
import {type Task,evidenceLink} from './model';
import {type FollowUpIntent,type ReportFollowUp,followUpTarget,sameReport,followUpStorageKey,parseSavedIntent,followUpInFlight,duplicateFollowUp,followUpStateLabel,followUpPayload,canAbandonFollowUp} from './report-follow-ups';
const indexKey=(id:string)=>'awb:report-follow-up-index:'+id;
function restore(id:string){try{const key=sessionStorage.getItem(indexKey(id));return key?parseSavedIntent(sessionStorage.getItem(key),id):undefined}catch{return undefined}}
function persist(intent:FollowUpIntent){const key=followUpStorageKey(intent);sessionStorage.setItem(key,JSON.stringify(intent));sessionStorage.setItem(indexKey(intent.task_id),key)}
function forget(intent:FollowUpIntent){try{sessionStorage.removeItem(followUpStorageKey(intent));sessionStorage.removeItem(indexKey(intent.task_id))}catch{/* History still comes from server. */}}
async function request<T>(path:string,body?:FollowUpIntent):Promise<T>{const res=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(followUpPayload(body))}:{})});if(!res.ok){const data=await res.json().catch(()=>null);throw new Error(data?.error||`请求失败 (${res.status})`)}return res.json()}
export function ReportFollowUps({task}:{task:Task}){
 const [saved,setSaved]=useState(()=>restore(task.id));
 const [target,setTarget]=useState(()=>saved||followUpTarget(task));
 const [kind,setKind]=useState<'explain'|'adjust'>(saved?.kind||'explain'),[message,setMessage]=useState(saved?.message||'');
 const [records,setRecords]=useState<ReportFollowUp[]>([]),[loaded,setLoaded]=useState(false),[reading,setReading]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),mounted=useRef(true),readingLock=useRef(false);
 const current=followUpTarget(task),stale=!!target&&!sameReport(target,current),path=`/api/tasks/${encodeURIComponent(task.id)}/follow-ups`;
 async function read(){if(readingLock.current)return;readingLock.current=true;setReading(true);try{const next=await request<ReportFollowUp[]>(path);if(!mounted.current)return;if(!Array.isArray(next))throw new Error('跟进历史格式不正确');setRecords(next);setLoaded(true);setError('')}catch(e){if(mounted.current){setLoaded(false);setError('未能读取跟进记录：'+(e as Error).message+'。请先刷新记录，不要重复发送。')}}finally{readingLock.current=false;if(mounted.current)setReading(false)}}
 useEffect(()=>{mounted.current=true;void read();const timer=setInterval(()=>{if(!document.hidden&&!lock.current)void read()},8000);return()=>{mounted.current=false;clearInterval(timer)}},[path]);
 useEffect(()=>{if(!target&&current)setTarget(current)},[current?.run_id,current?.report_event_id]);
 const known=saved&&records.find(r=>r.request_id===saved.request_id),unresolved=!!saved&&!known;
 const locked=!!target&&followUpInFlight(records,target),duplicate=!!target&&duplicateFollowUp(records,{...target,kind,message});
 async function submit(){
  if(lock.current||!target||stale||!loaded||readingLock.current||!message.trim()||locked||duplicate||known)return;
  lock.current=true;setSending(true);setError('');
  const intent=saved||{...target,request_id:crypto.randomUUID(),kind,message:message.trim()};
  try{persist(intent)}catch{setError('无法在此浏览器保存请求编号，尚未发送。请允许会话存储后再试。');lock.current=false;setSending(false);return}
  setSaved(intent);
  try{const record=await request<ReportFollowUp>(path,intent);if(!mounted.current)return;setRecords(old=>[...old.filter(r=>r.request_id!==record.request_id),record]);setMessage('');setSaved(undefined);forget(intent)}
  catch(e){if(mounted.current){setLoaded(false);setError('未能确认跟进是否保存：'+(e as Error).message+'。先刷新记录核实；若没有记录，可明确重试同一请求。')}}
  finally{lock.current=false;if(mounted.current)setSending(false)}
 }
 function abandon(){if(!saved||!canAbandonFollowUp(saved,current,records,loaded)||sending||reading)return;forget(saved);setSaved(undefined);setMessage('');setError('旧指示草稿已放弃，未重发。请另行选择最新回报填写。')}
 function reset(){if(saved)forget(saved);setSaved(undefined);setTarget(current);setMessage('');setKind('explain');setError('')}
 if(task.source!=='local'||task.project_id==='demo')return null;
 return <section className="brief-section report-follow-ups" aria-label="继续跟进">
 <details><summary>继续跟进 <small>{records.length?`${records.length} 条记录`:'可选'}</small></summary>
 <p className="muted">只针对选定回报追加问题或调整要求，不替代原任务、决定或查看记录。只有另行配置的本地 Codex 跟进执行者可以领取；记录成功不保证会执行，也不会自动启动命令。跟进使用独立的新上下文，不代表原执行会话继续。</p>
 {target?<><p className="muted">{stale?'针对原回报':'针对本次交付'}</p><details><summary>回报绑定</summary><small>回报 <code>{target.report_event_id}</code> · 执行 <code>{target.run_id}</code></small></details>{stale&&<p role="alert">当前回报已变化。这份输入仍绑定原回报，不能发送，请先核对跟进记录。</p>}
 <fieldset disabled={sending||stale||unresolved||!!known}><legend>跟进方式</legend><label><input type="radio" name={`follow-up-kind-${task.id}`} checked={kind==='explain'} onChange={()=>setKind('explain')}/>解释一下</label><label><input type="radio" name={`follow-up-kind-${task.id}`} checked={kind==='adjust'} onChange={()=>setKind('adjust')}/>调整 / 补测试</label></fieldset>
 <label className="follow-up-message">{kind==='explain'?'想了解什么？':'希望调整什么？'}<textarea rows={3} maxLength={8000} value={message} disabled={sending||stale||unresolved||!!known} onChange={e=>setMessage(e.target.value)} placeholder={kind==='explain'?'例如：解释一下这次改动的取舍，哪些风险还没验证？':'例如：补上失败路径测试，并说明改动与验证结果。'}/></label>
 <small>{kind==='explain'?'只解释，不授权代码改动。':'调整要求可能涉及代码或测试变更；请写明范围。'}</small>
 {locked&&<p role="status">此回报已有待处理或待核实的跟进，请先查看其结果。</p>}{duplicate&&<p role="status">相同跟进已记录，请查看下方记录，不要重复发送。</p>}
 {unresolved&&<p role="status">保留了上次请求及其编号。刷新只读取记录，不会自动重发。</p>}
 <div className="follow-up-actions">{canAbandonFollowUp(saved,current,records,loaded)&&<button type="button" disabled={sending||reading} onClick={abandon}>放弃旧指示草稿</button>}<button type="button" disabled={sending||reading||!loaded||stale||locked||duplicate||!!known||!message.trim()} onClick={()=>void submit()}>{sending?'正在记录…':unresolved?'重试同一请求':'发送跟进'}</button>{(stale||known)&&!unresolved&&current&&<button type="button" disabled={sending} onClick={reset}>{stale?'核对后针对最新回报填写':'填写新的跟进'}</button>}</div>
 </>:<p className="muted">当前不符合跟进条件。仅可针对有证据的本地 ready 回报且无待决定事项发起；历史记录仍可查看。</p>}
 <div className="follow-up-history"><h4>跟进记录与回复</h4><button type="button" disabled={reading||sending} onClick={()=>void read()}>{reading?'正在读取…':'刷新跟进记录'}</button>{error&&<p role="alert">{error}</p>}{loaded&&!records.length&&<p className="muted">暂无跟进记录。</p>}{records.map(r=><article className="follow-up-record" key={r.request_id}><strong>{r.kind==='explain'?'解释':'调整 / 补测试'} · {followUpStateLabel[r.state]||'未知状态'}</strong><small>{sameReport(r,current)?'针对本次交付':'历史回报 · 非当前交付'}</small><details><summary>回报绑定</summary><small>回报 <code>{r.report_event_id}</code> · 执行 <code>{r.run_id}</code></small></details><small>记录于 {new Date(r.created_at).toLocaleString('zh-CN')}{r.claimed_at?` · 领取于 ${new Date(r.claimed_at).toLocaleString('zh-CN')}`:''}{r.finished_at?` · 回报于 ${new Date(r.finished_at).toLocaleString('zh-CN')}`:''}</small><p className="follow-up-text">{r.message}</p>{r.reply?<div><small>执行者回复（填报，未核验）</small><p className="follow-up-text">{r.reply}</p></div>:<p className="muted">尚无执行者回复。</p>}{r.result_evidence?.map((e,i)=><p key={i}>{e.label} {e.excerpt} {evidenceLink(e)&&<a href={evidenceLink(e)} target="_blank" rel="noopener noreferrer">打开跟进证据 ↗</a>}</p>)}</article>)}</div>
 </details>
 </section>;
}

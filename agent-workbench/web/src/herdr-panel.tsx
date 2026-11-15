import React, { useEffect, useRef, useState } from 'react';
import { observedStatuses, parseHerdrObservation, type HerdrObservation } from './herdr';
const labels:Record<HerdrObservation['kind'],string>={unavailable:'不可用',incompatible:'结构待核实',empty:'已观察 · 列表为空',observed:'已观察到本机执行'};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export function HerdrPanel(){
 const [observation,setObservation]=useState<HerdrObservation|null>(null),[loading,setLoading]=useState(true),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
 const inFlight=useRef(true);
 useEffect(()=>{
  const controller=new AbortController();
  const timeout=window.setTimeout(()=>controller.abort(),10000);
  inFlight.current=true;setLoading(true);setFailed(false);
  void (async()=>{try{
   const response=await fetch('/api/herdr',{signal:controller.signal,cache:'no-store'});
   if(!response.ok)throw new Error('observation unavailable');
   const next=parseHerdrObservation(await response.json());
   if(!controller.signal.aborted)setObservation(next);
  }catch{
   // Keep raw server errors, stderr, and CLI output out of this surface.
   if(!controller.signal.aborted){setObservation(null);setFailed(true)}
  }finally{
   window.clearTimeout(timeout);
   if(!controller.signal.aborted){inFlight.current=false;setLoading(false)}
  }})();
  // A timeout is distinct from effect cleanup: expose it as a failed observation.
  const onAbort=()=>{if(!disposed){setObservation(null);setFailed(true);inFlight.current=false;setLoading(false)}};
  let disposed=false;controller.signal.addEventListener('abort',onAbort);
  return()=>{disposed=true;window.clearTimeout(timeout);controller.abort()};
 },[attempt]);
 const current=!loading&&!failed?observation:null;
 const refresh=()=>{if(inFlight.current)return;inFlight.current=true;setLoading(true);setAttempt(value=>value+1)};
 return <section className="herdr-panel" aria-labelledby="herdr-heading" aria-busy={loading}>
  <div className="herdr-heading"><div><div className="eyebrow">LOCAL HERDR · READ ONLY</div><h2 id="herdr-heading">真实执行观察 <span className="badge gray">与演示任务分开</span></h2></div><button onClick={refresh} disabled={loading} className="refresh">{loading?'正在观察…':'↻ 刷新 Herdr 观察'}</button></div>
  <div role="status" aria-live="polite" className="herdr-status"><span className={'badge '+(current?.kind==='observed'||current?.kind==='empty'?'green':'gray')}>{loading?'正在读取本机列表':failed?'本次观察失败':current?labels[current.kind]:'尚未观察'}</span>{current?.version&&<small>CLI {current.version}</small>}{current?.observed_at&&<small>观察于 {time(current.observed_at)}</small>}</div>
  {loading?<p className="muted">只查询本机列表，不启动或接管执行。</p>:failed?<p className="muted">未取得可验证的列表。请检查本地服务后重试；不使用演示数据替代。</p>:current?.kind==='unavailable'?<p className="muted">本机 Herdr CLI 或服务不可用。未读取到真实执行，不代表没有执行。</p>:current?.kind==='incompatible'?<p className="muted">返回结构尚未识别，暂不显示条目。需核实本机版本与列表 schema；原始内容不会展示。</p>:current?.kind==='empty'?<p className="muted">本次成功读取兼容的列表，返回 0 个条目。不推断其他机器或未被列表发现的执行。</p>:current?.kind==='observed'?<ul className="herdr-entries">{current.entries.map(entry=><li key={entry.id}><div><small>本机执行 ID</small><code>{entry.id}</code></div><div><small>列表报告状态</small><span>{observedStatuses[entry.status]}</span></div><div><small>条目更新时间</small><span>{entry.observed_at?time(entry.observed_at):'未知'}</span></div></li>)}</ul>:null}
  <p className="footnote">只显示已识别列表结构中的执行 ID、状态与时间，不展示目录、标题或原始对话。列表状态不代表业务进展或交付；不会发送指令、审批、合并或部署。不自动轮询，请主动刷新。</p>
 </section>
}

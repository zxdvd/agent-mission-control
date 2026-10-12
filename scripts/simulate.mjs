#!/usr/bin/env node
/** Writes synthetic, visibly named scenarios through the real local API. No production support. */
import { assertLocalWorker, localOrigin, readTestHosts } from './local-fixtures.mjs';
const base = localOrigin();
const hosts = readTestHosts(3).slice(0, 3);
await assertLocalWorker(base);
const batch = crypto.randomUUID();
const now = Date.now();
async function api(path, body, token) {
  const response = await fetch(base + path, {method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Origin:base,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status}; check the isolated Worker and matching host fixture configuration.`);
  return result;
}
async function event(h, {task, session=task, run=task+'-run-1', type, time=now, agent='codex', payload={}, id}) {
  return api('/api/events',{event_id:id||crypto.randomUUID(),timestamp:new Date(time).toISOString(),host_id:h.host_id,agent_type:agent,session_id:`demo-${batch}-${session}`,task_id:`demo-${batch}-${task}`,run_id:`demo-${batch}-${run}`,event_type:type,payload},h.token);
}
const tasks = [
  {host:hosts[0],task:'design-system',name:'Ship design system tokens',project:'Platform',repo:'acme/design-system',branch:'feat/semantic-tokens',type:'turn_started',summary:'Auditing semantic color tokens and component variants.'},
  {host:hosts[0],task:'payments',name:'Review checkout permissions',project:'Commerce',repo:'acme/storefront',branch:'fix/checkout-flow',type:'approval_required',summary:'Awaiting a permission decision in the local agent.'},
  {host:hosts[1],task:'integration',name:'Repair integration tests',project:'Platform',repo:'acme/api',branch:'fix/webhook-retries',type:'task_failed',summary:'The explicitly reported task result failed validation.'},
  {host:hosts[1],task:'docs',name:'Refresh API documentation',project:'Developer experience',repo:'acme/docs',branch:'docs/auth-guide',type:'task_completed',summary:'Documentation task explicitly marked complete.'},
  {host:hosts[2],task:'migration',name:'Plan schema migration',project:'Platform',repo:'acme/api',branch:'plan/schema-v3',type:'waiting_for_input',summary:'Waiting for input in the local agent.'},
  {host:hosts[0],task:'accessibility',name:'Audit keyboard navigation',project:'Experience',repo:'acme/console',branch:'a11y/focus-order',type:'turn_finished',summary:'Latest response finished. Task outcome remains open.'},
];
for (const item of tasks) {
 const payload={name:item.name,project:item.project,repo:item.repo,branch:item.branch,summary:item.summary};
 await event(item.host,{task:item.task,type:'session_started',time:now-120000,payload});
 await event(item.host,{task:item.task,type:'turn_started',time:now-110000,payload});
 await event(item.host,{task:item.task,type:item.type,time:now-5000,payload:{...payload,...(item.type==='task_failed'?{error:'Synthetic fixture: webhook retry assertion did not pass.'}:{})}});
}
for(const h of hosts) await api('/api/events',{event_id:crypto.randomUUID(),timestamp:new Date().toISOString(),host_id:h.host_id,agent_type:'codex',session_id:'host:'+h.host_id,event_type:'heartbeat',payload:{}},h.token);
console.log(`Created ${tasks.length} synthetic tasks across ${hosts.length} preconfigured local test hosts using the real ingestion API.`);
console.log('The dashboard reads persisted D1 data. Refresh the page to verify persistence.');

#!/usr/bin/env node
/** Writes synthetic, visibly named scenarios through the real local API. No production support. */
const base = process.env.AMC_URL || 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Simulation is restricted to a local development server.');
const batch = Date.now().toString(36);
const now = Date.now();
async function api(path, body, token) {
  const response = await fetch(base + path, {method:'POST',headers:{'Content-Type':'application/json',Origin:base,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function host(index, name) {
  const host_id = `demo-${batch}-${index}`;
  const registration = await api('/api/admin/hosts', {host_id, name});
  return {host_id, token:registration.token};
}
const hosts = await Promise.all([host(1,'Studio · macOS'),host(2,'Build node · Linux'),host(3,'Travel laptop')]);
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
console.log(`Created ${hosts.length} synthetic hosts and ${tasks.length} tasks using the real local ingestion API.`);
console.log('The dashboard reads persisted D1 data. Refresh the page to verify persistence.');

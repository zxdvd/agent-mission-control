#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertLocalWorker, localOrigin, readTestHosts } from './local-fixtures.mjs';
const base=localOrigin();
const [a,b]=readTestHosts(2);
const { csrf_token: csrfToken }=await assertLocalWorker(base);
if(typeof csrfToken!=='string'||!csrfToken) throw new Error('Local Worker did not provide a dashboard CSRF token.');
const prefix='test-'+crypto.randomUUID(), time=Date.now();
let checks=0;
function check(condition,message){assert.ok(condition,message);checks++;console.log('PASS',message);}
async function request(path,{method='GET',body,token,headers={}}={}){const r=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Origin:base,'X-CSRF-Token':csrfToken,...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...headers},body:body?JSON.stringify(body):undefined});let data;try{data=await r.json();}catch{data=null;}return{status:r.status,data};}
const task=prefix+'-task',session=prefix+'-session',run=prefix+'-run';
function event(type,offset=0,extra={}){return{event_id:crypto.randomUUID(),timestamp:new Date(time+offset).toISOString(),host_id:a.host_id,agent_type:'codex',session_id:session,task_id:task,run_id:run,event_type:type,payload:{name:'Integration task',project:'Validation'},...extra};}
const post=(e,token=a.token)=>request('/api/events',{method:'POST',body:e,token});
let r=await post(event('session_started',-10000));check(r.status<300,'session event accepted');
r=await request('/api/events',{method:'POST',token:b.token,body:{event_id:crypto.randomUUID(),timestamp:new Date(time).toISOString(),host_id:b.host_id,agent_type:'codex',session_id:'host:'+b.host_id,event_type:'heartbeat',payload:{}}});check(r.status<300,'second fixed host credential independently accepted');
r=await post(event('turn_started',-9000));check(r.status<300,'turn started accepted');
const repeated=event('turn_finished',-8000);const copies=await Promise.all(Array.from({length:8},()=>post(repeated)));check(copies.every(x=>x.status<300),'concurrent duplicate delivery accepted idempotently');
r=await request('/api/tasks/'+task);check(r.data.task.status==='active'&&r.data.task.activity==='idle','turn_finished is idle, not completed');
check(r.data.events.filter(x=>(x.event_id||x.id)===repeated.event_id).length===1,'D1 timeline contains duplicate only once');
r=await post(event('approval_required',-7000,{payload:{name:'Integration task'}}));check(r.status<300,'permission observation accepted');
await post(event('heartbeat',-6000));await post(event('turn_finished',-5000));
r=await request('/api/tasks/'+task);check(r.data.task.attention!=='none','heartbeat and turn end do not clear observed approval');
r=await post(event('task_completed',-4000,{payload:{summary:'Explicit validated completion'}}));check(r.status<300,'explicit completion accepted');
await post(event('turn_started',-8500));r=await request('/api/tasks/'+task);check(r.data.task.status==='completed','late turn event cannot reverse terminal task outcome');
r=await post(event('turn_started',-3000,{host_id:b.host_id}),a.token);check(r.status===401||r.status===403,'host token cannot impersonate another host');
r=await post(event('turn_started',-3000,{host_id:b.host_id}),b.token);check(r.status>=400&&r.status<500,'cross-host task/session identity reuse rejected');
r=await post(event('turn_started',-3000,{payload:{prompt:'DO NOT STORE THIS',transcript_path:'/private/transcript',command:'secret-command'}}));check(r.status>=400&&r.status<500,'non-allowlisted sensitive event payload rejected');
r=await post(event('unknown_event'));check(r.status>=400&&r.status<500,'unknown event type rejected');
r=await post(event('turn_started',365*86400000));check(r.status>=400&&r.status<500,'unreasonably future timestamp rejected');
r=await request('/api/events',{method:'POST',body:event('turn_started')});check(r.status===401||r.status===403,'ingest requires independent credential even in local mode');
const independent=await Promise.all(Array.from({length:12},(_,i)=>post(event('turn_started',-2000,{event_id:crypto.randomUUID(),session_id:prefix+'-session-'+i,task_id:prefix+'-task-'+i,run_id:prefix+'-run-'+i,payload:{name:'Parallel task '+i}}),a.token)));check(independent.every(x=>x.status<300),'twelve concurrent sessions remain separately ingestible');
r=await request('/api/overview');check(r.status===200&&r.data.tasks.filter(x=>x.id.startsWith(prefix+'-task-')).length===12,'concurrent sessions project into twelve independent tasks');
r=await request('/api/tasks/'+task,{method:'PATCH',body:{name:'Renamed safely',archived:true}});check(r.status<300,'rename and archive mutation accepted');
r=await request('/api/tasks/'+task);check(r.data.task.name==='Renamed safely'&&Boolean(r.data.task.archived),'renamed archived task remains readable with timeline');
r=await request('/api/tasks/'+task,{method:'PATCH',body:{archived:false}});check(r.status<300,'archive is reversible');
r=await request('/api/tasks/'+task,{method:'PATCH',body:{name:'forged'},headers:{'X-CSRF-Token':''}});check(r.status===403,'same-origin dashboard mutation requires CSRF token');
r=await request('/api/tasks/'+task,{method:'PATCH',body:{name:'forged'},headers:{'X-CSRF-Token':'synthetic-invalid-csrf'}});check(r.status===403,'incorrect dashboard CSRF token rejected');
r=await request('/api/tasks/'+task,{method:'PATCH',body:{name:'forged'},headers:{Origin:'https://evil.invalid'}});check(r.status===403,'cross-origin dashboard mutation rejected');
r=await post(event('heartbeat'),'amc_synthetic_unknown_'+crypto.randomUUID());check(r.status===401||r.status===403,'unconfigured fixed credential rejected');
r=await request('/api/admin/hosts',{method:'POST',body:{host_id:prefix+'-forbidden',name:'Forbidden runtime registration'}});check(r.status===404,'runtime host credential registration is unavailable');
r=await request('/api/admin/hosts/'+a.host_id+'/credential',{method:'DELETE'});check(r.status===404,'runtime host credential revocation is unavailable');
r=await post(event('heartbeat'));check(r.status<300,'fixed credential remains valid after nonexistent revocation route');
// Removal/rotation is a Worker Secret configuration change, covered by backend tests.
console.log(`\n${checks} real Worker / D1 integration checks passed.`);

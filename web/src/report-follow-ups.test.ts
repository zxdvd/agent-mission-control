import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Task} from './model.ts';
import {followUpTarget,sameReport,parseSavedIntent,followUpStorageKey,followUpInFlight,duplicateFollowUp,followUpStateLabel,followUpPayload,canAbandonFollowUp,type ReportFollowUp} from './report-follow-ups.ts';
const task=():Task=>({id:'work / 中文',run_id:'r1',source:'local',project_id:'local',title:'Work',goal:'',status:'ready',summary:'',updated_at:'',observed_at:'',evidence:[{excerpt:'tests passed'}],decision:null,follow_up_count:0,commands:[],events:[{id:'report1',run_id:'r1',kind:'reports:ready',message:'',created_at:''}]});
const intent=()=>({...followUpTarget(task())!,request_id:'stable-client-id',kind:'adjust' as const,message:'补失败路径测试'});
const record=(state:ReportFollowUp['state']='pending'):ReportFollowUp=>({...intent(),state,created_at:'2026-11-17T10:00:00Z'});
test('composer only binds evidence-backed local ready reports without a decision',()=>{
 const t=task(),before=JSON.stringify(t);assert.deepEqual(followUpTarget(t),{task_id:t.id,run_id:'r1',report_event_id:'report1'});assert.equal(JSON.stringify(t),before);
 for(const override of [{source:'synthetic'},{project_id:'demo'},{evidence:[]},{status:'working'},{run_id:'r2'},{decision:{question:'Approve?',options:['yes']}}])assert.equal(followUpTarget({...t,...override}),undefined);
 assert.equal(followUpTarget({...t,events:[...t.events,{id:'new',run_id:'r1',kind:'reports:blocked',message:'',created_at:''}]}),undefined);
});
test('report pinning never treats changed task, run or report as the same target',()=>{
 const t=followUpTarget(task())!;assert.ok(sameReport(t,{...t}));
 for(const change of [{task_id:'else'},{run_id:'r2'},{report_event_id:'report2'}])assert.equal(sameReport(t,{...t,...change}),false);
 assert.equal(sameReport(t,undefined),false);
});
test('reload restores exact immutable request ID and body, never generates a new ID',()=>{
 const i=intent(),raw=JSON.stringify(i);assert.deepEqual(parseSavedIntent(raw,i.task_id),i);assert.equal(parseSavedIntent(raw,'wrong-task'),undefined);
 for(const bad of [null,'null','{','{}',JSON.stringify({...i,kind:'command'}),JSON.stringify({...i,request_id:''})])assert.equal(parseSavedIntent(bad,i.task_id),undefined);
 assert.notEqual(followUpStorageKey(i),followUpStorageKey({...i,run_id:'r2'}));assert.notEqual(followUpStorageKey(i),followUpStorageKey({...i,report_event_id:'report2'}));
});
test('in-flight and uncertain outcomes block new follow-ups on their bound report only',()=>{
 for(const state of ['pending','running','uncertain'] as const)assert.ok(followUpInFlight([record(state)],intent()));
 for(const state of ['completed','blocked'] as const)assert.equal(followUpInFlight([record(state)],intent()),false);
 assert.equal(followUpInFlight([record()],{...intent(),report_event_id:'new-report'}),false);
});
test('identical submissions stay duplicates even after completion; older report replies stay separate',()=>{
 assert.ok(duplicateFollowUp([record('completed')],{...intent(),message:'  补失败路径测试  '}));
 assert.equal(duplicateFollowUp([record()],{...intent(),kind:'explain'}),false);
 assert.equal(duplicateFollowUp([record()],{...intent(),report_event_id:'report2'}),false);
 assert.equal(duplicateFollowUp([record()],{...intent(),message:'其他测试'}),false);
});
test('status wording does not turn receipt into guaranteed execution or human acceptance',()=>{
 assert.match(followUpStateLabel.pending,/已记录/);assert.match(followUpStateLabel.running,/待确认/);assert.match(followUpStateLabel.completed,/未独立核验/);
});

test('strict POST body excludes task scope and private or response-only fields',()=>{
 const i=intent();assert.deepEqual(Object.keys(followUpPayload(i)),['request_id','run_id','report_event_id','kind','message']);assert.deepEqual(followUpPayload(record()),followUpPayload(i));assert.deepEqual(followUpPayload(parseSavedIntent(JSON.stringify(i),i.task_id)!),followUpPayload(i));
});

test('only a verified absent stale saved intent may be explicitly abandoned',()=>{
 const saved=intent(),current={...saved,report_event_id:'new-report'};
 assert.ok(canAbandonFollowUp(saved,current,[],true));
 assert.equal(canAbandonFollowUp(saved,current,[],false),false);
 assert.equal(canAbandonFollowUp(saved,current,[record()],true),false);
 assert.equal(canAbandonFollowUp(saved,saved,[],true),false);
 assert.equal(canAbandonFollowUp(undefined,current,[],true),false);
 assert.ok(canAbandonFollowUp(saved,undefined,[],true));
});

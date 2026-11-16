import {test} from 'node:test';
import assert from 'node:assert/strict';
import {type Task,hiddenLocalWork,localVisibilityMarker,pinLocalVisibility,localVisibilityRequest,lastSubstantiveReportID,matchesWorkFilter,projectWorkCounts,workProjectGroups,goalWorkLinks,sameBoardWorkLink,pinNewAttempt,newAttemptRequest,previousBlockedAttempts,taskNoticeKey} from './model.ts';
import {latestProjectReport} from './project-report.ts';
const task=():Task=>({id:'example-work',run_id:'r1',project_id:'local',source:'local',project_name:'Example Project',status:'not_started',title:'Example work',goal:'Example goal',summary:'',updated_at:'2026-11-16T10:00:00Z',observed_at:'2026-11-16T10:00:00Z',evidence:[],decision:null,follow_up_count:0,commands:[],events:[]});
const report=(id='report',run_id='r1',kind='reports:failed')=>({id,run_id,kind,message:'Stopped outcome',created_at:'2026-11-16T10:01:00Z'});
const hidden=(t:Task):Task=>({...t,local_visibility:{run_id:t.run_id,state:'hidden',recorded_at:'2026-11-16T10:02:00Z',last_report_event_id:lastSubstantiveReportID(t),launch_notice_recorded_at:t.codex_launch_notice?.recorded_at||''}});
test('hide is reversible local display metadata, excluded active/issues/latest but findable All',()=>{
 for(const status of ['not_started','blocked']){
  const t=hidden({...task(),status,events:status==='blocked'?[report()]:[]}),before=JSON.stringify(t),target=pinLocalVisibility(t);
  assert.equal(hiddenLocalWork(t),true);assert.equal(matchesWorkFilter(t,'active'),false);assert.equal(matchesWorkFilter(t,'issues'),false);assert.equal(matchesWorkFilter(t,'all'),true);
  assert.deepEqual(projectWorkCounts([t]),{active:0,decision:0,issues:0,review:0});
  assert.equal(latestProjectReport(workProjectGroups([t],[])[0]),undefined);
  assert.deepEqual(localVisibilityRequest(t,target,'restore'),{run_id:'r1',operation:'restore',expected_recorded_at:'2026-11-16T10:02:00Z',last_report_event_id:status==='blocked'?'report':'',launch_notice_recorded_at:''});
  assert.equal(hiddenLocalWork({...t,local_visibility:{...t.local_visibility!,state:'visible'}}),false);assert.equal(JSON.stringify(t),before);
 }
});
test('hide pins exact task/run/status/report/version and receipts do not unhide',()=>{
 const t=hidden({...task(),status:'blocked',events:[report()]}),target=pinLocalVisibility(t);
 assert.equal(hiddenLocalWork({...t,events:[...t.events,report('receipt','r1','reports:receipt')]}),true);
 for(const change of [{id:'other'},{run_id:'r2'},{status:'working'},{events:[...t.events,report('new')]},{local_visibility:{...t.local_visibility!,recorded_at:'2026-11-16T10:03:00Z'}}])assert.equal(localVisibilityRequest({...t,...change},target,'restore'),undefined);
 for(const status of ['working','needs_evidence','ready','needs_decision','done'])assert.equal(pinLocalVisibility({...t,status}),undefined);
 assert.equal(pinLocalVisibility({...t,source:'synthetic'}),undefined);assert.equal(pinLocalVisibility({...t,project_id:'demo'}),undefined);
 assert.equal(localVisibilityMarker({...t,events:[...t.events,report('new')]}),undefined);
 assert.equal(localVisibilityRequest({...t,codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-16T10:04:00Z'}},target,'restore'),undefined);
 assert.equal(hiddenLocalWork({...t,codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-16T10:04:00Z'}}),false);
 assert.equal(pinLocalVisibility({...t,decision:{question:'Choose',options:['yes']}}),undefined);
 const legacy={...t,local_visibility:{...t.local_visibility!,revision:'legacy-v45-token'}};assert.equal(hiddenLocalWork(legacy),false);assert.equal(pinLocalVisibility(legacy)?.expected_recorded_at,'');
});
const location={origin:'http://127.0.0.1:8787',pathname:'/workbench'};
test('goal links preserve literal text and activate only exact same-board work fragments',()=>{
 const exact='http://127.0.0.1:8787/workbench#work='+encodeURIComponent('opaque/a?b&🙂');
 assert.equal(sameBoardWorkLink(exact,location),'opaque/a?b&🙂');
 const punctuation="http://127.0.0.1:8787/workbench#work=literal'paren(x)";assert.equal(goalWorkLinks(punctuation,location)[0].taskID,"literal'paren(x)");assert.equal(sameBoardWorkLink('#work=local',location),'local');
 for(const raw of ['https://elsewhere.example/workbench#work=x','http://localhost:8787/workbench#work=x','http://127.0.0.1:8787/other#work=x','http://127.0.0.1:8787/workbench?run=bad#work=x','http://user@127.0.0.1:8787/workbench#work=x','#work=x&action=start','#work=%00x','/workbench#work=x','javascript:alert(1)'])assert.equal(sameBoardWorkLink(raw,location),undefined,raw);
 const goal=`First ${exact}\nthen https://elsewhere.example/#work=x and #work=local。`;
 const parts=goalWorkLinks(goal,location);assert.equal(parts.map(part=>part.text).join(''),goal);assert.deepEqual(parts.filter(part=>part.taskID).map(part=>part.taskID),['opaque/a?b&🙂','local']);
});
function nativeFailure():Task{
 const start={run_id:'r1',native_thread_id:'01234567-89ab-4cde-8123-456789abcdef',observed_at:'2026-11-16T10:00:01Z'};
 const origin=`Codex CLI native thread ${start.native_thread_id}; model-declared blocked diagnosis and evidence, not independent verification`;
 return {...task(),status:'blocked',summary:'Stopped outcome',observed_at:'2026-11-16T10:01:00Z',codex_start:start,evidence:[{label:'Diagnostic',excerpt:'Exact native diagnosis',origin}],events:[{...report('created','r1','local_created'),created_at:'2026-11-16T10:00:00Z'},{...report('claimed','r1','codex-start:'),created_at:'2026-11-16T10:00:00Z'},{...report(),origin}]};
}
test('exact stopped first-native failure can prepare retry while preserving separate immutable history',()=>{
 const t=nativeFailure(),before=JSON.stringify(t),target=pinNewAttempt(t);assert.ok(target);
 assert.equal(newAttemptRequest(t,target,false),undefined);assert.deepEqual(newAttemptRequest(t,target,true),{run_id:'r1',failed_event_id:'report',confirm_stopped:true});
 const next={...t,run_id:'r2',status:'not_started',summary:'',codex_start:undefined,evidence:[],previous_blocked_attempts:[{run_id:'r1',report_event_id:'report',codex_start:t.codex_start!,evidence:t.evidence}]};
 assert.equal(previousBlockedAttempts(next).length,1);assert.equal(previousBlockedAttempts(next)[0].evidence[0].excerpt,'Exact native diagnosis');assert.equal(newAttemptRequest(next,target,true),undefined);assert.notEqual(taskNoticeKey(next),taskNoticeKey(t));assert.equal(JSON.stringify(t),before);
 for(const change of [{summary:'Other'},{observed_at:'2026-11-16T10:01:01Z'},{codex_start:{...t.codex_start!,observed_at:'2026-11-16T10:02:00Z'}},{evidence:[{label:'Diagnostic',excerpt:'Different source',origin:'manual'}]},{previous_blocked_attempts:[{run_id:'r1',report_event_id:'report',codex_start:t.codex_start!,evidence:[]}]},{events:[...t.events,report('extra')]},{decision:{question:'Choose',options:['yes']}}])assert.equal(pinNewAttempt({...t,...change}),undefined);
});

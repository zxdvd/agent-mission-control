import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codeDelivery,codeReviewLink} from './code-delivery.ts';
import {type Task} from './model.ts';
const mr='https://example.test/group/repo/-/merge_requests/12';
const cr='https://example.test/c/sample/repo/+/34';
const pr='https://github.com/example/repo/pull/56';
const task=():Task=>({id:'work',run_id:'run',source:'local',project_id:'local',title:'Example work',goal:'',status:'ready',summary:'Reported outcome',updated_at:'2026-11-16T12:00:00Z',observed_at:'2026-11-16T12:00:00Z',evidence:[{excerpt:'Reported evidence'}],decision:null,follow_up_count:0,commands:[],events:[{id:'ready-report',run_id:'run',kind:'reports:ready',message:'Reported outcome',created_at:'2026-11-16T12:00:00Z'}]});
test('review URLs recognize only distinctive routes and canonicalize review roots',()=>{
 assert.deepEqual(codeReviewLink(mr+'/diffs?access_token=omit#note'),{kind:'MR',number:'12',url:mr});
 assert.deepEqual(codeReviewLink(cr+'/3/file.ts?tab=patch#old'),{kind:'CR',number:'34',url:cr});
 assert.deepEqual(codeReviewLink(pr+'/files?diff=split#note'),{kind:'PR',number:'56',url:pr});
 assert.equal(codeReviewLink('https://example.test/other/#/c/78'),undefined);
 assert.deepEqual(codeReviewLink('https://example.test/gerrit/#/c/78'),{kind:'CR',number:'78',url:'https://example.test/gerrit/#/c/78'});
 assert.deepEqual(codeReviewLink('http://example.test/#/c/78/2'),{kind:'CR',number:'78',url:'http://example.test/#/c/78'});
 assert.deepEqual(codeReviewLink(mr.replace('https:','http:')),{kind:'MR',number:'12',url:mr.replace('https:','http:')});
});
test('unsafe, malformed, disguised or unknown review references remain inert',()=>{
 for(const raw of ['javascript:'+mr,'data:text/plain,'+mr,'//example.test/group/repo/-/merge_requests/12',mr.replace('https://','https://user:password@'),mr+'\\evil',mr+'\n',mr+'\u0000',mr+'/actions',mr+'evil',mr.replace('/12','/0'),pr.replace('github.com','github.com.example.test'),pr.replace('github.com','example.test'),'https://example.test/evidence'])assert.equal(codeReviewLink(raw),undefined,raw);
});
test('current evidence URL, label and excerpt links are extracted and deduplicated without mutation',()=>{
 const t={...task(),evidence:[{url:mr+'/diffs?private=omitted',label:'Review '+mr},{excerpt:`Review: [change](${cr}/2), PR ${pr}.\nAgain ${mr}#note`} ]};
 const before=JSON.stringify(t);
 assert.deepEqual(codeDelivery(t),{links:[{kind:'MR',number:'12',url:mr},{kind:'CR',number:'34',url:cr},{kind:'PR',number:'56',url:pr}],localPatch:false});
 assert.equal(JSON.stringify(t),before);
 const disguised={...task(),evidence:[{excerpt:'javascript:'+mr+'\nnothttps://example.test/group/repo/-/merge_requests/12'}]};
 assert.deepEqual(codeDelivery(disguised).links,[]);
});
test('goal, summary, historic evidence, old runs and nonready claims cannot populate delivery row',()=>{
 const t=task();
 for(const status of ['working','blocked','not_started','needs_evidence','unknown','done'])assert.deepEqual(codeDelivery({...t,status,evidence:[{url:mr}]}),{links:[],localPatch:false});
 assert.deepEqual(codeDelivery({...t,goal:mr,summary:mr,events:[...t.events,{...t.events[0],id:'old',run_id:'old',message:mr}],previous_delivery_evidence:{run_id:'run',report_event_id:'old',reported_at:'2026-11-16T11:00:00Z',origin:'Fixture',summary:mr,summary_truncated:false,total_count:1,evidence:[{url:mr}]}}),{links:[],localPatch:false});
 for(const change of [{events:[]},{events:[{...t.events[0],run_id:'other'}]},{events:[...t.events,{...t.events[0],id:'newer',kind:'reports:progress'}]},{source:'synthetic'},{project_id:'demo'}])assert.deepEqual(codeDelivery({...t,...change,evidence:[{url:mr}]}),{links:[],localPatch:false});
 assert.equal(codeDelivery({...t,events:[{...t.events[0],kind:'reports:completed'}],evidence:[{url:mr}]}).links.length,1);
});
test('local patch indication requires an exact explicit evidence label with content',()=>{
 const t=task();
 for(const label of ['本地补丁','Local patch',' local PATCH '])assert.equal(codeDelivery({...t,evidence:[{label,excerpt:'Diff retained locally'}]}).localPatch,true);
 for(const entry of [{label:'本地补丁'},{label:'Local patch plan',excerpt:'Plan only'},{label:'Result',excerpt:'There might be a Local patch later'},{label:'No 本地补丁',excerpt:'None'},{label:'Local patch',url:'javascript:alert(1)'}])assert.equal(codeDelivery({...t,evidence:[entry]}).localPatch,false);
 assert.equal(codeDelivery({...t,status:'blocked',evidence:[{label:'Local patch',excerpt:'Diff retained locally'}]}).localPatch,false);
});

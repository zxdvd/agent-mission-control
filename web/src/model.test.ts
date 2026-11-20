import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answered, pending, needsDecision, states, taskBadge, evidenceLink, evidenceOrigin, evidenceExcerpt, taskOrigin, shellArgument, loopbackCLIAddress, canContinueCodex, codexRunCommand, canNameProject, projectName, validProjectName, taskProjectLabel, taskProjectView, workProjectGroups, projectWorkCounts, matchesWorkFilter, matchesWorkView, hiddenActiveSearchCount, matchesTaskSearch, hasWorkIssue, reviewEvidencePreview, codexStartObservation, taskSummary, codexLaunchNotice, codexTaskBrief, codexTaskBriefCommand, currentReadyReportID, reviewedDelivery, previousDeliveryEvidence, previousEvidenceUnretained, pendingDeliveryReview, activeWork, localFollowUpMarker, endedLocalFollowUp, localFollowUpRequest, pinRowFollowUp, rowFollowUpRequest, pinDeliveryReview, deliveryReviewRequest, deliveryHandoffText, pinNewAttempt, newAttemptRequest, parseWorkFragment, workItemLink, resolveWorkLink, workLinkIntent, creationProjectName, type Task, type Command } from './model.ts';
const task=():Task=>({id:'t',project_id:'p',title:'test',goal:'test',status:'needs_decision',run_id:'r1',summary:'',updated_at:'2026-01-01',observed_at:'2026-01-01',evidence:[],decision:{question:'Keep scope?',options:['yes','no']},follow_up_count:0,events:[],commands:[]});
const command=(status='recorded'):Command=>({id:'c',kind:'decision',run_id:'r1',question:'Keep scope?',status,message:'yes',created_at:'2026-01-01'});
test('new question needs user direction',()=>assert.equal(needsDecision(task()),true));
test('recorded decision removes repeated prompt but is still pending receipt',()=>{const t=task();t.commands=[command()];assert.equal(needsDecision(t),false);assert.equal(pending(t),true);assert.equal(t.status,'needs_decision')});
test('acknowledgement does not create another prompt or imply completion',()=>{const t=task();t.commands=[command('acknowledged')];assert.equal(answered(t),true);assert.equal(pending(t),false);assert.equal(t.status,'needs_decision')});
test('a new question is not covered by the previous answer',()=>{const t=task();t.commands=[command()];t.decision!.question='Expand scope?';assert.equal(needsDecision(t),true)});
test('an answer to another run cannot suppress this run question',()=>{const t=task();t.commands=[{...command(),run_id:'r0'}];assert.equal(answered(t),false)});
test('follow-up is not a direction answer',()=>{const t=task();t.commands=[{...command(),kind:'follow_up'}];assert.equal(answered(t),false)});
test('ready means pending review, not done',()=>{assert.notEqual(states.ready[0],states.done[0]);assert.match(states.ready[0],/待审/)});
test('blocked has an explicit label',()=>assert.equal(states.blocked[0],'执行受阻'));

test('evidence links allow HTTP(S) with a host and stay inert for local/unsafe references',()=>{
 for(const url of ['https://example.test/log','http://127.0.0.1:8787/log',' HTTPS://example.test/log '])assert.equal(evidenceLink({url}),url.trim());
 for(const url of ['','file:///tmp/result.txt','/tmp/result.txt','#synthetic-evidence','javascript:alert(1)','data:text/html,test','https:///','https:///result','https://example.test\\path','https:example.test','https://example.test/\nresult'])assert.equal(evidenceLink({url}),undefined,url);
});
test('inline evidence excerpt is optional text, not a file read or HTML render',()=>{
 assert.equal(evidenceExcerpt({url:'file:///not/read/result.txt'}),undefined);
 assert.equal(evidenceExcerpt({excerpt:'  8 tests passed.\n<em>report text</em>  '}),'8 tests passed.\n<em>report text</em>');
 assert.equal(evidenceExcerpt({excerpt:' \t\n '}),undefined);
});
test('reported origin never claims independent verification',()=>{
 assert.equal(evidenceOrigin({}),'来源（填报）：执行者回报 · 未独立核验');
 assert.equal(evidenceOrigin({origin:'  隔离 fixture 执行者  '}),'来源（填报）：隔离 fixture 执行者 · 未独立核验');
 assert.match(evidenceOrigin({origin:'verified'}),/未独立核验$/);
 assert.match(evidenceOrigin({label:'合成测试记录',url:'#synthetic-evidence',origin:'合成演示'}),/合成演示.*未独立核验/);
});

test('saved decision badge stops asking for a decision without changing task truth',()=>{
 const t=task();assert.equal(taskBadge(t)[0],'需要你的决定');
 t.commands=[command()];assert.equal(taskBadge(t)[0],'决定已记录 · 待回执');assert.equal(needsDecision(t),false);assert.equal(t.status,'needs_decision');
 for(const status of ['acknowledged','received']){t.commands=[command(status)];assert.equal(taskBadge(t)[0],'决定已回执 · 等进展');assert.equal(t.status,'needs_decision')}
 t.decision!.question='Another question?';assert.equal(taskBadge(t)[0],'需要你的决定');
 t.status='ready';assert.equal(taskBadge(t)[0],states.ready[0]);
});

test('new local work does not imply started execution and provenance stays distinct',()=>{
 const local={...task(),status:'not_started',source:'local',origin:'Owner-created fixture'};
 assert.match(taskBadge(local)[0],/尚未开始/);
 assert.match(taskOrigin(local),/本地工作.*Owner-created fixture/);
 assert.match(taskOrigin({...task(),source:'synthetic'}),/合成演示/);
});


test('terminal examples quote all dynamic arguments as one literal shell argument',()=>{
 assert.equal(shellArgument('work-123'),"'work-123'");
 assert.equal(shellArgument("a'$(touch /tmp/no);\n"),"'a'\\''$(touch /tmp/no);\n'");
});
test('terminal examples only use explicit loopback addresses with validated ports',()=>{
 const location={hostname:'localhost',port:'8787',protocol:'http:'};
 assert.equal(loopbackCLIAddress(location),'127.0.0.1:8787');
 assert.equal(loopbackCLIAddress({...location,hostname:'[::1]'}),'[::1]:8787');
 assert.equal(loopbackCLIAddress({...location,hostname:'::1'}),'[::1]:8787');
 assert.equal(loopbackCLIAddress({...location,hostname:'127.0.0.1',port:''}),'127.0.0.1:80');
 assert.equal(loopbackCLIAddress({...location,port:'',protocol:'https:'}),'127.0.0.1:443');
 for(const hostname of ['example.com','127.0.0.1.evil','localhost;touch /tmp/no','0.0.0.0'])assert.equal(loopbackCLIAddress({...location,hostname}),undefined);
 for(const port of ['8787;echo bad','0','65536','-1'])assert.equal(loopbackCLIAddress({...location,port}),undefined);
 assert.equal(loopbackCLIAddress({...location,protocol:'file:'}),undefined);
});


test('Codex continuation hint requires an exact bound unanswered-receipt decision; hides before choice and after receipt',()=>{
 const t=task();t.source='local';t.codex_binding={version:1,native_thread_id:'d619d5ad-861c-4f35-817d-39f29dfca711',task_id:t.id,run_id:t.run_id,question:t.decision!.question,options:[...t.decision!.options],cwd_fingerprint:'opaque-directory-fingerprint',sandbox:'read-only'};
 assert.equal(canContinueCodex(t),false);t.commands=[command()];assert.equal(canContinueCodex(t),true);
 for(const status of ['acknowledged','received','unknown'])assert.equal(canContinueCodex({...t,commands:[command(status)]}),false);
 for(const change of [{codex_binding:undefined},{source:'synthetic'},{status:'ready'},{decision:null},{run_id:'other-run'},{id:'other-task'},{commands:[command(),{...command(),id:'duplicate'}]},{commands:[{...command(),message:'not an option'}]},{commands:[{...command(),run_id:'other-run'}]}])assert.equal(canContinueCodex({...t,...change}),false);
 for(const change of [{version:2},{task_id:'other-task'},{run_id:'other-run'},{question:'different question'},{options:['no','yes']},{options:['yes']},{native_thread_id:''},{cwd_fingerprint:''},{sandbox:'danger-full-access'}])assert.equal(canContinueCodex({...t,codex_binding:{...t.codex_binding!,...change}}),false);
});
test('Codex start and explicit continue examples share safe quoting and never expose binding metadata',()=>{
 const t={...task(),id:"work-quote'$(echo unsafe)",run_id:'run-1'};
 const start=codexRunCommand(t,'127.0.0.1:8787')!;
 assert.equal(start,`~/.local/share/agent-workbench/current/agent-workbench codex-run -addr '127.0.0.1:8787' -task ${shellArgument(t.id)} -run 'run-1' -cwd "$PWD"`);
 assert.equal(codexRunCommand(t,'127.0.0.1:8787',true),start.replace('codex-run ','codex-run -continue '));
 assert.equal(codexRunCommand(t,undefined,true),undefined);
 assert.doesNotMatch(start,/fingerprint|native_thread|sandbox/);
});


test('review filter selects only reported ready, leaving human decisions and active work distinct',()=>{
 const mixed=['not_started','working','needs_decision','needs_evidence','ready','done','unknown','failed','blocked','paused'].map(status=>({...task(),status}));
 assert.deepEqual(mixed.filter(t=>matchesWorkFilter(t,'review')).map(t=>t.status),['ready']);
 assert.equal(mixed.filter(t=>matchesWorkFilter(t,'active')).length,mixed.length-1);
 assert.equal(mixed.filter(t=>matchesWorkFilter(t,'all')).length,mixed.length);
 const ready={...task(),status:'ready',commands:[command()]};
 assert.equal(matchesWorkFilter(ready,'review'),true);
 assert.equal(needsDecision(ready),false);
 assert.equal(pending(ready),true);
 assert.equal(ready.status,'ready');
 // Neither a receipt nor evidence alone moves a human-decision task into review.
 const decision={...task(),commands:[command('received')],evidence:[{excerpt:'Tests passed'}]};
 assert.equal(matchesWorkFilter(decision,'review'),false);
 assert.equal(decision.status,'needs_decision');
});
test('review preview counts reported entries and prefers inline evidence without returning references',()=>{
 const ready={...task(),status:'ready',evidence:[{label:'Local log',url:'file:///private/report.txt'}, {label:'Test log',url:'https://example.test/report',excerpt:'  3 real checks passed.\nWaiting for review.  ',origin:' Local CLI '}]};
 const preview=reviewEvidencePreview(ready)!;
 assert.deepEqual(preview,{count:2,excerpt:'3 real checks passed. Waiting for review.',origin:'来源（填报）：Local CLI · 未独立核验'});
 assert.doesNotMatch(JSON.stringify(preview),/file:|https:|private|Test log/);
 assert.equal(ready.status,'ready');
 for(const status of ['working','needs_decision','needs_evidence','done'])assert.equal(reviewEvidencePreview({...ready,status}),undefined);
});
test('review preview handles missing or reference-only evidence without pretending it was read',()=>{
 const ready={...task(),status:'ready'};
 assert.deepEqual(reviewEvidencePreview(ready),{count:0,excerpt:undefined,origin:undefined});
 assert.deepEqual(reviewEvidencePreview({...ready,evidence:[{url:'javascript:alert(1)',excerpt:'   '}]}),{count:1,excerpt:undefined,origin:'来源（填报）：执行者回报 · 未独立核验'});
 assert.equal(reviewEvidencePreview({...ready,evidence:undefined as unknown as Task['evidence']})!.count,0);
});
test('review preview is bounded plain text, leaving the full reported excerpt intact',()=>{
 const excerpt='<script>not HTML</script> '+ '证据🙂'.repeat(100);
 const ready={...task(),status:'ready',evidence:[{excerpt}]};
 const preview=reviewEvidencePreview(ready)!;
 assert.equal(Array.from(preview.excerpt!).length,161);
 assert.equal(preview.excerpt,Array.from(excerpt).slice(0,160).join('')+'…');
 assert.ok(preview.excerpt!.startsWith('<script>not HTML</script>'));
 assert.equal(ready.evidence[0].excerpt,excerpt);
});


test('native initial-turn observation is historical, run-bound, and independent of status or binding',()=>{
 const local={...task(),source:'local'};
 assert.equal(codexStartObservation(local),undefined);
 const start={run_id:local.run_id,native_thread_id:'01234567-89ab-4cde-8123-456789abcdef',observed_at:'2026-11-14T18:00:01Z'};
 for(const status of ['working','needs_decision','blocked','ready','done']){
  const t={...local,status,codex_start:start};
  assert.equal(codexStartObservation(t),start);
  assert.equal(t.status,status);
  assert.equal(t.codex_binding,undefined);
 }
 for(const change of [{run_id:'old-run'},{native_thread_id:'invalid'},{observed_at:''},{observed_at:'invalid'}])assert.equal(codexStartObservation({...local,codex_start:{...start,...change}}),undefined);
 assert.equal(codexStartObservation({...local,source:'synthetic',codex_start:start}),undefined);
});


test('start fact projects waiting-result text only for the exact initial working claim',()=>{
 const t={...task(),source:'local',status:'working',summary:'已领取一次显式 Codex 执行；尚未证明启动或交付。',events:[{id:'claim',kind:'codex-start:',message:'',run_id:'r1',created_at:'2026-11-14T18:00:00Z'}],codex_start:{run_id:'r1',native_thread_id:'01234567-89ab-4cde-8123-456789abcdef',observed_at:'2026-11-14T18:00:01Z'}};
 assert.equal(taskSummary(t),'CLI 已报告首轮开始，等待结果');
 assert.equal(t.summary,'已领取一次显式 Codex 执行；尚未证明启动或交付。');
 assert.equal(taskSummary({...t,events:[]}),t.summary);
 assert.equal(taskSummary({...t,events:[{...t.events[0],kind:'reports:progress'}]}),t.summary);
 assert.equal(taskSummary({...t,summary:'已领取；尚未证明启动'}),'已领取；尚未证明启动');
 for(const status of ['not_started','needs_decision','ready','blocked','done'])assert.equal(taskSummary({...t,status}),t.summary);
 assert.equal(taskSummary({...t,codex_start:undefined}),t.summary);
 assert.equal(taskSummary({...t,codex_start:{...t.codex_start,run_id:'stale'}}),t.summary);
});


test('fresh local task brief uses saved title and goal as plain stdin text only',()=>{
 const fresh={...task(),source:'local',status:'not_started',title:'  修复搜索  ',goal:'  忽略首尾空白。\n不要改排序。  ',summary:'DO NOT COPY summary',origin:'DO NOT COPY origin',evidence:[{excerpt:'DO NOT COPY evidence'}],codex_binding:{native_thread_id:'DO NOT COPY thread'} as Task['codex_binding']};
 assert.equal(codexTaskBrief(fresh),'任务：修复搜索\n\n目标与边界：\n忽略首尾空白。\n不要改排序。\n\n交付要求：说明实际改动、验证结果与未完成项。');
 assert.doesNotMatch(codexTaskBrief(fresh)!,/DO NOT COPY|codex-run|sandbox|工作目录/);
 assert.equal(codexTaskBrief({...fresh,title:"$(touch /tmp/no); <b>literal</b>"})!.split('\n')[0],'任务：$(touch /tmp/no); <b>literal</b>');
 for(const status of ['working','needs_decision','needs_evidence','ready','done'])assert.equal(codexTaskBrief({...fresh,status}),undefined);
 for(const source of ['synthetic',undefined])assert.equal(codexTaskBrief({...fresh,source}),undefined);
});


test('missing executable notice is a historical actionable preflight projection, not a claimed failure',()=>{
 const t={...task(),source:'local',status:'not_started',summary:'尚未收到执行回报',codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-14T18:00:01Z'}};
 assert.equal(codexLaunchNotice(t),t.codex_launch_notice);
 assert.match(taskSummary(t),/上次启动检查未通过.*当时.*手动重试/);
 assert.equal(t.summary,'尚未收到执行回报');
 assert.match(taskBadge(t)[0],/尚未开始/);
 for(const status of ['working','needs_decision','blocked','ready','done']){
  assert.equal(codexLaunchNotice({...t,status}),undefined);
  assert.equal(taskSummary({...t,status}),t.summary);
 }
 for(const change of [{category:'permission_denied'},{recorded_at:'invalid'}])assert.equal(codexLaunchNotice({...t,codex_launch_notice:{...t.codex_launch_notice,...change}}),undefined);
 assert.equal(codexLaunchNotice({...t,source:'synthetic'}),undefined);
 assert.equal(codexLaunchNotice({...t,codex_launch_notice:undefined}),undefined);
});


test('issue count and filter include explicit stop states and valid fresh local preflight notices only',()=>{
 const notice={category:'missing_executable',recorded_at:'2026-11-14T18:00:01Z'};
 const mixed=[{...task(),id:'ready',status:'ready'},{...task(),id:'blocked',status:'blocked'},{...task(),id:'failed',status:'failed'},{...task(),id:'preflight',source:'local',status:'not_started',codex_launch_notice:notice},{...task(),id:'fresh',source:'local',status:'not_started'},task()];
 assert.deepEqual(mixed.filter(hasWorkIssue).map(t=>t.id),['blocked','failed','preflight']);
 assert.deepEqual(mixed.filter(t=>matchesWorkFilter(t,'issues')).map(t=>t.id),['blocked','failed','preflight']);
 assert.deepEqual(mixed.filter(t=>matchesWorkFilter(t,'review')).map(t=>t.id),['ready']);
 assert.deepEqual(mixed.filter(needsDecision).map(t=>t.id),['t']);
 assert.equal(mixed.filter(t=>matchesWorkFilter(t,'active')).length,mixed.length);
 assert.equal(mixed[3].status,'not_started');
});
test('issue route ignores stale and malformed launch notices without inventing current trouble',()=>{
 const fresh={...task(),source:'local',status:'not_started',codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-14T18:00:01Z'}};
 for(const status of ['working','needs_decision','ready','done','paused','unknown']){
  assert.equal(hasWorkIssue({...fresh,status}),false,status);
  assert.equal(matchesWorkFilter({...fresh,status},'issues'),false,status);
 }
 for(const notice of [undefined,null,{category:'missing_executable',recorded_at:''},{category:'missing_executable',recorded_at:'not-a-date'},{category:'unrecognized',recorded_at:fresh.codex_launch_notice.recorded_at}])assert.equal(hasWorkIssue({...fresh,codex_launch_notice:notice}),false);
 for(const source of ['synthetic',undefined])assert.equal(hasWorkIssue({...fresh,source}),false);
 // Historical records stay eligible even if old: age is not a live-health inference.
 assert.equal(hasWorkIssue({...fresh,codex_launch_notice:{...fresh.codex_launch_notice,recorded_at:'2020-01-01T00:00:00Z'}}),true);
 assert.equal(hasWorkIssue({...fresh,codex_launch_notice:undefined,summary:'上次启动检查未通过'}),false);
});


test('manual seen marker removes only exact ready report from pending review, never completes it',()=>{
 const t={...task(),source:'local',status:'ready',evidence:[{label:'Evidence',excerpt:'Declared result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Declared result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}]};
 assert.equal(currentReadyReportID(t),'ready-1');
 assert.equal(pendingDeliveryReview(t),true);
 const review={run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'};
 const seen={...t,delivery_review:review};
 assert.equal(reviewedDelivery(seen),review);
 assert.equal(matchesWorkFilter(seen,'review'),false);
 assert.equal(matchesWorkFilter(seen,'active'),true);
 assert.equal(matchesWorkFilter(seen,'all'),true);
 assert.deepEqual(taskBadge(seen),['已查看本次交付 · 非验收','gray']);
 assert.equal(seen.status,'ready');assert.equal(seen.evidence,t.evidence);assert.equal(seen.events,t.events);
 const reloaded=JSON.parse(JSON.stringify(seen)) as Task;
 assert.equal(pendingDeliveryReview(reloaded),false);
 const newer={...seen,events:[...seen.events,{...seen.events[0],id:'ready-2'}]};
 assert.equal(currentReadyReportID(newer),'ready-2');assert.equal(reviewedDelivery(newer),undefined);assert.equal(pendingDeliveryReview(newer),true);
 assert.equal(matchesWorkFilter(newer,'review'),true);assert.match(taskBadge(newer)[0],/待审/);
 const mixed=[seen,newer,{...t,status:'blocked'}];
 assert.equal(mixed.filter(pendingDeliveryReview).length,1);
});
test('manual seen affordance requires local evidence-bearing current ready report and ignores stale markers',()=>{
 const t={...task(),source:'local',status:'ready',evidence:[{excerpt:'Result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 for(const change of [{source:'synthetic'},{project_id:'demo'},{status:'working'},{status:'needs_evidence'},{status:'blocked'},{status:'done'},{evidence:[]},{evidence:[{url:'file:///private/evidence'}]},{events:[]},{run_id:'r2'},{events:[{...t.events[0],kind:'reports:failed'}]}]){
  assert.equal(currentReadyReportID({...t,...change}),undefined);
  assert.equal(reviewedDelivery({...t,...change}),undefined);
 }
 for(const change of [{run_id:'old-run'},{report_event_id:'old-report'},{reviewed_at:'invalid'},{reviewed_at:''}]){
  const stale={...t,delivery_review:{...t.delivery_review,...change}};
  assert.equal(reviewedDelivery(stale),undefined);assert.equal(pendingDeliveryReview(stale),true);
 }
 // Receipt bookkeeping cannot turn an already seen report into new evidence.
 assert.equal(reviewedDelivery({...t,events:[...t.events,{...t.events[0],id:'receipt-2',kind:'reports:receipt'}]}),t.delivery_review);
});


test('drawer pins pictured report across polling; only explicit reopen can target the new ready report',()=>{
 const r1={...task(),source:'local',status:'ready',evidence:[{excerpt:'Pictured R1 evidence'}],events:[{id:'ready-1',kind:'reports:ready',message:'R1',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}]};
 const target=pinDeliveryReview(r1);
 assert.deepEqual(deliveryReviewRequest(r1,target),{run_id:'r1',report_event_id:'ready-1'});
 const polled={...r1,summary:'New R2',evidence:[{excerpt:'Unseen R2 evidence'}],events:[...r1.events,{...r1.events[0],id:'ready-2',message:'R2'}]};
 // The drawer's refreshed content must not silently upgrade its review target.
 assert.equal(deliveryReviewRequest(polled,target),undefined);
 assert.equal(target?.report_event_id,'ready-1');
 assert.equal(pendingDeliveryReview(polled),true);
 const reopened=pinDeliveryReview(polled);
 assert.deepEqual(deliveryReviewRequest(polled,reopened),{run_id:'r1',report_event_id:'ready-2'});
 // Close, another task/run, or a drawer originally opened before ready has no authority.
 assert.equal(deliveryReviewRequest(polled,undefined),undefined);
 assert.equal(deliveryReviewRequest({...polled,id:'other-task'},reopened),undefined);
 assert.equal(deliveryReviewRequest({...polled,run_id:'other-run'},reopened),undefined);
 assert.equal(deliveryReviewRequest({...polled,status:'blocked'},reopened),undefined);
 const unstarted=pinDeliveryReview({...r1,status:'not_started'});
 assert.equal(unstarted,undefined);assert.equal(deliveryReviewRequest(polled,unstarted),undefined);
});


test('card search finds origin-only context case-insensitively after reload and review',()=>{
 const t={...task(),source:'local',status:'ready',title:'检查报告',goal:'核对数据',summary:'已回报结果',origin:'独立Report audit',evidence:[{excerpt:'Declared result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Declared result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 const reloaded=JSON.parse(JSON.stringify(t)) as Task;
 assert.ok(reviewedDelivery(reloaded));
 for(const term of ['独立Report audit','  独立rEPOrT AUDIT  ','本地工作','检查报告','核对数据','已回报结果','','   '])assert.equal(matchesTaskSearch(reloaded,term),true,term);
 assert.equal(matchesTaskSearch(reloaded,'其他项目'),false);
});
test('card search uses visible summary projections rather than superseded raw summary',()=>{
 const t={...task(),source:'local',status:'working',summary:'已领取一次显式 Codex 执行；尚未证明启动或交付。',events:[{id:'claim',kind:'codex-start:',message:'',run_id:'r1',created_at:'2026-11-14T18:00:00Z'}],codex_start:{run_id:'r1',native_thread_id:'01234567-89ab-4cde-8123-456789abcdef',observed_at:'2026-11-14T18:00:01Z'}};
 assert.equal(matchesTaskSearch(t,'CLI 已报告首轮开始'),true);
 assert.equal(matchesTaskSearch(t,'已领取一次显式 Codex 执行'),false);
 const preflight={...t,status:'not_started',codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-14T18:00:01Z'}};
 assert.equal(matchesTaskSearch(preflight,'当时的 PATH'),true);
 assert.equal(matchesTaskSearch(preflight,'已领取一次显式 Codex 执行'),false);
 // A stale start observation no longer replaces the current report.
 const latest={...t,codex_start:{...t.codex_start,run_id:'old-run'},summary:'最新真实回报'};
 assert.equal(matchesTaskSearch(latest,'最新真实回报'),true);
 assert.equal(matchesTaskSearch(latest,'CLI 已报告首轮开始'),false);
});
test('card search excludes invisible origin, source tokens, identifiers, paths and historical detail',()=>{
 const t={...task(),source:'local',origin:'visible context',id:'hidden-task-id',project_id:'/hidden-project/path',run_id:'hidden-run-id',evidence:[{origin:'hidden-evidence-origin',url:'file:///hidden-evidence/path',excerpt:'hidden-evidence-excerpt'}],events:[{id:'hidden-event-id',kind:'reports:working',message:'hidden-historical-report',run_id:'hidden-run-id',created_at:'2026-01-01'}],commands:[{...command(),message:'hidden-command-text'}],codex_binding:{cwd_fingerprint:'hidden-directory-fingerprint',native_thread_id:'hidden-thread-id'} as Task['codex_binding']};
 for(const term of ['local','hidden-task-id','/hidden-project/path','hidden-run-id','hidden-evidence-origin','hidden-evidence/path','hidden-evidence-excerpt','hidden-event-id','hidden-historical-report','hidden-command-text','hidden-directory-fingerprint','hidden-thread-id'])assert.equal(matchesTaskSearch(t,term),false,term);
 const synthetic={...t,source:'synthetic',origin:'hidden-raw-origin'};
 assert.equal(matchesTaskSearch(synthetic,'合成演示'),true);
 assert.equal(matchesTaskSearch(synthetic,'synthetic'),false);
 assert.equal(matchesTaskSearch(synthetic,'hidden-raw-origin'),false);
 assert.equal(matchesTaskSearch({...t,source:undefined,origin:'hidden-raw-origin'},'hidden-raw-origin'),false);
});


test('viewed deliveries remain active until explicit exact local follow-up end, then restore is reversible',()=>{
 const viewed={...task(),source:'local',status:'ready',evidence:[{excerpt:'Reported evidence'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 const target=pinDeliveryReview(viewed);
 assert.equal(activeWork(viewed),true);assert.equal(matchesWorkFilter(viewed,'active'),true);
 assert.deepEqual(localFollowUpRequest(viewed,target,'end'),{run_id:'r1',report_event_id:'ready-1',operation:'end',expected_recorded_at:''});
 const ended={...viewed,local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'ended' as const,recorded_at:'2026-11-14T18:02:03Z'}};
 assert.equal(endedLocalFollowUp(ended),true);assert.equal(activeWork(ended),false);
 assert.equal(matchesWorkFilter(ended,'active'),false);assert.equal(matchesWorkFilter(ended,'all'),true);
 assert.deepEqual(taskBadge(ended),['已结束跟进 · 本地','gray']);assert.equal(ended.status,'ready');
 assert.equal(pendingDeliveryReview(ended),false);assert.equal(ended.evidence,viewed.evidence);assert.equal(ended.delivery_review,viewed.delivery_review);
 assert.equal([viewed,ended].filter(activeWork).length,1); // Never hide all viewed work.
 const reload=JSON.parse(JSON.stringify(ended)) as Task;
 assert.equal(activeWork(reload),false);
 assert.deepEqual(localFollowUpRequest(reload,pinDeliveryReview(reload),'resume'),{run_id:'r1',report_event_id:'ready-1',operation:'resume',expected_recorded_at:ended.local_follow_up.recorded_at});
 const restored={...ended,local_follow_up:{...ended.local_follow_up,state:'open' as const,recorded_at:'2026-11-14T18:03:04Z'}};
 assert.equal(activeWork(restored),true);assert.equal(endedLocalFollowUp(restored),false);
 assert.equal(pendingDeliveryReview(restored),false);assert.equal(reviewedDelivery(restored),viewed.delivery_review);
 assert.equal(localFollowUpRequest(restored,target,'end')?.expected_recorded_at,restored.local_follow_up.recorded_at);
 // Receipt-only bookkeeping leaves this exact marker effective.
 assert.equal(endedLocalFollowUp({...ended,events:[...ended.events,{...ended.events[0],id:'receipt',kind:'reports:receipt'}]}),true);
});
test('new evidence restores active and pending-review membership; stale drawer cannot end or resume it',()=>{
 const old={...task(),source:'local',status:'ready',evidence:[{excerpt:'Old evidence'}],events:[{id:'ready-1',kind:'reports:ready',message:'R1',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'},local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'ended' as const,recorded_at:'2026-11-14T18:02:03Z'}};
 const pinned=pinDeliveryReview(old);
 const fresh={...old,evidence:[{excerpt:'New evidence'}],events:[...old.events,{...old.events[0],id:'ready-2',message:'R2'}]};
 assert.equal(localFollowUpMarker(fresh),undefined);assert.equal(activeWork(fresh),true);assert.equal(pendingDeliveryReview(fresh),true);
 assert.equal(localFollowUpRequest(fresh,pinned,'end'),undefined);assert.equal(localFollowUpRequest(fresh,pinned,'resume'),undefined);
 const reviewed={...fresh,delivery_review:{...fresh.delivery_review,report_event_id:'ready-2'}};
 assert.equal(localFollowUpRequest(reviewed,pinned,'end'),undefined);
 assert.deepEqual(localFollowUpRequest(reviewed,pinDeliveryReview(reviewed),'end'),{run_id:'r1',report_event_id:'ready-2',operation:'end',expected_recorded_at:''});
 for(const change of [{source:'synthetic'},{project_id:'demo'},{status:'blocked'},{status:'working'},{status:'done'},{evidence:[]},{delivery_review:undefined},{delivery_review:{...old.delivery_review,report_event_id:'stale'}}]){
  const invalid={...old,...change};
  assert.equal(localFollowUpMarker(invalid),undefined);assert.equal(localFollowUpRequest(invalid,pinned,'end'),undefined);
 }
 for(const change of [{run_id:'other-run'},{report_event_id:'old-report'},{recorded_at:'invalid'}])assert.equal(localFollowUpMarker({...old,local_follow_up:{...old.local_follow_up,...change}}),undefined);
});


test('saved task brief opt-in command contains only flags and quoted IDs, never multiline task labels',()=>{
 const t={...task(),source:'local',status:'not_started',id:"work'$(touch NEVER)",run_id:"run'quoted",title:"Read\n$(touch NEVER) 'quoted'",goal:'Line one\n`literal`; "quoted"'};
 const command=codexTaskBriefCommand(t,'127.0.0.1:8787');
 assert.equal(command,codexRunCommand(t,'127.0.0.1:8787')!.replace('codex-run ','codex-run -use-task-brief '));
 assert.equal(command,`~/.local/share/agent-workbench/current/agent-workbench codex-run -use-task-brief -addr '127.0.0.1:8787' -task ${shellArgument(t.id)} -run ${shellArgument(t.run_id)} -cwd "$PWD"`);
 assert.equal(command!.includes(t.title),false);assert.equal(command!.includes(t.goal),false);assert.equal(command!.includes('\n'),false);
 assert.equal(codexTaskBrief(t),"任务：Read\n$(touch NEVER) 'quoted'\n\n目标与边界：\nLine one\n`literal`; \"quoted\"\n\n交付要求：说明实际改动、验证结果与未完成项。");
 assert.equal(codexTaskBriefCommand(t,undefined),undefined);
 assert.equal(codexTaskBriefCommand({...t,status:'working'},'127.0.0.1:8787'),undefined);
 assert.equal(codexTaskBriefCommand({...t,source:'synthetic'},'127.0.0.1:8787'),undefined);
 // Custom stdin and exact continuation command contracts stay unchanged.
 assert.equal(codexRunCommand(t,'127.0.0.1:8787')!.includes('-use-task-brief'),false);
 assert.equal(codexRunCommand(t,'127.0.0.1:8787',true)!.includes('-use-task-brief'),false);
});


test('previous ready evidence stays collapsed-history data and never becomes current review or active authority',()=>{
 const oldEvent={id:'ready-1',kind:'reports:ready',message:'Old source summary',origin:'Declared old source',run_id:'r1',created_at:'2026-11-14T18:00:01Z'};
 const history={run_id:'r1',report_event_id:'ready-1',reported_at:oldEvent.created_at,origin:oldEvent.origin,summary:oldEvent.message,total_count:4,evidence:[{label:'Old source',excerpt:'Historical source excerpt',origin:'Original declared source'},{excerpt:'Historical two'},{excerpt:'Historical three'},{excerpt:'Historical four'}]};
 const t={...task(),source:'local',status:'ready',summary:'Corrected current result',evidence:[{excerpt:'Current measured result'}],events:[oldEvent,{...oldEvent,id:'ready-2',message:'Corrected current result',created_at:'2026-11-14T18:01:02Z'}],previous_delivery_evidence:history,delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:00:02Z'},local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'ended' as const,recorded_at:'2026-11-14T18:00:03Z'}};
 assert.equal(previousDeliveryEvidence(t),history);
 assert.equal(reviewEvidencePreview(t)?.count,1);assert.equal(reviewEvidencePreview(t)?.excerpt,'Current measured result');
 assert.equal(currentReadyReportID(t),'ready-2');assert.equal(pinDeliveryReview(t)?.report_event_id,'ready-2');
 assert.equal(pendingDeliveryReview(t),true);assert.equal(activeWork(t),true);assert.equal(reviewedDelivery(t),undefined);
 assert.equal(matchesTaskSearch(t,'Historical source excerpt'),false);assert.equal(matchesTaskSearch(t,'Old source summary'),false);
 const seen={...t,delivery_review:{...t.delivery_review,report_event_id:'ready-2'}};
 assert.equal(previousDeliveryEvidence(seen),history);assert.equal(pendingDeliveryReview(seen),false);
 const reload=JSON.parse(JSON.stringify(seen)) as Task;
 assert.equal(previousDeliveryEvidence(reload)?.evidence.length,4);assert.equal(reload.evidence.length,1);
 // An empty current report cannot borrow old evidence and become reviewable.
 const empty={...t,status:'needs_evidence',evidence:[]};
 assert.equal(currentReadyReportID(empty),undefined);assert.equal(reviewEvidencePreview(empty),undefined);assert.equal(pendingDeliveryReview(empty),false);
});
test('historical snapshot validates same run/report, count and byte bounds without claiming omitted entries are present',()=>{
 const event={id:'old-ready',kind:'reports:ready',message:'Old',run_id:'r1',created_at:'2026-11-14T18:00:01Z'};
 const history={run_id:'r1',report_event_id:'old-ready',reported_at:event.created_at,origin:'Declared',summary:'Bounded old summary',summary_truncated:true,total_count:12,evidence:[{excerpt:'A complete retained entry'}]};
 const t={...task(),source:'local',events:[event],previous_delivery_evidence:history};
 assert.equal(previousDeliveryEvidence(t),history);assert.equal(history.total_count-history.evidence.length,11);
 assert.equal(previousDeliveryEvidence({...t,previous_delivery_evidence:undefined}),undefined);
 for(const change of [{run_id:'old-run'},{report_event_id:'missing'},{reported_at:'invalid'},{total_count:0},{evidence:Array.from({length:9},()=>({excerpt:'Entry'}))},{summary:'x'.repeat(501)},{evidence:[{label:'x'.repeat(33*1024),excerpt:'Entry'}]}])assert.equal(previousDeliveryEvidence({...t,previous_delivery_evidence:{...history,...change}}),undefined);
 assert.equal(previousDeliveryEvidence({...t,source:'synthetic'}),undefined);assert.equal(previousDeliveryEvidence({...t,project_id:'demo'}),undefined);
 assert.equal(previousDeliveryEvidence({...t,events:[]}),undefined);
});


test('size-driven unretained previous evidence has an honest fixed reason, never current report authority',()=>{
 const old={id:'ready-1',kind:'reports:ready',message:'Old',run_id:'r1',created_at:'2026-11-14T18:00:01Z'};
 const omitted={run_id:'r1',report_event_id:'ready-1',reason:'task_size_limit' as const};
 const t={...task(),source:'local',status:'ready',evidence:[{excerpt:'Current result'}],events:[old,{...old,id:'ready-2'}],previous_evidence_unretained:omitted};
 assert.equal(previousDeliveryEvidence(t),undefined);assert.equal(previousEvidenceUnretained(t),omitted);
 assert.equal(currentReadyReportID(t),'ready-2');assert.equal(reviewEvidencePreview(t)?.count,1);assert.equal(pendingDeliveryReview(t),true);
 assert.equal(previousEvidenceUnretained({...t,previous_evidence_unretained:undefined}),undefined);
 assert.equal(previousEvidenceUnretained({...t,source:'synthetic'}),undefined);
 for(const change of [{run_id:'other-run'},{report_event_id:'ready-2'},{report_event_id:'absent'}])assert.equal(previousEvidenceUnretained({...t,previous_evidence_unretained:{...omitted,...change}}),undefined);
});


test('single-row end affordance requires active exact viewed local ready and pins existing API tokens',()=>{
 const viewed={...task(),source:'local',status:'ready',evidence:[{excerpt:'Measured result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 const target=pinRowFollowUp(viewed);
 assert.deepEqual(target,{task_id:'t',run_id:'r1',report_event_id:'ready-1',reviewed_at:viewed.delivery_review.reviewed_at,expected_recorded_at:''});
 assert.deepEqual(rowFollowUpRequest(viewed,target),localFollowUpRequest(viewed,pinDeliveryReview(viewed),'end'));
 const restored={...viewed,local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'open' as const,recorded_at:'2026-11-14T18:03:04Z'}};
 assert.equal(pinRowFollowUp(restored)?.expected_recorded_at,restored.local_follow_up.recorded_at);
 for(const change of [{source:'synthetic'},{project_id:'demo'},{status:'working'},{status:'blocked'},{status:'done'},{evidence:[]},{delivery_review:undefined},{delivery_review:{...viewed.delivery_review,report_event_id:'stale'}},{local_follow_up:{...restored.local_follow_up,state:'ended' as const}}])assert.equal(pinRowFollowUp({...viewed,...change}),undefined);
 assert.equal(viewed.status,'ready');assert.equal('local_follow_up' in viewed,false);
});
test('clicked row end never retargets a newer report, viewed timestamp or marker after polling',()=>{
 const viewed={...task(),source:'local',status:'ready',evidence:[{excerpt:'Pictured result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 const target=pinRowFollowUp(viewed),original=JSON.stringify(target);
 for(const change of [{id:'other-task'},{run_id:'other-run'},{delivery_review:{...viewed.delivery_review,reviewed_at:'2026-11-14T18:02:03Z'}},{local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'open' as const,recorded_at:'2026-11-14T18:03:04Z'}}])assert.equal(rowFollowUpRequest({...viewed,...change},target),undefined);
 const newer={...viewed,events:[...viewed.events,{...viewed.events[0],id:'ready-2'}],delivery_review:{...viewed.delivery_review,report_event_id:'ready-2'}};
 assert.equal(rowFollowUpRequest(newer,target),undefined);
 assert.equal(rowFollowUpRequest(viewed,undefined),undefined);
 assert.equal(JSON.stringify(target),original);
 assert.equal(rowFollowUpRequest(newer,pinRowFollowUp(newer))?.report_event_id,'ready-2');
});


test('current pinned handoff preserves literal excerpts and includes exact report time and declared origin',()=>{
 const excerpt='  Literal <b>not HTML</b>\n\t$() `text` \"quoted\"  ';
 const t={...task(),source:'local',status:'ready',title:'当前交付',summary:'当前可见摘要',evidence:[{label:'  测试摘录  ',excerpt},{label:'独立引用',url:'https://hidden-reference.example/report'}],events:[{id:'ready-current',kind:'reports:ready',message:'Current report',origin:'当前填报执行者',run_id:'r1',created_at:'2026-11-14T18:00:01.123+08:00'}]};
 const result=deliveryHandoffText(t,pinDeliveryReview(t))!;
 assert.ok(result.includes('工作：当前交付'));
 assert.ok(result.includes('回报时间：2026-11-14T18:00:01.123+08:00'));
 assert.ok(result.includes('来源（填报）：当前填报执行者 · 未独立核验'));
 assert.ok(result.includes('摘要（填报）：\n当前可见摘要'));
 assert.ok(result.includes('1. 测试摘录\n'+excerpt));
 assert.ok(result.includes('2. 独立引用\n链接请在原工作查看'));
 assert.doesNotMatch(result,/https:|ready-current/);
 const long='原样🙂'.repeat(900);
 assert.ok(deliveryHandoffText({...t,evidence:[{excerpt:long}]},pinDeliveryReview(t))!.includes(long));
 assert.equal(t.evidence[0].excerpt,excerpt);
});
test('handoff excludes hidden IDs, goals, URL/path references, prior reports and metadata',()=>{
 const old={id:'HIDDEN-OLD-REPORT',kind:'reports:ready',message:'HIDDEN-OLD-SUMMARY',origin:'HIDDEN-OLD-ORIGIN',run_id:'HIDDEN-RUN',created_at:'2026-11-14T17:00:01Z'};
 const t={...task(),id:'HIDDEN-TASK',run_id:'HIDDEN-RUN',project_id:'/HIDDEN-PROJECT/PATH',source:'local',origin:'HIDDEN-TASK-ORIGIN',goal:'HIDDEN-GOAL',status:'ready',title:'Visible title',summary:'Visible summary',evidence:[{label:'Local reference',url:'file:///HIDDEN-REFERENCE/PATH'},{excerpt:'Visible excerpt',origin:'HIDDEN-ENTRY-ORIGIN'}],events:[old,{...old,id:'HIDDEN-CURRENT-REPORT',message:'HIDDEN-EVENT-MESSAGE',origin:'Visible report origin',created_at:'2026-11-14T18:00:01Z'}],previous_delivery_evidence:{run_id:'HIDDEN-RUN',report_event_id:old.id,reported_at:old.created_at,origin:old.origin,summary:old.message,total_count:1,evidence:[{excerpt:'HIDDEN-HISTORY-EXCERPT'}]},commands:[{...command(),message:'HIDDEN-COMMAND'}],codex_binding:{native_thread_id:'HIDDEN-THREAD-UUID',cwd_fingerprint:'/HIDDEN-DIRECTORY/PATH'} as Task['codex_binding']};
 const result=deliveryHandoffText(t,pinDeliveryReview(t))!;
 assert.ok(result.includes('Visible excerpt'));assert.ok(result.includes('Visible report origin'));
 assert.doesNotMatch(result,/HIDDEN|file:|https:/);
 assert.equal(deliveryHandoffText({...t,source:'synthetic'},pinDeliveryReview(t)),undefined);
 assert.equal(deliveryHandoffText({...t,status:'needs_evidence'},pinDeliveryReview(t)),undefined);
 assert.equal(deliveryHandoffText({...t,evidence:[]},pinDeliveryReview(t)),undefined);
});
test('handoff refuses stale or unpinned current delivery rather than silently copying a newer report',()=>{
 const t={...task(),source:'local',status:'ready',summary:'Pictured R1',evidence:[{excerpt:'Pictured R1 excerpt'}],events:[{id:'ready-1',kind:'reports:ready',message:'R1',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}]};
 const target=pinDeliveryReview(t),original=deliveryHandoffText(t,target);
 assert.ok(original);
 const polled={...t,summary:'New R2',evidence:[{excerpt:'New R2 excerpt'}],events:[...t.events,{...t.events[0],id:'ready-2'}]};
 for(const changed of [polled,{...t,id:'another-task'},{...t,run_id:'another-run'},{...t,status:'blocked'},{...t,events:[{...t.events[0],created_at:'invalid'}]}])assert.equal(deliveryHandoffText(changed,target),undefined);
 assert.equal(deliveryHandoffText(t,undefined),undefined);
 assert.ok(deliveryHandoffText(polled,pinDeliveryReview(polled))!.includes('New R2 excerpt'));
 // Receipt, viewed or local follow-up bookkeeping cannot retarget or add context.
 assert.equal(deliveryHandoffText({...t,events:[...t.events,{...t.events[0],id:'receipt',kind:'reports:receipt'}]},target),original);
});


test('active search hint counts both ended and done matches with zero or partial visible results',()=>{
 const ended={...task(),id:'ended',source:'local',status:'ready',title:'AMC delivery',evidence:[{excerpt:'Reported evidence'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}],delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'},local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'ended' as const,recorded_at:'2026-11-14T18:02:03Z'}};
 const done={...task(),id:'done',status:'done',title:'AMC earlier work'};
 const zero=[ended,done,{...done,id:'unmatched',title:'Other work'}];
 const activeMatches=(items:Task[])=>items.filter(t=>matchesWorkView(t,'overview')&&matchesWorkFilter(t,'active')&&matchesTaskSearch(t,'amc'));
 assert.equal(activeMatches(zero).length,0);
 assert.equal(hiddenActiveSearchCount(zero,'overview','active',' amc '),2);
 const partial=[...zero,{...task(),id:'working',status:'working',title:'AMC in progress'}];
 assert.equal(activeMatches(partial).length,1);
 assert.equal(hiddenActiveSearchCount(partial,'overview','active','AMC'),2);
 assert.equal(partial.filter(t=>matchesWorkView(t,'overview')&&matchesWorkFilter(t,'all')&&matchesTaskSearch(t,'AMC')).length,3);
 // A new report makes an old ended marker stale, so it is visible, not a hidden match.
 const newReport={...ended,events:[...ended.events,{...ended.events[0],id:'ready-2'}]};
 assert.equal(hiddenActiveSearchCount([newReport],'overview','active','AMC'),0);
 assert.deepEqual(partial.map(t=>t.id),['ended','done','unmatched','working']);
});
test('search hint is scoped exactly like the current list and suppressed for empty or non-active search',()=>{
 const done={...task(),status:'done',title:'AMC delivery'};
 const mixed=[{...done,id:'a',project_id:'project-a',commands:[command()]},{...done,id:'b',project_id:'project-b'},{...done,id:'c',project_id:'project-b',commands:[command()]},{...done,id:'not-matching',title:'Other'}];
 assert.equal(hiddenActiveSearchCount(mixed,'project-a','active','AMC'),1);
 assert.equal(hiddenActiveSearchCount(mixed,'project-b','active','AMC'),2);
 assert.equal(hiddenActiveSearchCount(mixed,'overview','active','AMC'),3);
 assert.equal(hiddenActiveSearchCount(mixed,'decisions','active','AMC'),2);
 assert.equal(hiddenActiveSearchCount(mixed,'attention','active','AMC'),0);
 assert.equal(hiddenActiveSearchCount(mixed,'missing-project','active','AMC'),0);
 for(const query of ['', ' \t\n '])assert.equal(hiddenActiveSearchCount(mixed,'overview','active',query),0);
 for(const filter of ['all','review','issues'] as const)assert.equal(hiddenActiveSearchCount(mixed,'overview',filter,'AMC'),0);
 assert.equal(matchesWorkView({...task(),status:'needs_decision'},'attention'),true);
 assert.equal(matchesWorkView({...task(),commands:[command()]},'attention'),false);
});


test('thin project groups use exact explicit local names, not origins or lifecycle/source IDs',()=>{
 const local={...task(),source:'local',project_id:'local',status:'working'};
 const records=[{...local,id:'a',project_name:'AMC',origin:'relay context'},{...local,id:'b',project_name:'AMC'},{...local,id:'c',project_name:'amc'},{...local,id:'blank'},{...local,id:'reserved',project_name:'overview'},{...local,id:'literal-blank',project_name:'未归类'},{...local,id:'demo-name',project_name:'source-demo'},{...local,id:'prototype',project_name:'__proto__'},{...local,id:'demo',source:'synthetic',project_id:'demo',project_name:'AMC'},{...local,id:'old',source:undefined,project_id:'old-project',project_name:'AMC'}];
 const before=JSON.stringify(records);
 const groups=workProjectGroups(records,[{id:'old-project',name:'旧工作',goal:'Old goal'}]);
 const amc=groups.find(group=>group.key===taskProjectView(records[0]))!;
 assert.equal(amc.kind,'local');assert.equal(amc.name,'AMC');assert.deepEqual(amc.items.map(t=>t.id),['a','b']);
 assert.notEqual(taskProjectView(records[0]),taskProjectView(records[2]));
 assert.notEqual(taskProjectView(records[3]),taskProjectView(records[5]));
 assert.equal(groups.find(group=>group.key===taskProjectView(records[3]))!.name,'未归类');
 assert.equal(groups.find(group=>group.kind==='demo')!.items.length,1);
 assert.equal(groups.find(group=>group.kind==='legacy')!.name,'旧工作');
 assert.equal(new Set(groups.map(group=>group.key)).size,groups.length);
 for(const group of groups)assert.notEqual(group.key,'overview');
 assert.equal(JSON.stringify(records),before);
 assert.equal(projectName(records[0]),'AMC');assert.equal(projectName(records[9]),'');
 assert.equal(canNameProject(records[8]),false);assert.equal(canNameProject(records[9]),false);
});
test('project views and hidden search counts share exact names without leaking demo or other projects',()=>{
 const base={...task(),source:'local',project_id:'local',status:'done',title:'Measured delivery'};
 const a={...base,id:'a',project_name:'AMC'},b={...base,id:'b',project_name:'relay'},demo={...base,id:'demo',source:'synthetic',project_id:'demo',project_name:'AMC'};
 const records=[a,b,demo];
 const aView=taskProjectView(a);
 assert.deepEqual(records.filter(t=>matchesWorkView(t,aView)).map(t=>t.id),['a']);
 assert.equal(hiddenActiveSearchCount(records,aView,'active','delivery'),1);
 assert.equal(hiddenActiveSearchCount(records,aView,'active','relay'),0);
 assert.equal(hiddenActiveSearchCount(records,'overview','active','delivery'),3);
 assert.equal(matchesTaskSearch(a,'项目：AMC'),true);assert.equal(taskProjectLabel(a),'项目：AMC');
 assert.equal(taskProjectLabel(demo),undefined);assert.equal(matchesTaskSearch(demo,'AMC'),false);
 const cleared={...a,project_name:''};
 assert.equal(matchesWorkView(cleared,aView),false);
 assert.equal(matchesWorkView(cleared,taskProjectView(cleared)),true);
 assert.equal(taskProjectLabel(cleared),'项目：未归类');
 assert.equal(a.project_id,'local');assert.equal(a.status,'done');
});
test('per-project counts reuse follow-up, decision, issue and review predicates, never imply live execution',()=>{
 const ready={...task(),source:'local',project_id:'local',status:'ready',evidence:[{excerpt:'Reported result'}],events:[{id:'ready-1',kind:'reports:ready',message:'Result',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}]};
 const seen={...ready,delivery_review:{run_id:'r1',report_event_id:'ready-1',reviewed_at:'2026-11-14T18:01:02Z'}};
 const ended={...seen,local_follow_up:{run_id:'r1',report_event_id:'ready-1',state:'ended' as const,recorded_at:'2026-11-14T18:02:03Z'}};
 const preflight={...task(),source:'local',project_id:'local',status:'not_started',codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-14T18:00:01Z'}};
 const rows=[ready,seen,ended,task(),{...task(),commands:[command()]},{...task(),status:'blocked'},preflight,{...task(),status:'working'},{...task(),status:'done'}];
 assert.deepEqual(projectWorkCounts(rows),{active:7,decision:1,issues:2,review:1});
 assert.deepEqual(projectWorkCounts([]),{active:0,decision:0,issues:0,review:0});
 assert.equal('running' in projectWorkCounts(rows),false);
});
test('optional project name bound counts Unicode characters after trim and explicit blank clears grouping',()=>{
 assert.equal(validProjectName('  '+ '🙂'.repeat(60)+'  '),true);
 assert.equal(validProjectName('🙂'.repeat(61)),false);
 assert.equal(validProjectName(''),true);assert.equal(validProjectName('   '),true);
 const local={...task(),source:'local',project_id:'local',project_name:'  AMC  '};
 assert.equal(projectName(local),'AMC');
 assert.equal(projectName({...local,project_name:'  '}),'');
 assert.equal(workProjectGroups([{...local,project_name:''}],[])[0].name,'未归类');
});


test('two later working progress reports remain visible and searchable after historical start and receipts',()=>{
 const claim={id:'claim',kind:'codex-start:',message:'',run_id:'r1',created_at:'2026-11-14T18:00:00Z'};
 const start={run_id:'r1',native_thread_id:'01234567-89ab-4cde-8123-456789abcdef',observed_at:'2026-11-14T18:00:01Z'};
 const initial={...task(),source:'local',status:'working',summary:'已领取一次显式 Codex 执行；尚未证明启动或交付。',events:[claim],codex_start:start};
 assert.equal(taskSummary(initial),'CLI 已报告首轮开始，等待结果');
 let current=initial;
 for(const [index,message] of ['已定位重复查询，正在验证缓存边界','已修复缓存边界，正在运行分页回归'].entries()){
  const progress={...claim,id:`progress-${index}`,kind:'reports:progress',message,created_at:`2026-11-14T18:0${index+1}:00Z`};
  current={...current,summary:message,events:[...current.events,progress,{...progress,id:`receipt-${index}`,kind:'reports:receipt',message:'已收到旧指令'}]};
  assert.equal(taskSummary(current),message);
  assert.equal(matchesTaskSearch(current,message),true);
  assert.equal(matchesTaskSearch(current,'CLI 已报告首轮开始'),false);
  assert.equal(codexStartObservation(current),start);
  assert.equal(current.status,'working');
 }
 assert.equal(matchesTaskSearch(current,'重复查询'),false);
 assert.equal(matchesTaskSearch(current,'分页回归'),true);
 assert.equal(taskSummary({...current,events:[...current.events,{...claim,id:'old-run-claim',run_id:'old-run'}]}),current.summary);
 // Even literal claim wording later reported as progress must not become a start hint.
 const repeated={...current,summary:initial.summary,events:[...current.events,{...claim,id:'literal-progress',kind:'reports:progress',message:initial.summary}]};
 assert.equal(taskSummary(repeated),initial.summary);
});


test('unresolved missing evidence joins the existing issues count/filter within exact project scope',()=>{
 const missing={...task(),id:'missing',source:'local',project_id:'local',project_name:'AMC',status:'needs_evidence',evidence:[{excerpt:'Retained text, not known to be valid current evidence'}]};
 const requested={...missing,id:'requested',follow_up_count:1,commands:[{...command('received'),kind:'follow_up'}]};
 const other={...missing,id:'other',project_name:'relay'};
 const records=[missing,requested,other,{...missing,id:'ready',status:'ready'}];
 const scoped=records.filter(t=>matchesWorkView(t,taskProjectView(missing)));
 assert.deepEqual(scoped.filter(t=>matchesWorkFilter(t,'issues')).map(t=>t.id),['missing','requested']);
 assert.equal(projectWorkCounts(scoped).issues,2);
 for(const item of [missing,requested]){
  assert.equal(hasWorkIssue(item),true);assert.equal(activeWork(item),true);assert.equal(pendingDeliveryReview(item),false);
  assert.equal(currentReadyReportID(item),undefined);assert.equal(pinDeliveryReview(item),undefined);
  assert.equal(reviewEvidencePreview(item),undefined);assert.equal(deliveryHandoffText(item,undefined),undefined);
  assert.equal(item.evidence[0].excerpt,missing.evidence[0].excerpt);
 }
 assert.equal(hasWorkIssue({...requested,status:'ready'}),false);
});
test('new completed ready reports use the exact latest event for review, handoff and stale marker invalidation',()=>{
 const old={id:'ready-1',kind:'reports:ready',message:'R1',run_id:'r1',created_at:'2026-11-14T18:00:01Z'};
 const completed={...old,id:'completed-2',kind:'reports:completed',message:'Declared completion',origin:'Reporter',created_at:'2026-11-14T18:01:02Z'};
 const prior={...task(),source:'local',status:'ready',summary:'R1',evidence:[{excerpt:'R1 evidence'}],events:[old],delivery_review:{run_id:'r1',report_event_id:old.id,reviewed_at:'2026-11-14T18:00:02Z'},local_follow_up:{run_id:'r1',report_event_id:old.id,state:'ended' as const,recorded_at:'2026-11-14T18:00:03Z'}};
 const pinned=pinDeliveryReview(prior);
 const next={...prior,summary:completed.message,evidence:[{excerpt:'Completed declaration evidence'}],events:[old,completed]};
 assert.equal(currentReadyReportID(next),completed.id);assert.equal(pendingDeliveryReview(next),true);assert.equal(activeWork(next),true);
 assert.equal(reviewedDelivery(next),undefined);assert.equal(endedLocalFollowUp(next),false);
 assert.equal(deliveryReviewRequest(next,pinned),undefined);assert.equal(deliveryHandoffText(next,pinned),undefined);
 assert.deepEqual(pinDeliveryReview(next),{task_id:next.id,run_id:'r1',report_event_id:completed.id});
 assert.ok(deliveryHandoffText(next,pinDeliveryReview(next))!.includes('Completed declaration evidence'));
 const seen={...next,delivery_review:{...next.delivery_review,report_event_id:completed.id}};
 assert.equal(reviewedDelivery(seen)?.report_event_id,completed.id);assert.ok(pinRowFollowUp(seen));
 assert.equal(currentReadyReportID({...next,events:[old,completed,{...completed,id:'receipt',kind:'reports:receipt'}]}),completed.id);
 assert.equal(currentReadyReportID({...next,events:[old,completed,{...completed,id:'new-progress',kind:'reports:progress'}]}),undefined);
});
test('completed event references work for explicit previous snapshots and omission without reopening old done',()=>{
 const old={id:'completed-old',kind:'reports:completed',message:'Old declaration',origin:'Reporter',run_id:'r1',created_at:'2026-11-14T18:00:01Z'};
 const history={run_id:'r1',report_event_id:old.id,reported_at:old.created_at,origin:old.origin,summary:old.message,total_count:1,evidence:[{excerpt:'Retained previous text'}]};
 const latest={...old,id:'ready-new',kind:'reports:ready',created_at:'2026-11-14T18:01:02Z'};
 const current={...task(),source:'local',status:'ready',evidence:[{excerpt:'Current evidence'}],events:[old,latest],previous_delivery_evidence:history};
 assert.equal(previousDeliveryEvidence(current),history);
 const omitted={run_id:'r1',report_event_id:old.id,reason:'task_size_limit' as const};
 assert.equal(previousEvidenceUnretained({...current,previous_delivery_evidence:undefined,previous_evidence_unretained:omitted}),omitted);
 const done={...task(),source:'local',status:'done',summary:'Historical completed declaration',evidence:[{excerpt:'Historical evidence'}],events:[old]};
 assert.equal(currentReadyReportID(done),undefined);assert.equal(pendingDeliveryReview(done),false);assert.equal(activeWork(done),false);
 assert.equal(pinDeliveryReview(done),undefined);assert.equal(deliveryHandoffText(done,undefined),undefined);
 assert.equal(matchesWorkFilter(done,'all'),true);assert.equal(done.status,'done');assert.equal(done.events[0].kind,'reports:completed');
});


const stoppedPrestartFailure=():Task=>({...task(),project_id:'local',source:'local',status:'blocked',decision:null,events:[{id:'created',kind:'local_created',message:'Created',run_id:'r1',created_at:'2026-11-14T18:00:00Z'},{id:'claimed',kind:'codex-start:',message:'Claimed',run_id:'r1',created_at:'2026-11-14T18:00:01Z'},{id:'failed',kind:'reports:failed',message:'Pre-start failure reported',origin:'Codex CLI bridge; no successful delivery claimed',run_id:'r1',created_at:'2026-11-14T18:00:02Z'}]});
test('new attempt pins only the exact narrow claimed pre-start failure and requires explicit stopped confirmation',()=>{
 const t=stoppedPrestartFailure(),target=pinNewAttempt(t);
 assert.deepEqual(target,{task_id:'t',run_id:'r1',failed_event_id:'failed'});
 assert.equal(newAttemptRequest(t,target,false),undefined);
 assert.deepEqual(newAttemptRequest(t,target,true),{run_id:'r1',failed_event_id:'failed',confirm_stopped:true});
 assert.equal(t.status,'blocked');assert.equal(t.run_id,'r1');assert.equal(t.events.length,3);
 const retried={...t,run_id:'r2',events:[...t.events,{...t.events[0],id:'retry-created',kind:'local_retry_created',run_id:'r2'},{...t.events[1],id:'retry-claim',run_id:'r2'},{...t.events[2],id:'retry-failed',run_id:'r2'}]};
 assert.equal(pinNewAttempt(retried)?.failed_event_id,'retry-failed');
 assert.equal(newAttemptRequest(retried,target,true),undefined);
});
test('pre-start retry eligibility rejects execution, delivery, decision, command and unsafe history context',()=>{
 const t=stoppedPrestartFailure();
 for(const change of [{source:'synthetic'},{project_id:'demo'},{status:'failed'},{status:'working'},{status:'not_started'},{codex_start:{run_id:'r1',native_thread_id:'thread',observed_at:'2026-11-14T18:00:01Z'}},{codex_launch_notice:{category:'missing_executable',recorded_at:'2026-11-14T18:00:00Z'}},{codex_binding:{} as Task['codex_binding']},{decision:{question:'Decide',options:['A','B']}},{commands:[command()]},{evidence:[{excerpt:'Any retained evidence'}]},{follow_up_count:1},{delivery_review:{} as Task['delivery_review']},{local_follow_up:{} as Task['local_follow_up']},{previous_delivery_evidence:{} as Task['previous_delivery_evidence']},{previous_evidence_unretained:{} as Task['previous_evidence_unretained']},{events:[t.events[0],t.events[2]]},{events:[...t.events,{...t.events[2],id:'another-failure'}]},{events:[{...t.events[0],kind:'reports:ready'},...t.events.slice(1)]}])assert.equal(pinNewAttempt({...t,...change}),undefined,JSON.stringify(change));
});
test('polling cannot retarget stopped approval to a newer failure, task, run or appended event',()=>{
 const t=stoppedPrestartFailure(),target=pinNewAttempt(t),before=JSON.stringify(target);
 for(const changed of [{...t,id:'other-task'},{...t,run_id:'other-run'},{...t,events:[...t.events.slice(0,-1),{...t.events[2],id:'newer-failed'}]},{...t,events:[...t.events,{...t.events[2],id:'other-run-event',run_id:'other-run'}]}])assert.equal(newAttemptRequest(changed,target,true),undefined);
 assert.equal(newAttemptRequest(t,undefined,true),undefined);assert.equal(JSON.stringify(target),before);
 assert.equal(newAttemptRequest({...t,project_name:'renamed'},target,true)?.failed_event_id,'failed');
});


test('same-board work links contain only the exact encoded local ID and no alternate address or query',()=>{
 const t={...task(),source:'local',id:'work/a?b&c#d🙂',goal:'HIDDEN-GOAL',origin:'HIDDEN-ORIGIN'};
 const link=workItemLink({origin:'http://127.0.0.1:18819',pathname:'/workbench'},t)!;
 assert.equal(link,'http://127.0.0.1:18819/workbench#work='+encodeURIComponent(t.id));
 assert.equal(parseWorkFragment(new URL(link).hash),t.id);
 assert.doesNotMatch(link,/HIDDEN|run_id|project|permission|action/);
 assert.equal(workItemLink({origin:'http://localhost:18819',pathname:'//not-another-host/path'},t)!.startsWith('http://localhost:18819/'),true);
 assert.equal(workItemLink({origin:'http://127.0.0.1:18819',pathname:'/'},{...t,source:'synthetic'}),undefined);
 assert.equal(workItemLink({origin:'http://127.0.0.1:18819',pathname:'/'},{...t,project_id:'demo'}),undefined);
});
test('work fragment parser ignores unrelated, malformed and multi-parameter hashes',()=>{
 for(const hash of ['', '#other=work-x','#work=','#work=%20','#work=%E0%A4%A','#work=task&run=another','#work=task&action=start','#work=%00task','#work=task%0A'])assert.equal(parseWorkFragment(hash),undefined,hash);
 assert.equal(parseWorkFragment('#work=work-123'),'work-123');
 assert.equal(parseWorkFragment('#work='+encodeURIComponent('opaque & literal')),'opaque & literal');
});
test('linked selection waits for a successful current-board snapshot and can find filtered archived local work',()=>{
 const local={...task(),id:'local-archived',source:'local',status:'done'};
 const tasks=[local,{...local,id:'demo',project_id:'demo'},{...local,id:'synthetic',source:'synthetic'}];
 assert.deepEqual(resolveWorkLink(tasks,local.id,false),{kind:'waiting'});
 assert.deepEqual(resolveWorkLink(tasks,'not-present',false),{kind:'waiting'});
 assert.deepEqual(resolveWorkLink([],undefined,false),{kind:'none'});
 assert.deepEqual(resolveWorkLink(tasks,local.id,true),{kind:'found',task:local});
 assert.deepEqual(resolveWorkLink(tasks,'not-present',true),{kind:'missing'});
 assert.deepEqual(resolveWorkLink(tasks,'demo',true),{kind:'missing'});
 assert.deepEqual(resolveWorkLink(tasks,'synthetic',true),{kind:'missing'});
 assert.equal(matchesWorkFilter(local,'active'),false);assert.equal(local.status,'done');
});


test('explicit card open cancels pending link so a late successful read cannot hijack task or pin',async()=>{
 const a={...task(),id:'A',source:'local',status:'ready',evidence:[{excerpt:'R1'}],events:[{id:'A-ready-1',kind:'reports:ready',message:'R1',run_id:'r1',created_at:'2026-11-14T18:00:01Z'}]};
 const a2={...a,evidence:[{excerpt:'R2'}],events:[...a.events,{...a.events[0],id:'A-ready-2'}]};
 const b={...a,id:'B',events:[{...a.events[0],id:'B-ready-1'}]};
 for(const manuallyOpened of [b,a]){
  const intent=workLinkIntent();intent.navigate('#work=A');
  let release!:(tasks:Task[])=>void;
  let selected:string|undefined,pin:ReturnType<typeof pinDeliveryReview>;
  const delayed=new Promise<Task[]>(resolve=>{release=resolve}).then(tasks=>{const linked=intent.consume(tasks);if(linked.kind==='found'){selected=linked.task.id;pin=pinDeliveryReview(linked.task)}});
  // This is the same cancellation made by App.open before changing selection.
  intent.cancel();selected=manuallyOpened.id;pin=pinDeliveryReview(manuallyOpened);
  const original=JSON.stringify(pin);
  release([a2,b]);await delayed;
  assert.equal(selected,manuallyOpened.id);assert.equal(JSON.stringify(pin),original);
  if(manuallyOpened===a)assert.equal(deliveryReviewRequest(a2,pin),undefined);
 }
});
test('normal linked-read consumption and Close stay one-shot without changing unrelated fragments',()=>{
 const local={...task(),source:'local'};
 const intent=workLinkIntent();
 assert.equal(intent.navigate('#work=t'),true);
 assert.deepEqual(intent.consume([local]),{kind:'found',task:local});
 assert.deepEqual(intent.consume([local]),{kind:'none'});
 intent.navigate('#work=t');intent.cancel();assert.deepEqual(intent.consume([local]),{kind:'none'});
 assert.equal(intent.navigate('#unrelated=keep-me'),false);assert.deepEqual(intent.consume([local]),{kind:'none'});
});


test('empty model-blocked report with lost start observation cannot be offered a pre-start retry',()=>{
 const t=stoppedPrestartFailure(),target=pinNewAttempt(t);
 assert.ok(target);
 for(const origin of [undefined,'manual reporter','Codex CLI bridge; no successful delivery claimed ','Codex CLI native thread 01234567-89ab-4cde-8123-456789abcdef; model-declared blocked diagnosis and evidence, not independent verification']){
  const blocked={...t,codex_start:undefined,evidence:[],events:[...t.events.slice(0,-1),{...t.events[2],origin}]};
  assert.equal(pinNewAttempt(blocked),undefined,origin);
  assert.equal(newAttemptRequest(blocked,target,true),undefined,origin);
  assert.equal(blocked.status,'blocked');
 }
});


test('task creation is available only in overview/local project scopes with exact name defaults',()=>{
 const local={...task(),source:'local',project_id:'local',project_name:'Example Project'};
 assert.equal(creationProjectName('overview'),'');
 assert.equal(creationProjectName(taskProjectView(local)),'Example Project');
 assert.equal(creationProjectName(taskProjectView({...local,project_name:''})),'');
 assert.equal(creationProjectName(taskProjectView({...local,project_name:'overview'})),'overview');
 for(const view of ['attention','decisions','source-demo','legacy-project:"Example Project"','local','project-name:invalid','project-name:123','project-name:" padded "'])assert.equal(creationProjectName(view),undefined,view);
});

test('browser-created tasks show their automatic source, while legacy source stays labelled as reported',()=>{
 const local={...task(),source:'local',project_id:'local'};
 assert.equal(taskOrigin({...local,origin:'工作台新建'}),'本地工作 · 来源：工作台新建');
 assert.equal(taskOrigin({...local,origin:'CLI'}),'本地工作 · 来源（填报）：CLI');
});

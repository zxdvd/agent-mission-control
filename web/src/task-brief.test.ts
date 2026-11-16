import assert from 'node:assert/strict';
import {test} from 'node:test';
import {taskDetailBrief} from './task-brief.ts';
import type {Task} from './model.ts';

function ready(overrides:Partial<Task>={}):Task{
 const summary='修复列表刷新时漏掉最后一项。';
 return {id:'t1',run_id:'r1',source:'local',project_id:'local',title:'修复计数',goal:'长结果后列表计数不准确。',status:'ready',summary,observed_at:'',updated_at:'',commands:[],decision:null,follow_up_count:0,
 events:[{id:'e1',run_id:'r1',kind:'reports:ready',message:summary,created_at:''}],
 evidence:[{label:'Implementation',excerpt:'只修改列表解析器，保留错误返回。'},{label:'测试结果：本地',excerpt:'12 项通过；未跑浏览器。'},{label:'Review focus',excerpt:'请看解析失败时整页返回错误是否符合预期。'},{label:'Operator action',excerpt:'核对失败时的产品文案。'}],...overrides};
}

test('brief projects real recorded delivery only and does not make up missing sections',()=>{
 const t=ready();
 assert.deepEqual(taskDetailBrief(t),{background:t.goal,outcome:t.summary,approach:'只修改列表解析器，保留错误返回。',verification:['12 项通过；未跑浏览器。'],reviewFocus:'请看解析失败时整页返回错误是否符合预期。',operatorNote:'核对失败时的产品文案。'});
 assert.deepEqual(taskDetailBrief(ready({evidence:[{label:'原始日志',excerpt:'Please review? Tests were mentioned in chat.'}]})),{background:t.goal,outcome:t.summary,verification:[]});
});

test('brief does not use stale evidence, stale run, receipts or placeholder summaries as delivery',()=>{
 const t=ready();
 const receipt={...t.events[0],id:'e2',kind:'reports:receipt',message:'not a result'};
 assert.equal(taskDetailBrief({...t,events:[...t.events,receipt]}).reviewFocus,'请看解析失败时整页返回错误是否符合预期。');
 for(const task of [ready({run_id:'r2'}),ready({status:'working'}),ready({status:'blocked'}),ready({status:'needs_evidence'}),ready({summary:'newer unanchored text'})]){
  const brief=taskDetailBrief(task);
  assert.equal(brief.reviewFocus,undefined);assert.equal(brief.operatorNote,undefined);assert.deepEqual(brief.verification,[]);
 }
 assert.equal(taskDetailBrief(ready({status:'not_started',events:[]})).outcome,undefined);
});

test('brief normalizes whitespace, bounds Unicode, limits and deduplicates verification',()=>{
 const segment='验🙂'.repeat(150);
 const brief=taskDetailBrief(ready({goal:' A\n B ',evidence:[{label:'验证结果',excerpt:segment},{label:'Test results',excerpt:segment},{label:'Verification',excerpt:'另验了一项'},{label:'测试',excerpt:'不要占据首屏'}]}));
 assert.equal(brief.background,' A\n B ');
 assert.equal(brief.backgroundPreview,undefined);
 assert.equal(Array.from(brief.verification[0]).length,181);
 assert.deepEqual(brief.verification.slice(1),['另验了一项']);
});

test('not-started ready badge or report title alone cannot generate a review request',()=>{
 const task=ready({evidence:[{label:'Review focus',url:'https://example.test/evidence'}]});
 assert.equal(taskDetailBrief(task).reviewFocus,undefined);
});


test('short background stays complete without an expansion preview, including Unicode and line breaks',()=>{
 for(const goal of ['目标', ' A\n B ', '一\r\n二\r\n三\r\n四', '🙂'.repeat(220)]){
  const brief=taskDetailBrief(ready({goal}));
  assert.equal(brief.background,goal);
  assert.equal(brief.backgroundPreview,undefined);
 }
});

test('long background keeps the exact original goal and bounds only its Unicode-safe preview',()=>{
 for(const goal of ['验🙂'.repeat(150)+'\n末尾目标', 'https://example.test/'+'x'.repeat(1000), '🙂'.repeat(221)]){
  const task=ready({goal}),before=JSON.stringify(task),brief=taskDetailBrief(task);
  assert.equal(brief.background,goal);
  assert.equal(brief.backgroundPreview,Array.from(goal).slice(0,220).join('')+'…');
  assert.equal(Array.from(brief.backgroundPreview!).length,221);
  assert.equal(JSON.stringify(task),before);
 }
});

test('many short lines get an expandable compact preview without losing original whitespace',()=>{
 for(const separator of ['\n','\r\n']){
  const goal=['第一行','  第二行','','第四行','第五行'].join(separator),brief=taskDetailBrief(ready({goal}));
  assert.equal(brief.background,goal);
  assert.equal(brief.backgroundPreview,['第一行','  第二行','','第四行'].join(separator)+'…');
 }
});

test('missing background remains a plain placeholder without a disclosure',()=>{
 for(const goal of ['', '  \n \t', undefined]){
  const brief=taskDetailBrief(ready({goal}));
  assert.equal(brief.background,'未记录');
  assert.equal(brief.backgroundPreview,undefined);
 }
});

import { currentReadyReportID, type Task } from './model.ts';

export type TaskDetailBrief={
 background:string;
 outcome?:string;
 approach?:string;
 verification:string[];
 operatorNote?:string;
 reviewFocus?:string;
};

function short(text:string|undefined, max:number):string|undefined {
 if(typeof text!=='string')return;
 const normalized=text.replace(/\s+/g,' ').trim();
 if(!normalized)return;
 const chars=Array.from(normalized);
 return chars.length>max?chars.slice(0,max).join('')+'…':normalized;
}

const approachLabels=/^(?:how it was solved|implementation|approach|local patch|实现方式|解决方式|如何解决|改动说明|本地补丁)(?:$|\s*[:：·])/i;
const validationLabels=/^(?:verification|validation|tests?|test results?|验证(?:结果|范围)?|测试(?:结果|范围)?|回归测试)(?:$|\s*[:：·])/i;
const operatorLabels=/^(?:operator action|user action|需要我做什么|需要你做什么|需要用户操作|待用户操作)$/i;
const reviewLabels=/^(?:review focus|review request|审阅重点|审核重点|需要审什么|请审阅)$/i;

// This reads the current recorded report only. Evidence retained by a progress
// or failed report without an explicit evidence array is not a fresh delivery.
export function taskDetailBrief(task:Task):TaskDetailBrief {
 const brief:TaskDetailBrief={background:short(task.goal,220)||'未记录',verification:[]};
 const events=task.events||[];
 let event:Task['events'][number]|undefined;
 for(let i=events.length-1;i>=0;i--){
  const candidate=events[i];
  if(candidate.run_id===task.run_id&&candidate.kind.startsWith('reports:')&&candidate.kind!=='reports:receipt'){event=candidate;break}
 }
 if(!event||event.message!==task.summary)return brief;
 const outcome=short(event.message,200);
 if(outcome&&outcome!==brief.background)brief.outcome=outcome;
 if(!currentReadyReportID(task))return brief;
 for(const evidence of task.evidence||[]){
  const label=typeof evidence.label==='string'?evidence.label.trim():'';
  const excerpt=short(evidence.excerpt,180);
  if(!excerpt)continue;
  if(approachLabels.test(label))brief.approach??=excerpt;
  else if(validationLabels.test(label)&&brief.verification.length<2&&!brief.verification.includes(excerpt))brief.verification.push(excerpt);
  else if(operatorLabels.test(label))brief.operatorNote??=short(evidence.excerpt,140);
  else if(reviewLabels.test(label))brief.reviewFocus??=short(evidence.excerpt,160);
 }
 return brief;
}

import { canNameProject, hiddenLocalWork, taskProjectView, type WorkProjectGroup } from './model.ts';

export type ProjectReportPreview={title:string;excerpt:string;reportedAt:string};
const substantiveKinds=new Set(['reports:progress','reports:ready','reports:completed','reports:failed']);
const compact=(value:string,limit:number)=>{
 const characters=Array.from(value.trim().replace(/\s+/g,' '));
 return characters.slice(0,limit).join('')+(characters.length>limit?'…':'');
};

// store.now() emits UTC RFC3339Nano. Pad fractions before comparing so
// sub-millisecond ordering survives JavaScript Date's millisecond precision.
const reportTimeKey=(value:string):string|undefined=>{
 const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
 if(!match)return;
 const millis=Date.parse(value);
 if(!Number.isFinite(millis)||new Date(millis).toISOString().slice(0,19)!==match[1])return;
 return match[1]+'.'+(match[2]||'').padEnd(9,'0');
};

// Project-card context only: current-run report text, not task administration,
// delivery evidence, raw diagnostics, execution liveness or acceptance.
export function latestProjectReport(group:WorkProjectGroup):ProjectReportPreview|undefined {
 if(group.kind!=='local')return;
 let latest:{time:string;taskID:string;eventIndex:number;preview:ProjectReportPreview}|undefined;
 for(const task of group.items){
  if(!canNameProject(task)||hiddenLocalWork(task)||taskProjectView(task)!==group.key)continue;
  for(const [eventIndex,event] of (task.events||[]).entries()){
   if(event.run_id!==task.run_id||!substantiveKinds.has(event.kind)||!event.message?.trim())continue;
   const time=reportTimeKey(event.created_at);
   if(time===undefined)continue;
   // Same-task exact ties use append order. Cross-task ties use a stable ID,
   // not task-list order; that comparison metadata never leaves the helper.
   if(latest&&(time<latest.time||time===latest.time&&(task.id>latest.taskID||task.id===latest.taskID&&eventIndex<=latest.eventIndex)))continue;
   latest={time,taskID:task.id,eventIndex,preview:{title:compact(task.title,40),excerpt:compact(event.message,100),reportedAt:event.created_at}};
  }
 }
 return latest?.preview;
}

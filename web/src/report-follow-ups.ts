import {currentReadyReportID, type Task, type Evidence} from './model.ts';
export type FollowUpTarget={task_id:string;run_id:string;report_event_id:string};
export type FollowUpIntent=FollowUpTarget&{request_id:string;kind:'explain'|'adjust';message:string};
export type ReportFollowUp=FollowUpIntent&{state:'pending'|'running'|'completed'|'blocked'|'uncertain';reply?:string;created_at:string;claimed_at?:string;finished_at?:string;result_evidence?:Evidence[]};
export function followUpTarget(task:Task):FollowUpTarget|undefined {
 const reportID=currentReadyReportID(task);
 if(!reportID||task.decision||!task.run_id)return;
 return {task_id:task.id,run_id:task.run_id,report_event_id:reportID};
}
export const sameReport=(a:FollowUpTarget|undefined,b:FollowUpTarget|undefined)=>!!a&&!!b&&a.task_id===b.task_id&&a.run_id===b.run_id&&a.report_event_id===b.report_event_id;
export const followUpStorageKey=(target:FollowUpTarget)=>'awb:report-follow-up:'+JSON.stringify([target.task_id,target.run_id,target.report_event_id]);
export function parseSavedIntent(raw:string|null,taskID:string):FollowUpIntent|undefined {
 try{const v=JSON.parse(raw||'null');if(v&&v.task_id===taskID&&['request_id','run_id','report_event_id','message'].every(k=>typeof v[k]==='string'&&v[k].trim())&&(v.kind==='explain'||v.kind==='adjust'))return v}catch{/* Invalid drafts are never submitted. */}
}
export const followUpInFlight=(records:ReportFollowUp[],target:FollowUpTarget)=>records.some(r=>sameReport(r,target)&&(r.state==='pending'||r.state==='running'||r.state==='uncertain'));
export const duplicateFollowUp=(records:ReportFollowUp[],intent:Pick<FollowUpIntent,'kind'|'message'>&FollowUpTarget)=>records.some(r=>sameReport(r,intent)&&r.kind===intent.kind&&r.message.trim()===intent.message.trim());
export const followUpStateLabel={pending:'已记录 · 待执行者领取',running:'已领取 · 执行结果待确认',completed:'已回报完成 · 未独立核验',blocked:'跟进受阻',uncertain:'结果待核实'};

// URL owns the task scope; the strict POST DTO must not include task_id or record fields.
export const followUpPayload=(intent:FollowUpIntent)=>({request_id:intent.request_id,run_id:intent.run_id,report_event_id:intent.report_event_id,kind:intent.kind,message:intent.message});

// A verified absent stale intent can be abandoned, never retargeted or resent.
export const canAbandonFollowUp=(saved:FollowUpIntent|undefined,current:FollowUpTarget|undefined,records:ReportFollowUp[],readSucceeded:boolean)=>!!saved&&readSucceeded&&!sameReport(saved,current)&&!records.some(r=>r.request_id===saved.request_id);

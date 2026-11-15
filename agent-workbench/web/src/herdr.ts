// Accept only the privacy-minimal observation contract, never raw CLI output.
export type HerdrEntry = {id:string;status:string;observed_at?:string};
export type HerdrObservation = {
 kind:'unavailable'|'incompatible'|'empty'|'observed';
 entries:HerdrEntry[];
 version?:string;
 observed_at?:string;
};
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const timestamp=(value:unknown):string|undefined=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:undefined;
export const observedStatuses:Record<string,string>={working:'工作中',idle:'空闲',waiting:'等待中',blocked:'受阻',paused:'暂停',done:'进程报告已结束',failed:'进程报告失败',unknown:'未知'};
export function parseHerdrObservation(value:unknown):HerdrObservation {
 const incompatible:HerdrObservation={kind:'incompatible',entries:[]};
 if(!record(value)||typeof value.available!=='boolean')return incompatible;
 if(!value.available)return {kind:'unavailable',entries:[]};
 if(value.mode!=='read_only'||value.compatibility!=='verified'||!Array.isArray(value.entries))return incompatible;
 const entries:HerdrEntry[]=[],ids=new Set<string>();
 for(const item of value.entries){
  // Reject malformed/duplicate identifiers, rather than mistaking a partial list for empty.
  if(!record(item)||typeof item.id!=='string'||!/^[%a-zA-Z0-9._:-]{1,80}$/.test(item.id)||ids.has(item.id))return incompatible;
  ids.add(item.id);
  entries.push({id:item.id,status:typeof item.status==='string'&&Object.hasOwn(observedStatuses,item.status)?item.status:'unknown',observed_at:timestamp(item.observed_at)});
 }
 return {kind:entries.length?'observed':'empty',entries,version:typeof value.version==='string'&&/^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.version)?value.version:undefined,observed_at:timestamp(value.observed_at)};
}

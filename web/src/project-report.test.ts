import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Task, workProjectGroups } from './model.ts';
import { latestProjectReport } from './project-report.ts';

const task=(id='a'):Task=>({id,project_id:'local',project_name:'Workbench',source:'local',title:'交付检查',goal:'Private goal',status:'working',run_id:'r1',summary:'Task summary is not report authority',updated_at:'2026-11-15T20:00:00Z',observed_at:'2026-11-15T20:00:00Z',evidence:[],decision:null,follow_up_count:0,events:[],commands:[]});
const report=(kind:string,message:string,created_at='2026-11-15T10:00:00Z',id='report')=>({id,kind,message,run_id:'r1',created_at});
const group=(items:Task[])=>workProjectGroups(items,[]).find(group=>group.kind==='local')!;

test('local project preview uses report time/current run rather than recent task admin or old-run reports',()=>{
 const old={...task('a'),title:'Old report; recently renamed',updated_at:'2026-11-15T23:00:00Z',events:[report('reports:ready','Older outcome','2026-11-15T09:00:00Z'),report('project_name_changed','Admin text','2026-11-15T23:00:00Z'),{...report('reports:progress','Old-run outcome','2026-11-15T23:01:00Z'),run_id:'old-run'}]};
 const current={...task('b'),title:'Latest business report',updated_at:'2026-11-15T10:00:00Z',events:[report('reports:progress','Latest meaningful progress'),report('reports:receipt','Receipt only','2026-11-15T23:02:00Z')]};
 assert.deepEqual(latestProjectReport(group([old,current])),{title:current.title,excerpt:'Latest meaningful progress',reportedAt:'2026-11-15T10:00:00Z'});
 for(const kind of ['reports:progress','reports:ready','reports:completed','reports:failed'])assert.equal(latestProjectReport(group([{...task(),events:[report(kind,kind)]}]))?.excerpt,kind);
});

test('preview omits non-substantive/invalid data and never crosses exact local project or legacy/demo scope',()=>{
 const local={...task(),events:[report('local_created','Created'),report('codex-start:','Claimed'),report('reports:needs_decision','Question'),report('reports:receipt','Receipt'),report('delivery_review','Seen'),report('local_follow_up','Ended'),report('reports:progress','  \n '),report('reports:failed','Bad timestamp','invalid')]};
 assert.equal(latestProjectReport(group([local])),undefined);
 const other={...task('other'),project_name:'Other',events:[report('reports:ready','Other project','2026-11-15T23:00:00Z')]};
 const scoped=group([local]);
 assert.equal(latestProjectReport({...scoped,items:[local,other]}),undefined);
 for(const kind of ['legacy','demo'] as const)assert.equal(latestProjectReport({...scoped,kind,items:[other]}),undefined);
 assert.equal(latestProjectReport({...scoped,items:[{...other,source:'synthetic',project_name:'Workbench'}]}),undefined);
 assert.equal(latestProjectReport({...scoped,items:[]}),undefined);
});

test('exact timestamp ties prefer last same-task append, then stable task ID across tasks',()=>{
 const a={...task('a'),events:[report('reports:progress','First append',undefined,'a'),report('reports:ready','Last append',undefined,'z')]};
 const b={...task('b'),events:[report('reports:failed','Task B')]};
 assert.equal(latestProjectReport(group([a,b]))?.excerpt,'Last append');
 assert.deepEqual(latestProjectReport(group([a,b])),latestProjectReport(group([b,a])));
 assert.equal(latestProjectReport(group([{...a,events:[...a.events].reverse()}]))?.excerpt,'First append');
 const normalized={...a,events:[report('reports:progress','Whole second','2026-11-15T10:00:00Z','z'),report('reports:ready','Same second, later append','2026-11-15T10:00:00.000000000Z','a')]};
 assert.equal(latestProjectReport(group([normalized]))?.excerpt,'Same second, later append');
});

test('report comparison retains RFC3339Nano fractions within the same millisecond',()=>{
 const earlier='2026-11-15T10:00:00.123456781Z',later='2026-11-15T10:00:00.123456789Z';
 assert.equal(Date.parse(earlier),Date.parse(later));
 const a={...task('a'),events:[report('reports:ready','Earlier fraction',earlier)]};
 const b={...task('b'),events:[report('reports:progress','Later fraction',later)]};
 assert.equal(latestProjectReport(group([a,b]))?.excerpt,'Later fraction');
 assert.equal(latestProjectReport(group([b,a]))?.reportedAt,later);
 const sameTask={...a,events:[report('reports:ready','Later fraction first',later),report('reports:progress','Earlier fraction appended',earlier)]};
 assert.equal(latestProjectReport(group([sameTask]))?.excerpt,'Later fraction first');
 for(const timestamp of ['invalid','2026-11-15T10:00:00.1234567890Z','2026-02-30T10:00:00Z'])assert.equal(latestProjectReport(group([{...a,events:[report('reports:ready','Invalid timestamp',timestamp)]}])),undefined);
});

test('preview is bounded plain text without evidence links, logs, hidden context or mutation',()=>{
 const body='  <b>Declared</b>\n'+ '结果🙂'.repeat(100);
 const t={...task(),title:'工作'.repeat(30),events:[report('reports:ready',body)],evidence:[{url:'https://private.example/evidence',excerpt:'RAW-LOG-CONTENT',origin:'HIDDEN-ORIGIN'}]};
 const before=JSON.stringify(t),preview=latestProjectReport(group([t]))!;
 assert.equal(Array.from(preview.title).length,41);
 assert.equal(Array.from(preview.excerpt).length,101);
 assert.ok(preview.excerpt.startsWith('<b>Declared</b> '));
 assert.doesNotMatch(JSON.stringify(preview),/https:|RAW-LOG|HIDDEN|Private goal|Task summary/);
 assert.equal(JSON.stringify(t),before);
});

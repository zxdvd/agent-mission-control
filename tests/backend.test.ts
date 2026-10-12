import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { applyTestMigrations } from './helpers/migrations';
import { Miniflare } from 'miniflare';
import { app } from '../worker/index';
import { inferAttention, ingest, IngestError } from '../worker/db';
import { isLoopbackRequest } from '../worker/auth';
import { canonicalEvent, sha256, validateEvent } from '../worker/protocol';
import type { AgentEvent, Env } from '../worker/types';

let mf: Miniflare;
let db: D1Database;
let env: Env;
const tokenA='amc_'+'a'.repeat(64);
const tokenB='amc_'+'b'.repeat(64);
let serial=0;
const timestamp=(second=0)=>new Date(Date.UTC(2026,9,12,0,0,second)).toISOString();
function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return validateEvent({event_id:`event-${++serial}`,timestamp:timestamp(serial),host_id:'host-a',agent_type:'codex',session_id:'session-a',
    task_id:'task-a',run_id:'run-a',event_type:'turn_started',payload:{name:'Review backend',repo:'example/app'},...overrides});
}
async function post(e: AgentEvent, token=tokenA) {
  return app.request('http://localhost/api/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(e)},env);
}
async function getTask(id='task-a') {return db.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first<Record<string,unknown>>();}
async function request(path:string,init:RequestInit={}) {return app.request(`http://localhost${path}`,init,env);}

beforeAll(async()=>{
  mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("ok"); } }',compatibilityDate:'2026-08-01',d1Databases:['DB']});
  db=await mf.getD1Database('DB') as unknown as D1Database;
  await applyTestMigrations(db);
  await db.batch([
    db.prepare('INSERT INTO hosts(id,name,created_at) VALUES (?,?,?)').bind('host-a','Host A',timestamp()),
    db.prepare('INSERT INTO hosts(id,name,created_at) VALUES (?,?,?)').bind('host-b','Host B',timestamp()),
  ]);
  env={DB:db,LOCAL_DEV:'true',AGENT_TOKENS_JSON:JSON.stringify([{host_id:'host-a',name:'Host A',token_hash:await sha256(tokenA)},{host_id:'host-b',name:'Host B',token_hash:await sha256(tokenB)}]),ASSETS:{fetch:async()=>new Response('private app')} as unknown as Fetcher};
});
afterAll(async()=>{await mf?.dispose();});

describe('safe event protocol',()=>{
  it('rejects raw content and secret-like values even under allowed fields',()=>{
    expect(()=>event({payload:{prompt:'private'} as never})).toThrow();
    expect(()=>event({payload:{summary:'password=secretvalue'}})).toThrow();
    expect(()=>event({payload:{summary:'line\nline'}})).toThrow();
    expect(()=>event({payload:{repo:'https://token@github.com/a/b'}})).toThrow();
    expect(()=>event({payload:{pr_url:'https://github.com/a/b/pull/1?token=foo'}})).toThrow();
    expect(()=>event({payload:JSON.parse('{"__proto__":"bad"}')})).toThrow();
  });
  it('requires stable identities, run IDs, known types and UTC timestamps',()=>{
    expect(()=>event({event_type:'stop' as never})).toThrow();
    expect(()=>event({run_id:undefined})).toThrow();
    expect(()=>event({timestamp:'2026-10-12 00:00:00'})).toThrow();
    expect(()=>event({timestamp:'2026-02-30T00:00:00.000Z'})).toThrow();
    expect(()=>event({session_id:'host:host-b',event_type:'heartbeat',task_id:undefined,run_id:undefined})).toThrow();
    expect(()=>event({timestamp:'2030-01-01T00:00:00.000Z'})).toThrow();
  });
  it('canonicalizes key order and timestamp precision',()=>{
    const a=event({event_id:'canonical',timestamp:'2026-10-12T00:00:00Z',payload:{name:'x',summary:'y'}});
    const b={...a,payload:{summary:'y',name:'x'}};
    expect(canonicalEvent(a)).toBe(canonicalEvent(b));
    expect(a.timestamp).toBe('2026-10-12T00:00:00.000Z');
  });
});
describe('atomic D1 projections and identity isolation',()=>{
  it('deduplicates simultaneous retries and rejects reused event IDs',async()=>{
    const e=event();
    const results=await Promise.all([post(e),post(e),post(e)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,200,201]);
    expect((await db.prepare('SELECT count(*) n FROM events WHERE event_id=?').bind(e.event_id).first<{n:number}>())?.n).toBe(1);
    expect((await post({...e,payload:{name:'changed'}})).status).toBe(409);
  });
  it('rejects credential host mismatch and all cross-identity references',async()=>{
    expect((await post(event({host_id:'host-b'}))).status).toBe(403);
    expect((await post(event({host_id:'host-b'}),tokenB)).status).toBe(409);
    expect((await post(event({host_id:'host-b',session_id:'session-b'}),tokenB)).status).toBe(409);
    expect((await post(event({session_id:'other-session',task_id:'other-task',run_id:'run-a'}))).status).toBe(409);
    expect((await post(event({agent_type:'claude'}))).status).toBe(409);
  });
  it('turn_finished idles a task without completing it; waiting survives',async()=>{
    await post(event({event_type:'approval_required',timestamp:timestamp(20)}));
    await post(event({event_type:'turn_finished',timestamp:timestamp(21)}));
    const task=await getTask();expect(task?.status).toBe('active');expect(task?.activity).toBe('idle');
    const response=await request('/api/tasks/task-a');
    const detail=await response.json() as {task:{attention:string};attention:unknown[]};
    expect(detail.task.attention).toBe('approval');expect(detail.attention.length).toBeGreaterThan(0);
  });
  it('older starts cannot overwrite a newer finish',async()=>{
    await post(event({event_type:'turn_started',timestamp:timestamp(19)}));
    expect((await getTask())?.activity).toBe('idle');
  });
  it('session_ended never implies successful task completion',async()=>{
    await post(event({event_type:'session_ended',task_id:undefined,run_id:undefined,timestamp:timestamp(22)}));
    expect((await getTask())?.status).toBe('active');expect((await getTask())?.activity).toBe('unknown');
    expect((await db.prepare('SELECT status FROM sessions WHERE id=?').bind('session-a').first<{status:string}>())?.status).toBe('ended');
  });
  it('session end and delayed run creation converge in both arrival orders',async()=>{
    for(const reverse of [false,true]) {
      const ids={session_id:`ended-session-${reverse}`,task_id:`ended-task-${reverse}`,run_id:`ended-run-${reverse}`};
      const start=event({...ids,event_type:'turn_started',timestamp:timestamp(10)});
      const end=event({...ids,event_type:'session_ended',task_id:undefined,run_id:undefined,timestamp:timestamp(20)});
      for(const e of reverse?[end,start]:[start,end]) await post(e);
      const task=await getTask(ids.task_id);expect(task?.status).toBe('active');expect(task?.activity).toBe('unknown');
      expect((await db.prepare('SELECT status FROM runs WHERE id=?').bind(ids.run_id).first<{status:string}>())?.status).toBe('unknown');
    }
  });
  it('only explicit newer session start resumes, and historical end survives resume',async()=>{
    const ids={session_id:'resume-session',task_id:'resume-task',run_id:'resume-run'};
    await post(event({...ids,event_type:'session_ended',task_id:undefined,run_id:undefined,timestamp:timestamp(20)}));
    await post(event({...ids,event_type:'heartbeat',task_id:undefined,run_id:undefined,timestamp:timestamp(25)}));
    const session=()=>db.prepare('SELECT status,ended_at FROM sessions WHERE id=?').bind(ids.session_id).first<{status:string;ended_at:string|null}>();
    expect((await session())?.status).toBe('ended');
    await post(event({...ids,event_type:'session_started',task_id:undefined,run_id:undefined,timestamp:timestamp(30)}));
    expect((await session())?.status).toBe('active');expect((await session())?.ended_at).toBeNull();
    await post(event({...ids,event_type:'turn_started',timestamp:timestamp(10)}));
    expect((await getTask(ids.task_id))?.activity).toBe('unknown');
    await post(event({...ids,event_type:'session_ended',task_id:undefined,run_id:undefined,timestamp:timestamp(20)}));
    expect((await session())?.status).toBe('active');
    await post(event({...ids,event_type:'turn_started',timestamp:timestamp(31)}));
    expect((await getTask(ids.task_id))?.activity).toBe('running');
  });
  it('a delayed explicit resume restores post-resume observed activity',async()=>{
    for(const reverse of [false,true]) {
      const ids={session_id:`resume-order-session-${reverse}`,task_id:`resume-order-task-${reverse}`,run_id:`resume-order-run-${reverse}`};
      const end=event({...ids,event_type:'session_ended',task_id:undefined,run_id:undefined,timestamp:timestamp(20)});
      const resume=event({...ids,event_type:'session_started',task_id:undefined,run_id:undefined,timestamp:timestamp(30)});
      const turn=event({...ids,event_type:'turn_started',timestamp:timestamp(31)});
      await post(end);for(const e of reverse?[turn,resume]:[resume,turn])await post(e);
      expect((await getTask(ids.task_id))?.activity).toBe('running');
      expect((await getTask(ids.task_id))?.status).toBe('active');
    }
  });
  it('a newer retry can succeed and delayed prior-run failures cannot clobber it',async()=>{
    const ids={session_id:'retry-session',task_id:'retry-task',run_id:'retry-run-1'};
    await post(event({...ids,event_type:'turn_started',timestamp:timestamp(30)}));
    await post(event({...ids,event_type:'task_failed',timestamp:timestamp(31)}));
    expect((await getTask('retry-task'))?.status).toBe('failed');
    await post(event({...ids,run_id:'retry-run-2',event_type:'turn_started',timestamp:timestamp(32)}));
    expect((await getTask('retry-task'))?.status).toBe('active');
    await post(event({...ids,run_id:'retry-run-2',event_type:'task_completed',timestamp:timestamp(33)}));
    await post(event({...ids,event_type:'task_failed',timestamp:timestamp(34)}));
    const task=await getTask('retry-task');expect(task?.status).toBe('completed');expect(task?.current_run_id).toBe('retry-run-2');
  });
  it('completion received before start projects deterministically',async()=>{
    const ids={session_id:'unordered-session',task_id:'unordered-task',run_id:'unordered-run'};
    await post(event({...ids,event_type:'task_completed',timestamp:timestamp(42)}));
    await post(event({...ids,event_type:'turn_started',timestamp:timestamp(40)}));
    expect((await getTask(ids.task_id))?.status).toBe('completed');
  });
  it('newer terminal outcomes win in both arrival orders',async()=>{
    for(const reverse of [false,true]) {
      const ids={session_id:`outcome-session-${reverse}`,task_id:`outcome-task-${reverse}`,run_id:`outcome-run-${reverse}`};
      const older=event({...ids,event_type:'task_failed',timestamp:timestamp(44)});
      const newer=event({...ids,event_type:'task_completed',timestamp:timestamp(45)});
      for(const e of reverse?[newer,older]:[older,newer]) await post(e);
      expect((await getTask(ids.task_id))?.status).toBe('completed');
    }
  });
  it('terminal outcomes and subsequent idle events converge in either order',async()=>{
    for(const reverse of [false,true]) {
      const ids={session_id:`idle-outcome-session-${reverse}`,task_id:`idle-outcome-task-${reverse}`,run_id:`idle-outcome-run-${reverse}`};
      const terminal=event({...ids,event_type:'task_completed',timestamp:timestamp(46)});
      const idle=event({...ids,event_type:'turn_finished',timestamp:timestamp(47)});
      for(const e of reverse?[idle,terminal]:[terminal,idle]) await post(e);
      expect((await getTask(ids.task_id))?.status).toBe('completed');
    }
  });
  it('concurrent hosts cannot claim the same fresh task identifier',async()=>{
    const a=event({session_id:'race-session-a',task_id:'race-task',run_id:'race-run-a'});
    const b=event({host_id:'host-b',session_id:'race-session-b',task_id:'race-task',run_id:'race-run-b'});
    const results=await Promise.all([post(a),post(b,tokenB)]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  });
  it('metadata field clocks converge when later events omit earlier fields',async()=>{
    const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
    for(const [i,order] of permutations.entries()) {
      const ids={session_id:`metadata-session-${i}`,task_id:`metadata-task-${i}`,run_id:`metadata-run-${i}`};
      const events=[event({...ids,timestamp:timestamp(10),payload:{name:'Older name',repo:'team/old',summary:'Old summary'}}),
        event({...ids,timestamp:timestamp(20),payload:{name:'New name',repo:'team/new',branch:'work',project:'Example'}}),
        event({...ids,timestamp:timestamp(30),event_type:'turn_finished',payload:{summary:'Latest summary'}})];
      for(const index of order) await post(events[index]);
      expect(await getTask(ids.task_id)).toMatchObject({name:'New name',repo:'team/new',branch:'work',project:'Example',summary:'Latest summary'});
    }
  });
  it('observed attention history is retained regardless of completion arrival order',async()=>{
    for(const reverse of [false,true]) {
      const ids={session_id:`attention-order-session-${reverse}`,task_id:`attention-order-task-${reverse}`,run_id:`attention-order-run-${reverse}`};
      const approval=event({...ids,event_type:'approval_required',timestamp:timestamp(20)});
      const completion=event({...ids,event_type:'task_completed',timestamp:timestamp(30)});
      for(const e of reverse?[completion,approval]:[approval,completion]) await post(e);
      expect((await getTask(ids.task_id))?.status).toBe('completed');
      expect((await db.prepare("SELECT count(*) n FROM attention WHERE task_id=? AND kind='approval' AND state='open'").bind(ids.task_id).first<{n:number}>())?.n).toBe(1);
    }
  });
  it('host-only heartbeat does not create a fake agent session',async()=>{
    expect((await post(event({event_type:'heartbeat',session_id:'host:host-a',task_id:undefined,run_id:undefined}))).status).toBe(201);
    expect(await db.prepare('SELECT id FROM sessions WHERE id=?').bind('host:host-a').first()).toBeNull();
  });
  it('provides cursor pagination without duplicate timeline events',async()=>{
    const first=await (await request('/api/tasks/task-a/events?limit=2')).json() as {events:{event_id:string}[];next_cursor:string};
    expect(first.events).toHaveLength(2);expect(first.next_cursor).toBeTruthy();
    const second=await (await request(`/api/tasks/task-a/events?limit=2&cursor=${first.next_cursor}`)).json() as {events:{event_id:string}[]};
    expect(second.events.every(e=>!first.events.some(f=>f.event_id===e.event_id))).toBe(true);
    expect((await request('/api/tasks/task-a/events?cursor=garbage')).status).toBe(400);
  });
});
describe('local development and configured host credentials',()=>{
  it('allows only explicit loopback development bypass',async()=>{
    expect((await app.request('https://console.example/',{},env)).status).toBe(503);
    expect((await app.request('http://public.example/',{},env)).status).toBe(503);
    expect(isLoopbackRequest(new Request('http://localhost/',{headers:{'CF-Connecting-IP':'1.2.3.4'}}),'true')).toBe(false);
    expect(isLoopbackRequest(new Request('http://localhost/',{headers:{Host:'public.example'}}),'true')).toBe(false);
    expect(isLoopbackRequest(new Request('http://localhost/',{headers:{'X-Forwarded-For':'127.0.0.1,1.2.3.4'}}),'true')).toBe(false);
    expect(isLoopbackRequest(new Request('http://localhost/',{headers:{Forwarded:'for=127.0.0.1'}}),'true')).toBe(false);
    const response=await request('/');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('blocks cross-origin mutations and preserves manual task names',async()=>{
    const identity=await (await request('/api/me')).json() as {csrf_token:string};
    expect((await request('/api/tasks/task-a',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://evil.example','X-CSRF-Token':identity.csrf_token},body:'{"archived":true}'})).status).toBe(403);
    expect((await request('/api/tasks/task-a',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'http://localhost'},body:'{"archived":true}'})).status).toBe(403);
    expect((await request('/api/tasks/task-a',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'http://localhost','X-CSRF-Token':identity.csrf_token},body:'{"name":"My task"}'})).status).toBe(200);
    await post(event({timestamp:timestamp(60),payload:{name:'Native title'}}));
    expect((await getTask())?.name).toBe('My task');
  });
  it('never issues credentials or returns configured token hashes',async()=>{
    expect((await request('/api/admin/hosts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host_id:'host-new',name:'New machine'})})).status).toBe(404);
    expect((await request('/api/admin/hosts/host-a/credential',{method:'DELETE'})).status).toBe(404);
    expect(await (await request('/api/hosts')).text()).not.toContain('token_hash');
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_credentials'").first()).toBeNull();
  });
  it('autocreates hosts only after valid configured credentials, and removal/rotation immediately blocks retries',async()=>{
    const token='amc_'+'d'.repeat(64);const replacement='amc_'+'e'.repeat(64);
    const original=env.AGENT_TOKENS_JSON;
    const e=event({host_id:'configured-host',session_id:'host:configured-host',event_type:'heartbeat',task_id:undefined,run_id:undefined});
    try {
      expect((await post(e,token)).status).toBe(401);
      expect(await db.prepare('SELECT id FROM hosts WHERE id=?').bind(e.host_id).first()).toBeNull();
      env.AGENT_TOKENS_JSON=JSON.stringify([{host_id:e.host_id,name:'Configured host',token_hash:await sha256(token)}]);
      expect((await post(e,token)).status).toBe(201);
      expect((await post(e,token)).status).toBe(200);
      expect(await db.prepare('SELECT name FROM hosts WHERE id=?').bind(e.host_id).first()).toMatchObject({name:'Configured host'});
      env.AGENT_TOKENS_JSON='[]';
      expect((await post(e,token)).status).toBe(401);
      env.AGENT_TOKENS_JSON=JSON.stringify([{host_id:e.host_id,name:'Renamed host',token_hash:await sha256(replacement)}]);
      expect((await post(e,token)).status).toBe(401);
      expect((await post(e,replacement)).status).toBe(200);
      expect(await db.prepare('SELECT name FROM hosts WHERE id=?').bind(e.host_id).first()).toMatchObject({name:'Renamed host'});
    } finally {env.AGENT_TOKENS_JSON=original;}
  });
});
describe('inference and event throttling',()=>{
  it('marks stale sessions and offline hosts as inferred, without task outcomes',async()=>{
    const now=new Date('2026-10-12T01:00:00.000Z');
    await db.prepare('UPDATE hosts SET last_heartbeat_at=? WHERE id=?').bind(now.toISOString(),'host-a').run();
    await db.prepare('UPDATE hosts SET last_heartbeat_at=? WHERE id=?').bind(timestamp(),'host-b').run();
    await db.prepare('UPDATE sessions SET last_received_at=? WHERE id=?').bind(timestamp(),'retry-session').run();
    await inferAttention(env,now);
    const stale=await db.prepare("SELECT * FROM attention WHERE kind='stale' AND session_id='retry-session' AND resolved_at IS NULL").first();
    expect(stale?.inferred).toBe(1);
    const offline=await db.prepare("SELECT * FROM attention WHERE kind='offline' AND host_id='host-b' AND resolved_at IS NULL").first();
    expect(offline?.inferred).toBe(1);
    expect((await getTask('retry-task'))?.status).toBe('completed');
  });
  it('atomically limits authenticated hosts and makes retries idempotent',async()=>{
    // A fresh host isolates the quota from previous test events.
    await db.prepare('INSERT INTO hosts(id,name,created_at) VALUES (?,?,?)').bind('rate-host','Rate host',timestamp()).run();
    const token='amc_'+'c'.repeat(64);
    const rateEnv={...env,AGENT_TOKENS_JSON:JSON.stringify([{host_id:'rate-host',name:'Rate host',token_hash:await sha256(token)}])};
    const received=new Date('2026-10-12T02:00:00.000Z');
    const events=Array.from({length:240},(_,i)=>event({event_id:`rate-${i}`,host_id:'rate-host',session_id:'host:rate-host',task_id:undefined,run_id:undefined,event_type:'heartbeat',timestamp:timestamp()}));
    for(const e of events) await ingest(rateEnv,e,token,received);
    expect(await ingest(rateEnv,events[0],token,received)).toBe(false);
    await expect(ingest(rateEnv,validateEvent({...events[0],event_id:'rate-over'}),token,received)).rejects.toMatchObject({status:429} satisfies Partial<IngestError>);
    expect(await ingest(rateEnv,validateEvent({...events[0],event_id:'rate-later'}),token,new Date(received.getTime()+61_000))).toBe(true);
  });
});

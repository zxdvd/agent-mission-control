import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRefresh, watchVisibleRefresh, type SnapshotFreshness } from './refresh.ts';

function deferred<T>() {
 let resolve!:(value:T)=>void, reject!:(error:Error)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});
 return {promise,resolve,reject};
}
function fixture() {
 const requests:{signal:AbortSignal;result:ReturnType<typeof deferred<string>>}[]=[];
 const applied:string[]=[],loading:boolean[]=[],errors:string[]=[],freshness:SnapshotFreshness[]=[];
 let blocked=false,clock=1000,nextTimer=0;
 const timers=new Map<number,{callback:()=>void;due:number}>();
 const reader=snapshotRefresh({load:(signal:AbortSignal)=>{const result=deferred<string>();requests.push({signal,result});return result.promise},apply:(value:string)=>applied.push(value),loading:(value:boolean)=>loading.push(value),error:(value:string)=>errors.push(value),canRefresh:()=>!blocked,freshness:(value:SnapshotFreshness)=>freshness.push(value),now:()=>clock,schedule:(callback:()=>void,delay:number)=>{const id=++nextTimer;timers.set(id,{callback,due:clock+delay});return()=>{timers.delete(id)}}});
 return {reader,requests,applied,loading,errors,freshness,block:(value:boolean)=>{blocked=value},advance:(ms:number)=>{clock+=ms;for(const [id,timer] of timers){if(timer.due<=clock){timers.delete(id);timer.callback()}}},timerCount:()=>timers.size};
}

test('initial/manual reads report loading and errors; subsequent polling can recover',async()=>{
 const f=fixture();const first=f.reader.refresh();
 f.requests[0].result.reject(new Error('offline'));await first;
 assert.deepEqual(f.loading,[true,false]);assert.deepEqual(f.errors,['','offline']);
 const retry=f.reader.refresh(true);f.requests[1].result.resolve('receipt');await retry;
 assert.deepEqual(f.applied,['receipt']);assert.deepEqual(f.errors,['','offline','']);
});

test('background receipt/evidence refresh stays quiet and coalesces overlapping requests',async()=>{
 const f=fixture();const poll=f.reader.refresh(true);await f.reader.refresh(true);
 assert.equal(f.requests.length,1);assert.deepEqual(f.loading,[]);assert.deepEqual(f.errors,[]);
 f.requests[0].result.resolve('receipt');await poll;
 const evidence=f.reader.refresh(true);f.requests[1].result.resolve('evidence');await evidence;
 assert.deepEqual(f.applied,['receipt','evidence']);assert.deepEqual(f.loading,[]);
 const failed=f.reader.refresh(true);f.requests[2].result.reject(new Error('offline'));await failed;
 assert.deepEqual(f.applied,['receipt','evidence']);assert.deepEqual(f.errors,['','']);
});

test('three real failures expose last successful read, retain good data, and recovery clears stale',async()=>{
 const f=fixture();const good=f.reader.refresh();f.requests[0].result.resolve('last good snapshot');await good;
 assert.deepEqual(f.freshness.at(-1),{lastSuccessAt:1000,stale:false});
 for(let i=1;i<=3;i++){
  f.advance(3000);const failed=f.reader.refresh(true);f.requests[i].result.reject(new Error('offline'));await failed;
  assert.deepEqual(f.applied,['last good snapshot']);
  assert.equal(f.freshness.at(-1)!.stale,i===3);
  assert.equal(f.freshness.at(-1)!.lastSuccessAt,1000);
  assert.equal(f.errors.length,i===3?3:2); // start/initial success, then sustained failure only
 }
 assert.equal(f.errors.at(-1),'offline');
 const recovery=f.reader.refresh();
 // Starting a refresh is not recovery and must not hide the stale warning.
 assert.equal(f.errors.at(-1),'offline');assert.equal(f.freshness.at(-1)!.stale,true);
 f.requests[4].result.resolve('recovered snapshot');await recovery;
 assert.deepEqual(f.applied,['last good snapshot','recovered snapshot']);
 assert.deepEqual(f.freshness.at(-1),{lastSuccessAt:10000,stale:false});assert.equal(f.errors.at(-1),'');
});

test('manual refresh replaces a hung background read; cancelled response cannot overwrite its replacement',async()=>{
 const f=fixture();const background=f.reader.refresh(true);
 await f.reader.refresh(true);assert.equal(f.requests.length,1);
 const manual=f.reader.refresh();
 assert.equal(f.requests.length,2);assert.equal(f.requests[0].signal.aborted,true);
 await background; // The transport need not settle before the cancelled call returns.
 f.requests[1].result.resolve('manual current snapshot');await manual;
 f.requests[0].result.resolve('late background snapshot');await Promise.resolve();
 assert.deepEqual(f.applied,['manual current snapshot']);
 assert.deepEqual(f.loading,[true,false]);assert.equal(f.freshness.at(-1)!.stale,false);
});

test('GET timeout frees the read slot even if abort is ignored, and late result is inert',async()=>{
 const f=fixture();const hung=f.reader.refresh();
 f.advance(9999);assert.equal(f.requests[0].signal.aborted,false);
 f.advance(1);await hung;
 assert.equal(f.requests[0].signal.aborted,true);assert.deepEqual(f.loading,[true,false]);
 assert.match(f.errors.at(-1)!,/读取超时/);assert.equal(f.timerCount(),0);
 const next=f.reader.refresh(true);assert.equal(f.requests.length,2);
 f.requests[1].result.resolve('new good snapshot');await next;
 f.requests[0].result.resolve('late timed-out result');await Promise.resolve();
 assert.deepEqual(f.applied,['new good snapshot']);assert.equal(f.errors.at(-1),'');
});

test('a failed Promise.all snapshot aborts its hanging sibling and cannot overwrite a later read',async()=>{
 const requests:{signal:AbortSignal;first:ReturnType<typeof deferred<string>>;sibling:ReturnType<typeof deferred<string>>}[]=[];
 const applied:string[][]=[];
 let cleared=0;
 const reader=snapshotRefresh({
  load:(signal:AbortSignal)=>{const first=deferred<string>(),sibling=deferred<string>();requests.push({signal,first,sibling});return Promise.all([first.promise,sibling.promise])},
  apply:(value:string[])=>applied.push(value),loading:()=>{},error:()=>{},canRefresh:()=>true,
  schedule:()=>()=>{cleared++},
 });
 const failed=reader.refresh(true);
 requests[0].first.reject(new Error('projects GET failed while tasks GET hangs'));await failed;
 assert.equal(requests[0].signal.aborted,true);
 assert.equal(cleared,1);
 const next=reader.refresh(true);
 requests[1].first.resolve('current projects');requests[1].sibling.resolve('current tasks');await next;
 // Even an abort-ignoring old sibling must be inert after the failed read.
 requests[0].sibling.resolve('old tasks');await Promise.resolve();
 assert.deepEqual(applied,[['current projects','current tasks']]);
 reader.dispose();
});

test('a stale pre-mutation snapshot cannot overwrite a saved decision/create result or a newer read',async()=>{
 const f=fixture();const stale=f.reader.refresh();
 f.block(true);f.reader.invalidate();assert.equal(f.requests[0].signal.aborted,true);
 await f.reader.refresh(true);assert.equal(f.requests.length,1);
 f.applied.push('saved decision');f.block(false);
 const current=f.reader.refresh(true);f.requests[1].result.resolve('receipt');await current;
 // Simulate a transport that returns despite abort, after a newer result was applied.
 f.requests[0].result.resolve('old unanswered snapshot');await stale;
 assert.deepEqual(f.applied,['saved decision','receipt']);assert.deepEqual(f.loading,[true,false]);
});

test('stale errors and disposal cannot change the current UI',async()=>{
 const f=fixture();const stale=f.reader.refresh();f.reader.invalidate();
 f.requests[0].result.reject(new Error('stale error'));await stale;assert.deepEqual(f.errors,['']);assert.deepEqual(f.freshness,[]);
 const pending=f.reader.refresh(true);f.reader.dispose();assert.equal(f.requests[1].signal.aborted,true);
 f.requests[1].result.resolve('late result');await pending;await f.reader.refresh();
 assert.deepEqual(f.applied,[]);assert.equal(f.requests.length,2);f.advance(20000);assert.equal(f.timerCount(),0);assert.deepEqual(f.freshness,[]);
});

test('polls only visible tabs, refreshes on return/focus, and removes timer/listeners',()=>{
 const page=new EventTarget() as EventTarget & {visibilityState:string};page.visibilityState='visible';
 const host=new EventTarget() as EventTarget & {setInterval:Window['setInterval'];clearInterval:Window['clearInterval']};
 let interval:(()=>void)|undefined,delay:number|undefined,cleared:number|undefined,calls=0;
 host.setInterval=((fn:()=>void,ms:number)=>{interval=fn;delay=ms;return 42}) as Window['setInterval'];
 host.clearInterval=id=>{cleared=id};
 const stop=watchVisibleRefresh(()=>{calls++},page as Document,host as unknown as Window);
 assert.equal(delay,3000);interval!();assert.equal(calls,1);
 page.visibilityState='hidden';interval!();host.dispatchEvent(new Event('focus'));page.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);
 page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));host.dispatchEvent(new Event('focus'));assert.equal(calls,3);
 stop();assert.equal(cleared,42);host.dispatchEvent(new Event('focus'));page.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,3);
});

export type SnapshotFreshness={lastSuccessAt:number|null;stale:boolean};

// Replace snapshots in place, never letting a pre-mutation read undo a saved result.
export function snapshotRefresh<T>(options:{
 load:(signal:AbortSignal)=>Promise<T>;
 apply:(value:T)=>void;
 loading:(value:boolean)=>void;
 error:(message:string)=>void;
 canRefresh:()=>boolean;
 freshness?:(value:SnapshotFreshness)=>void;
 now?:()=>number;
 timeoutMs?:number;
 schedule?:(callback:()=>void,delay:number)=>(()=>void);
}) {
 type Read={controller:AbortController;background:boolean;cancel:()=>void;clearTimer:()=>void};
 let current:Read|null=null,disposed=false,lastSuccessAt:number|null=null,failures=0;
 const cancelled=Symbol('cancelled snapshot');
 const schedule=options.schedule||((callback,delay)=>{const timer=setTimeout(callback,delay);return()=>clearTimeout(timer)});
 const cancelCurrent=()=>{const read=current;current=null;if(read){read.clearTimer();read.cancel();read.controller.abort()}};
 const invalidate=()=>{cancelCurrent();options.loading(false)};
 return {
  async refresh(background=false) {
   if(disposed||!options.canRefresh())return;
   // Polls coalesce. An explicit refresh can replace an unfinished background GET.
   if(current){if(background||!current.background)return;cancelCurrent()}
   const controller=new AbortController();
   let interrupt!:(reason:unknown)=>void;
   const interrupted=new Promise<never>((_,reject)=>{interrupt=reject});
   const read:Read={controller,background,cancel:()=>interrupt(cancelled),clearTimer:()=>{}};
   current=read;
   read.clearTimer=schedule(()=>{interrupt(new Error('读取超时，请刷新重试'));controller.abort()},options.timeoutMs??10000);
   if(!background){options.loading(true);if(lastSuccessAt===null)options.error('')}
   try {
    // The race bounds the slot even when a transport ignores AbortSignal.
    const value=await Promise.race([options.load(controller.signal),interrupted]);
    if(disposed||current!==read)return;
    options.apply(value);lastSuccessAt=(options.now||Date.now)();failures=0;
    options.error('');options.freshness?.({lastSuccessAt,stale:false});
   } catch(error) {
    if(disposed||current!==read||error===cancelled)return;
    // Promise.all can fail before its sibling GET settles; stop the shared read.
    controller.abort();
    failures++;
    const stale=lastSuccessAt!==null&&failures>=3;
    // A single short outage keeps the last good snapshot quiet. Initial/manual
    // failures without any good data still explain why the list cannot load.
    if(stale||lastSuccessAt===null&&(!background||failures>=3))options.error(error instanceof Error?error.message:'读取失败');
    options.freshness?.({lastSuccessAt,stale});
   } finally {
    read.clearTimer();
    if(!disposed&&current===read){current=null;if(!background)options.loading(false)}
   }
  },
  invalidate,
  dispose(){disposed=true;cancelCurrent()},
 };
}

// Only local work records poll. Herdr observations retain their separate manual refresh.
export function watchVisibleRefresh(refresh:()=>void, page:Pick<Document,'visibilityState'|'addEventListener'|'removeEventListener'>=document, host:Pick<Window,'addEventListener'|'removeEventListener'|'setInterval'|'clearInterval'>=window) {
 const tick=()=>{if(page.visibilityState==='visible')refresh()};
 const timer=host.setInterval(tick,3000);
 host.addEventListener('focus',tick);page.addEventListener('visibilitychange',tick);
 return()=>{host.clearInterval(timer);host.removeEventListener('focus',tick);page.removeEventListener('visibilitychange',tick)};
}

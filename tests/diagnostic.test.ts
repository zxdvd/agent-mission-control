import {it,expect,vi} from 'vitest';
// @ts-expect-error Node-only ESM diagnostic utility.
import {diagnose} from '../scripts/diagnose-cloudflare.mjs';
const accountId='a'.repeat(32),token='synthetic-diagnostic-token-only';
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
it('uses exactly seven GETs on the fixed API origin and emits only allowlisted status fields',async()=>{
 const emit=vi.fn();const mock=vi.fn(async()=>response({success:true,result:{default_environment:{environment:'production'},bindings:[{value:'SENSITIVE-PAYLOAD'}]}}));
 expect(await diagnose({accountId,token,fetchImpl:mock,emit})).toEqual({ok:true,checked:7});
 const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`,env=`${base}/services/agent-mission-control/environments/production`;
 expect((mock.mock.calls as unknown as [URL][]).map(([url])=>url.href)).toEqual([`${base}/services/agent-mission-control`,`${env}/bindings`,`${env}/routes?show_zonename=true`,`${base}/domains/records?page=0&per_page=5&service=agent-mission-control&environment=production`,`${env}/subdomain`,env,`${base}/scripts/agent-mission-control/schedules`]);
 for(const [url,init] of mock.mock.calls as unknown as [URL,RequestInit][]){expect(url.origin).toBe('https://api.cloudflare.com');expect(url.pathname).toContain('/workers/');expect(init.method).toBe('GET');expect(init.redirect).toBe('manual');expect(init.signal).toBeTruthy();}
 for(const [record] of emit.mock.calls)expect(Object.keys(record).sort()).toEqual(['endpoint','error_codes','http_status','success']);
 expect(JSON.stringify(emit.mock.calls)).not.toContain('SENSITIVE-PAYLOAD');expect(JSON.stringify(emit.mock.calls)).not.toContain(token);expect(JSON.stringify(emit.mock.calls)).not.toContain(accountId);
});
it('retains numeric API errors but discards messages and keeps probing remaining endpoints',async()=>{
 const emit=vi.fn();let i=0;const mock=vi.fn(async()=>++i===1?response({success:true,result:{default_environment:{environment:'production'}}}):response({success:false,errors:[{code:10000,message:token},{code:token},{code:Infinity}],result:{value:token}},403));
 expect(await diagnose({accountId,token,fetchImpl:mock,emit})).toEqual({ok:false,checked:7});
 expect(emit.mock.calls[1][0]).toMatchObject({http_status:403,error_codes:[10000]});expect(JSON.stringify(emit.mock.calls)).not.toContain(token);
});
it('never follows redirects and never echoes transport error details',async()=>{
 const emit=vi.fn();const mock=vi.fn(async()=>new Response(null,{status:302,headers:{Location:'https://untrusted.invalid/'+token}}));
 expect(await diagnose({accountId,token,fetchImpl:mock,emit})).toEqual({ok:false,checked:1});expect(mock).toHaveBeenCalledOnce();expect(JSON.stringify(emit.mock.calls)).not.toContain(token);
 await diagnose({accountId,token,fetchImpl:async()=>{throw new Error(token);},emit});expect(JSON.stringify(emit.mock.calls)).not.toContain(token);
});
it('rejects invalid configuration and untrusted environment path data',async()=>{
 const mock=vi.fn();await expect(diagnose({accountId:'invalid',token,fetchImpl:mock})).rejects.toThrow();await expect(diagnose({accountId,token:'bad\r\nvalue',fetchImpl:mock})).rejects.toThrow();expect(mock).not.toHaveBeenCalled();
 const emit=vi.fn();const malicious=vi.fn(async()=>response({success:true,result:{default_environment:{environment:'../../secrets'}}}));
 expect(await diagnose({accountId,token,fetchImpl:malicious,emit})).toEqual({ok:false,checked:1});expect(malicious).toHaveBeenCalledOnce();
});
it('handles malformed and oversized responses without printing their contents',async()=>{
 const emit=vi.fn();await diagnose({accountId,token,fetchImpl:async()=>new Response(token),emit});await diagnose({accountId,token,fetchImpl:async()=>new Response('x'.repeat(1048577)),emit});expect(JSON.stringify(emit.mock.calls)).not.toContain(token);expect(emit.mock.calls.every(([r])=>r.success===false)).toBe(true);
});

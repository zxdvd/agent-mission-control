import {pathToFileURL} from 'node:url';

// Read-only, fixed-origin metadata diagnosis. Never emit URLs, response bodies,
// binding values, environment names, account IDs, or credentials.
const worker='agent-mission-control';
const origin='https://api.cloudflare.com';
const labels=['bindings','routes','custom_domains','subdomain','environment','schedules'];
async function readJson(response){
 if(!response.body)return null;
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();return null;}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
}
export async function diagnose({accountId,token,fetchImpl=fetch,emit=record=>console.log(JSON.stringify(record))}){
 if(!/^[a-f0-9]{32}$/i.test(accountId??'')||typeof token!=='string'||!token||/[\r\n]/.test(token))throw new Error('Missing or invalid diagnostic configuration');
 const base=`/client/v4/accounts/${accountId}/workers`;
 const results=[];
 async function probe(label,path){
  let body=null;let record;
  try{
   const response=await fetchImpl(new URL(path,origin),{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(10000)});
   body=await readJson(response);
   record={endpoint:label,http_status:response.status,success:response.ok&&body?.success===true,error_codes:Array.isArray(body?.errors)?body.errors.map(e=>e?.code).filter(c=>Number.isInteger(c)&&c>=0&&c<=100000).slice(0,10):[]};
  }catch{record={endpoint:label,http_status:null,success:false,error_codes:[]};}
  results.push(record);emit(record);return {body,record};
 }
 const service=await probe('service',`${base}/services/${worker}`);
 const environment=service.body?.result?.default_environment?.environment;
 if(!service.record.success||typeof environment!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(environment))return {ok:false,checked:results.length};
 const envBase=`${base}/services/${worker}/environments/${environment}`;
 const paths=[`${envBase}/bindings`,`${envBase}/routes?show_zonename=true`,`${base}/domains/records?page=0&per_page=5&service=${worker}&environment=${environment}`,`${envBase}/subdomain`,envBase,`${base}/scripts/${worker}/schedules`];
 for(let i=0;i<paths.length;i++)await probe(labels[i],paths[i]);
 return {ok:results.every(record=>record.success),checked:results.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==2)throw new Error('No arguments accepted');
  const summary=await diagnose({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
  console.log(JSON.stringify({diagnostic_complete:true,...summary}));if(!summary.ok)process.exitCode=1;
 }catch{console.error('Read-only diagnosis could not start: check required environment configuration');process.exitCode=1;}
}

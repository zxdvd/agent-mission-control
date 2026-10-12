import { Hono } from 'hono';
import { authenticate, AuthConfigError, AuthError, clearSessionCookie, createSession, isLoopbackRequest, limitLogin, loginHtml, LoginRateLimitError, requireAuthConfig, revokeSession, sameOriginMutation, validCsrf, verifyCredentials } from './auth';
import { ATTENTION_SELECT, TASK_SELECT, getHosts, inferAttention, ingest, IngestError, normalizeAttention, normalizeTask } from './db';
import { ProtocolError, safeText, validateEvent, validateId } from './protocol';
import type { AppEnv, Env } from './types';

export const app = new Hono<AppEnv>();
const MAX_BODY = 16_384;
async function jsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new ProtocolError('Content-Type must be application/json');
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_BODY) throw new ProtocolError('Request body too large');
  if (!request.body) throw new ProtocolError('Missing JSON body');
  const reader = request.body.getReader();
  let size=0; const chunks: Uint8Array[]=[];
  try {
    while (true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>MAX_BODY) { await reader.cancel(); throw new ProtocolError('Request body too large'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw new ProtocolError('Invalid JSON'); }
}
function securityHeaders(response: Response, url: string): void {
  response.headers.set('Cache-Control','no-store');
  response.headers.set('X-Content-Type-Options','nosniff');
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (new URL(url).protocol === 'https:') response.headers.set('Strict-Transport-Security','max-age=31536000');
}
// Apply these after every route, including redirects, errors, and ASSETS.
// Asset binding headers must never weaken the authenticated response policy.
app.use('*',async(c,next)=>{
  await next();
  securityHeaders(c.res,c.req.url);
});
app.use('*', async (c,next) => {
  if (c.req.path === '/login' && c.req.method === 'GET') return next();
  if (c.req.path === '/api/auth/login' && c.req.method === 'POST') return next();
  const local = isLoopbackRequest(c.req.raw,c.env.LOCAL_DEV);
  // Production ingestion is also closed until all authentication settings exist.
  if (!local) {
    requireAuthConfig(c.env);
    if (new URL(c.req.url).protocol !== 'https:') return c.json({error:'HTTPS required'},403);
  }
  if (c.req.path === '/api/events' && c.req.method === 'POST') return next();
  try { c.set('identity',await authenticate(c.req.raw,c.env)); }
  catch (error) {
    if (!(error instanceof AuthError)) throw error;
    if (c.req.method === 'GET' && !c.req.path.startsWith('/api/')) return c.redirect('/login',302);
    return c.json({error:'Authentication required'},401);
  }
  if (!['GET','HEAD','OPTIONS'].includes(c.req.method)) {
    // CLI-only convenience stays confined to the explicit loopback dev bypass.
    const localCli = local && !c.req.header('Origin') && !c.req.header('Sec-Fetch-Site');
    if (!localCli && !validCsrf(c.req.raw,c.get('identity'))) return c.json({error:'Same-origin CSRF token required'},403);
  }
  await next();
});
app.get('/login', c => {
  if (isLoopbackRequest(c.req.raw,c.env.LOCAL_DEV)) return c.redirect('/',302);
  if (new URL(c.req.url).protocol !== 'https:') return c.text('HTTPS required',403);
  return c.html(loginHtml());
});
app.post('/api/auth/login', async c => {
  requireAuthConfig(c.env);
  if (new URL(c.req.url).protocol !== 'https:') return c.json({error:'HTTPS required'},403);
  if (!sameOriginMutation(c.req.raw)) return c.json({error:'Same-origin login required'},403);
  await limitLogin(c.req.raw,c.env);
  const type = c.req.header('Content-Type') ?? '';
  const form = /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(type);
  let body: unknown;
  if (form) {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new ProtocolError('Missing login form');
    let bytes = new Uint8Array(0);
    try {
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        if (bytes.length + value.length > 4096) {await reader.cancel();throw new ProtocolError('Login request too large');}
        const combined = new Uint8Array(bytes.length + value.length); combined.set(bytes); combined.set(value,bytes.length); bytes = combined;
      }
    } finally { reader.releaseLock(); }
    const fields = new URLSearchParams(new TextDecoder().decode(bytes));
    if ([...fields.keys()].length !== 2 || !fields.has('username') || !fields.has('password')) throw new ProtocolError('Expected username and password');
    body = {username:fields.get('username'),password:fields.get('password')};
  } else body = await jsonBody(c.req.raw);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof (body as Record<string,unknown>).username !== 'string' || typeof (body as Record<string,unknown>).password !== 'string') throw new ProtocolError('Expected username and password');
  const {username,password} = body as {username:string;password:string};
  const valid = await verifyCredentials(username,password,c.env);
  if (!valid) return form ? c.html(loginHtml('Invalid credentials.'),401) : c.json({error:'Invalid credentials'},401);
  c.header('Set-Cookie',await createSession(c.env));
  return form ? c.redirect('/',302) : c.json({ok:true});
});
app.post('/api/auth/logout',async c => {
  await revokeSession(c.get('identity'),c.env);
  c.header('Set-Cookie',clearSessionCookie());
  return c.json({ok:true});
});
app.post('/api/events',async c => {
  const authorization = c.req.header('Authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_.-]{32,256}$/.test(authorization)) return c.json({error:'Host bearer credential required'},401);
  const event = validateEvent(await jsonBody(c.req.raw));
  const accepted = await ingest(c.env,event,authorization.slice(7));
  return c.json({accepted,duplicate:!accepted,event_id:event.event_id},accepted ? 201 : 200);
});
app.get('/api/me', c => {
  const {role,email,local,csrf_token}=c.get('identity');
  return c.json({role,...(email ? {email} : {}),local,csrf_token});
});
app.get('/api/hosts',async c => c.json({hosts:await getHosts(c.env)}));
app.get('/api/tasks',async c => {
  const tasks = await c.env.DB.prepare(`${TASK_SELECT} ${c.req.query('archived')==='all'?'':'WHERE t.archived=0'} ORDER BY t.last_activity_at DESC LIMIT 500`).all();
  return c.json({tasks:tasks.results.map(normalizeTask)});
});
app.get('/api/overview',async c => {
  const now = new Date();
  await inferAttention(c.env,now);
  const [tasks,hosts,attention,stats] = await Promise.all([
    c.env.DB.prepare(`${TASK_SELECT} ORDER BY t.last_activity_at DESC LIMIT 500`).all(),
    getHosts(c.env,now.getTime()),
    c.env.DB.prepare(`${ATTENTION_SELECT} WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 200`).all(),
    c.env.DB.prepare(`SELECT
      coalesce(sum(CASE WHEN status='active' AND activity='running' THEN 1 ELSE 0 END),0) AS running,
      (SELECT count(DISTINCT a.task_id) FROM attention a JOIN tasks t ON t.id=a.task_id WHERE a.kind IN ('approval','input') AND a.state!='ignored' AND a.resolved_at IS NULL AND t.status='active' AND t.archived=0) AS waiting,
      coalesce(sum(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
      coalesce(sum(CASE WHEN status='completed' AND completed_at >= ? THEN 1 ELSE 0 END),0) AS completed_today
      FROM tasks WHERE archived=0`).bind(`${now.toISOString().slice(0,10)}T00:00:00.000Z`).first<Record<string,number>>(),
  ]);
  return c.json({stats:{...stats,online_hosts:hosts.filter(h=>h.online).length,offline_hosts:hosts.filter(h=>!h.online).length},
    tasks:tasks.results.map(normalizeTask),hosts,attention:attention.results.map(normalizeAttention),server_time:now.toISOString()});
});
app.get('/api/tasks/:id/events',async c => {
  const id=c.req.param('id'); validateId(id,'task_id');
  if(!await c.env.DB.prepare('SELECT 1 FROM tasks WHERE id=?').bind(id).first()) return c.json({error:'Task not found'},404);
  let after: [string,string] | undefined;
  const cursor=c.req.query('cursor');
  if(cursor) {
    try {
      if(cursor.length>1024) throw new Error();
      const parsed=JSON.parse(atob(cursor.replace(/-/g,'+').replace(/_/g,'/')));
      if(!Array.isArray(parsed) || parsed.length!==2 || typeof parsed[0]!=='string' || !Number.isFinite(Date.parse(parsed[0]))) throw new Error();
      validateId(parsed[1],'cursor');after=parsed as [string,string];
    } catch {throw new ProtocolError('Invalid event cursor');}
  }
  const requested=Number(c.req.query('limit') ?? 100);
  if(!Number.isInteger(requested) || requested<1 || requested>200) throw new ProtocolError('limit must be between 1 and 200');
  const sql='SELECT event_id,event_id AS id,timestamp,host_id,agent_type,session_id,task_id,run_id,event_type,payload FROM events WHERE task_id=?';
  const query=after ? c.env.DB.prepare(`${sql} AND (timestamp < ? OR (timestamp = ? AND event_id < ?)) ORDER BY timestamp DESC,event_id DESC LIMIT ?`).bind(id,after[0],after[0],after[1],requested+1)
    : c.env.DB.prepare(`${sql} ORDER BY timestamp DESC,event_id DESC LIMIT ?`).bind(id,requested+1);
  const rows=(await query.all()).results;
  const events=rows.slice(0,requested).map(e=>({...e,payload:JSON.parse(e.payload as string)}));
  const last=rows.slice(0,requested).at(-1);
  const next_cursor=rows.length>requested && last ? btoa(JSON.stringify([last.timestamp,last.event_id])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') : null;
  return c.json({events,next_cursor});
});
app.get('/api/tasks/:id',async c => {
  const id=c.req.param('id'); validateId(id,'task_id');
  const task=await c.env.DB.prepare(`${TASK_SELECT} WHERE t.id=?`).bind(id).first();
  if(!task) return c.json({error:'Task not found'},404);
  const [runs,sessions,events,attention]=await Promise.all([
    c.env.DB.prepare('SELECT id,task_id,session_id,status,started_at,ended_at,summary FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 200').bind(id).all(),
    c.env.DB.prepare(`SELECT DISTINCT s.id,s.host_id,s.agent_type,s.status,s.started_at,s.last_activity_at,s.ended_at FROM sessions s WHERE s.id IN
      (SELECT session_id FROM runs WHERE task_id=? UNION SELECT session_id FROM events WHERE task_id=?) ORDER BY s.started_at DESC LIMIT 200`).bind(id,id).all(),
    c.env.DB.prepare('SELECT event_id,event_id AS id,timestamp,host_id,agent_type,session_id,task_id,run_id,event_type,payload FROM events WHERE task_id=? ORDER BY timestamp DESC,event_id DESC LIMIT 300').bind(id).all(),
    c.env.DB.prepare(`${ATTENTION_SELECT} WHERE task_id=? ORDER BY created_at DESC LIMIT 200`).bind(id).all(),
  ]);
  return c.json({task:normalizeTask(task),runs:runs.results,sessions:sessions.results,
    events:events.results.map(e=>({...e,payload:JSON.parse(e.payload as string)})),attention:attention.results.map(normalizeAttention)});
});
app.patch('/api/tasks/:id',async c => {
  const id=c.req.param('id');validateId(id,'task_id');
  const body=await jsonBody(c.req.raw) as Record<string,unknown>;
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!['name','archived'].includes(k)) || !Object.keys(body).length) throw new ProtocolError('Expected name or archived');
  const name=body.name===undefined ? null : safeText(body.name,'name');
  if(name!==null && !name.trim()) throw new ProtocolError('Name must not be empty');
  if(body.archived!==undefined && typeof body.archived!=='boolean') throw new ProtocolError('archived must be boolean');
  const result=await c.env.DB.prepare(`UPDATE tasks SET name=coalesce(?,name),name_overridden=CASE WHEN ? IS NULL THEN name_overridden ELSE 1 END,
    archived=coalesce(?,archived) WHERE id=?`).bind(name,name,body.archived===undefined?null:Number(body.archived),id).run();
  if(!result.meta.changes) return c.json({error:'Task not found'},404);
  const task=await c.env.DB.prepare(`${TASK_SELECT} WHERE t.id=?`).bind(id).first();
  return c.json({task:normalizeTask(task!)});
});
app.patch('/api/attention/:id',async c => {
  const body=await jsonBody(c.req.raw) as Record<string,unknown>;
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || !['read','ignored','open'].includes(body.state as string)) throw new ProtocolError('Invalid attention state');
  const result=await c.env.DB.prepare('UPDATE attention SET state=? WHERE id=?').bind(body.state,c.req.param('id')).run();
  if(!result.meta.changes) return c.json({error:'Attention item not found'},404);
  const attention=await c.env.DB.prepare(`${ATTENTION_SELECT} WHERE id=?`).bind(c.req.param('id')).first();
  return c.json({attention:normalizeAttention(attention!)});
});
app.all('/api/*',c=>c.json({error:'Not found'},404));
app.get('*',async c => {
  if(!c.env.ASSETS) return c.text('Frontend assets have not been built.',503);
  const response=await c.env.ASSETS.fetch(c.req.raw);
  return c.newResponse(response.body,response);
});
app.onError((error,c) => {
  if(error instanceof AuthConfigError) return c.json({error:'Authentication is not configured. Contact the operator.'},503);
  if(error instanceof LoginRateLimitError) {c.header('Retry-After',String(error.retryAfter));return c.json({error:error.message},429);}
  if(error instanceof ProtocolError) return c.json({error:error.message},400);
  if(error instanceof IngestError) {if(error.status===429)c.header('Retry-After','60');return c.json({error:error.message},error.status);}
  // Never log request bodies, credentials, payloads, or database exceptions.
  console.error('Request failed', {category:error.name});
  return c.json({error:'Internal server error'},500);
});
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {ctx.waitUntil(inferAttention(env));},
};

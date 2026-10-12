import type { AgentEvent, Env } from './types';
import { configuredHosts } from './auth';
import { canonicalEvent, eventClock, sha256 } from './protocol';
export class IngestError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 409 | 429) { super(message); }
}
export function threshold(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 30 && n <= 86_400 ? n : fallback;
}
export async function ingest(env: Env, event: AgentEvent, token: string, now = new Date()): Promise<boolean> {
  const db = env.DB;
  const hash = await sha256(token);
  // Re-read the current Worker Secret on every request, including retries.
  // No database row can retain access after a token is removed or rotated.
  const credential = configuredHosts(env).find(host => host.token_hash === hash);
  if (!credential) throw new IngestError('Invalid host credential', 401);
  if (credential.host_id !== event.host_id) throw new IngestError('Credential does not belong to this host', 403);
  const fingerprint = await sha256(canonicalEvent(event));
  let inserted: D1Result;
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO hosts (id,name,created_at) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name`).bind(credential.host_id,credential.name,now.toISOString()),
      db.prepare(`INSERT INTO events
        (event_id,timestamp,received_at,host_id,agent_type,session_id,task_id,run_id,event_type,payload,fingerprint,clock)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`).bind(event.event_id,event.timestamp,now.toISOString(),event.host_id,
          event.agent_type,event.session_id,event.task_id ?? null,event.run_id ?? null,event.event_type,
          JSON.stringify(event.payload),fingerprint,eventClock(event)),
    ]);
    inserted = results[1];
  } catch (error) {
    if (error instanceof Error && error.message.includes('rate_limit')) throw new IngestError('Host event rate limit exceeded; retry after 60 seconds', 429);
    if (error instanceof Error && error.message.includes('identity_conflict')) throw new IngestError('An identifier is already bound to another host, agent, task, or session', 409);
    throw error;
  }
  if (inserted.meta.changes > 0) return true;
  const existing = await db.prepare('SELECT host_id,fingerprint FROM events WHERE event_id = ?').bind(event.event_id).first<{host_id: string; fingerprint: string}>();
  if (!existing || existing.host_id !== event.host_id || existing.fingerprint !== fingerprint) throw new IngestError('event_id was already used for different data', 409);
  return false;
}
export const TASK_SELECT = `SELECT t.id,t.name,t.host_id,t.agent_type,t.project,t.repo,t.branch,t.summary,t.status,t.activity,
  t.created_at,t.last_activity_at,t.completed_at,t.archived,t.current_run_id,
  CASE WHEN EXISTS(SELECT 1 FROM attention a WHERE a.task_id=t.id AND a.kind='error' AND a.state!='ignored' AND a.resolved_at IS NULL) THEN 'error'
    WHEN EXISTS(SELECT 1 FROM attention a WHERE a.task_id=t.id AND a.kind='approval' AND a.state!='ignored' AND a.resolved_at IS NULL) THEN 'approval'
    WHEN EXISTS(SELECT 1 FROM attention a WHERE a.task_id=t.id AND a.kind='input' AND a.state!='ignored' AND a.resolved_at IS NULL) THEN 'input' ELSE 'none' END AS attention
  FROM tasks t`;
export const ATTENTION_SELECT = 'SELECT id,host_id,task_id,session_id,kind,message,inferred,state,created_at,resolved_at FROM attention';
export function normalizeTask(t: Record<string,unknown>): Record<string,unknown> { return { ...t, archived: Boolean(t.archived) }; }
export function normalizeAttention(a: Record<string,unknown>): Record<string,unknown> { return { ...a, inferred: Boolean(a.inferred) }; }
export async function getHosts(env: Env, now = Date.now()): Promise<Record<string,unknown>[]> {
  const cutoff = new Date(now - threshold(env.OFFLINE_SECONDS,120)*1000).toISOString();
  const result = await env.DB.prepare(`SELECT h.id,h.name,h.last_heartbeat_at,
    CASE WHEN h.last_heartbeat_at >= ? THEN 1 ELSE 0 END AS online,
    (SELECT count(*) FROM tasks t WHERE t.host_id=h.id AND t.archived=0) AS task_count,
    (SELECT count(*) FROM sessions s WHERE s.host_id=h.id AND s.status='active') AS session_count
    FROM hosts h ORDER BY h.name,h.id LIMIT 500`).bind(cutoff).all();
  return result.results.map(h => ({...h,online:Boolean(h.online)}));
}
export async function inferAttention(env: Env, now = new Date()): Promise<void> {
  const time = now.toISOString();
  const offline = new Date(now.getTime()-threshold(env.OFFLINE_SECONDS,120)*1000).toISOString();
  const stale = new Date(now.getTime()-threshold(env.STALE_SECONDS,300)*1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO attention (id,host_id,kind,message,inferred,state,created_at)
      SELECT 'offline:' || id || ':' || coalesce(last_heartbeat_at,created_at),id,'offline',
      'Host heartbeat missing. Offline is inferred; task outcome is unknown.',1,'open',?
      FROM hosts WHERE coalesce(last_heartbeat_at,created_at) < ?
      ON CONFLICT(id) DO NOTHING`).bind(time,offline),
    env.DB.prepare(`INSERT INTO attention (id,host_id,task_id,session_id,kind,message,inferred,state,created_at)
      SELECT 'stale:' || s.id || ':' || s.last_received_at,s.host_id,
        (SELECT r.task_id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.session_id=s.id AND t.status='active' AND t.archived=0 ORDER BY r.started_at DESC LIMIT 1),
        s.id,'stale','Session has not reported recently. Staleness is inferred; task outcome is unknown.',1,'open',?
      FROM sessions s JOIN hosts h ON h.id=s.host_id
      WHERE s.status='active' AND s.last_received_at < ? AND h.last_heartbeat_at >= ?
      ON CONFLICT(id) DO NOTHING`).bind(time,stale,offline),
    env.DB.prepare(`UPDATE attention SET resolved_at=? WHERE resolved_at IS NULL AND kind='offline'
      AND host_id IN (SELECT id FROM hosts WHERE last_heartbeat_at >= ?)`).bind(time,offline),
    env.DB.prepare(`UPDATE attention SET resolved_at=? WHERE resolved_at IS NULL AND kind='stale'
      AND session_id IN (SELECT id FROM sessions WHERE status='ended' OR last_received_at >= ?)`).bind(time,stale),
  ]);
}

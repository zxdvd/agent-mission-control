import { EVENT_TYPES, type AgentEvent, type EventPayload } from './types';

export class ProtocolError extends Error {}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENVELOPE = new Set(['event_id', 'timestamp', 'host_id', 'agent_type', 'session_id', 'task_id', 'run_id', 'event_type', 'payload']);
const LIMITS = { name: 160, summary: 600, repo: 240, branch: 160, project: 160, error: 400, question: 400, commit: 64, pr_url: 500 } as const;
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|authorization|secret)\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9_.-]{12,})/i;
export function validateId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new ProtocolError(`Invalid ${field}`);
}
export function safeText(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value) || SECRET.test(value)) {
    throw new ProtocolError(`Invalid or sensitive ${field}`);
  }
  return value;
}
export function validateEvent(input: unknown, now = Date.now()): AgentEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProtocolError('Event must be an object');
  const e = input as Record<string, unknown>;
  if (Object.keys(e).some(k => !ENVELOPE.has(k))) throw new ProtocolError('Unexpected event field');
  for (const k of ['event_id', 'host_id', 'session_id']) validateId(e[k], k);
  if (typeof e.agent_type !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(e.agent_type)) throw new ProtocolError('Invalid agent_type');
  if (!EVENT_TYPES.includes(e.event_type as never)) throw new ProtocolError('Unsupported event_type');
  if (typeof e.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(e.timestamp)) throw new ProtocolError('Timestamp must be UTC ISO 8601');
  const when = Date.parse(e.timestamp);
  if (!Number.isFinite(when) || new Date(when).toISOString().slice(0,19) !== e.timestamp.slice(0,19) || when < Date.UTC(2000, 0, 1) || when > now + 300_000) throw new ProtocolError('Invalid or future timestamp');
  for (const k of ['task_id', 'run_id']) if (e[k] !== undefined && e[k] !== null) validateId(e[k], k);
  const type = e.event_type as AgentEvent['event_type'];
  const needsTask = !['heartbeat', 'session_started', 'session_ended'].includes(type);
  if (needsTask && (!e.task_id || !e.run_id)) throw new ProtocolError('This event requires task_id and run_id');
  if (e.run_id && (!e.run_id || !e.task_id)) throw new ProtocolError('Run events require run_id and task_id');
  if ((e.session_id as string).startsWith('host:') && (type !== 'heartbeat' || e.session_id !== `host:${e.host_id}` || e.task_id || e.run_id)) throw new ProtocolError('Reserved host heartbeat session ID');
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) throw new ProtocolError('Payload must be an object');
  const payload: EventPayload = {};
  for (const [key, value] of Object.entries(e.payload)) {
    if (!Object.hasOwn(LIMITS, key)) throw new ProtocolError('Unexpected payload field; only safe metadata is accepted');
    const k = key as keyof typeof LIMITS;
    const v = safeText(value, k, LIMITS[k]);
    if (k === 'commit' && v && !/^[a-f0-9]{7,64}$/i.test(v)) throw new ProtocolError('Invalid commit');
    if (k === 'pr_url' && v) {
      let u: URL;
      try { u = new URL(v); } catch { throw new ProtocolError('Invalid pr_url'); }
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new ProtocolError('PR URLs must be HTTPS without credentials, query or fragment');
    }
    if (k === 'repo' && (v.includes('://') || v.includes('@') || v.includes('?') || v.includes('#'))) throw new ProtocolError('Use owner/repository or a display name, not a credential-bearing URL');
    payload[k] = v;
  }
  return { event_id: e.event_id as string, timestamp: new Date(when).toISOString(), host_id: e.host_id as string,
    agent_type: e.agent_type, session_id: e.session_id as string,
    ...(e.task_id ? { task_id: e.task_id as string } : {}), ...(e.run_id ? { run_id: e.run_id as string } : {}), event_type: type, payload };
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function canonicalEvent(e: AgentEvent): string {
  return JSON.stringify({ ...e, payload: Object.fromEntries(Object.entries(e.payload).sort(([a], [b]) => a.localeCompare(b))) });
}
export function eventClock(e: AgentEvent): string {
  const rank = ['task_completed', 'task_failed', 'session_ended'].includes(e.event_type) ? '9'
    : ['turn_finished'].includes(e.event_type) ? '5' : '1';
  return `${e.timestamp}:${rank}:${e.event_id}`;
}

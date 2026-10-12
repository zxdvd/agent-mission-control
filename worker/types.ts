export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DASHBOARD_USERNAME?: string;
  DASHBOARD_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  SESSION_VERSION?: string;
  AGENT_TOKENS_JSON?: string;
  LOCAL_DEV?: string;
  OFFLINE_SECONDS?: string;
  STALE_SECONDS?: string;
}
export type Identity = { role: 'admin'; email?: string; local: boolean; csrf_token: string; sessionHash?: string };
export type AppEnv = { Bindings: Env; Variables: { identity: Identity } };
export const EVENT_TYPES = [
  'session_started', 'turn_started', 'turn_finished', 'approval_required',
  'waiting_for_input', 'task_completed', 'task_failed', 'heartbeat', 'session_ended',
] as const;
export type EventType = typeof EVENT_TYPES[number];
export type EventPayload = Partial<Record<'name' | 'summary' | 'repo' | 'branch' | 'project' | 'error' | 'question' | 'commit' | 'pr_url', string>>;
export interface AgentEvent {
  event_id: string;
  timestamp: string;
  host_id: string;
  agent_type: string;
  session_id: string;
  task_id?: string;
  run_id?: string;
  event_type: EventType;
  payload: EventPayload;
}

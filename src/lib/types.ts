export type Task = {
  id: string; name: string; host_id: string; agent_type: string;
  project: string | null; repo: string | null; branch: string | null; summary: string | null;
  status: 'active' | 'completed' | 'failed'; activity: 'running' | 'idle' | 'unknown';
  attention: 'none' | 'approval' | 'input' | 'error'; created_at: string;
  last_activity_at: string; completed_at: string | null; archived: boolean | number;
  current_run_id: string | null;
}
export type Host = { id: string; name: string; last_heartbeat_at: string | null; online: boolean; task_count: number; session_count: number }
export type Attention = { id: string; host_id: string; task_id: string | null; session_id: string | null; kind: 'approval' | 'input' | 'error' | 'stale' | 'offline'; message: string; inferred: boolean; state: 'open' | 'read' | 'ignored'; created_at: string; resolved_at?: string | null }
export type AgentEvent = { id?: string; event_id?: string; timestamp: string; host_id: string; agent_type: string; session_id: string; task_id?: string; run_id?: string; event_type: string; payload: Record<string, unknown> }
export type Run = { id: string; task_id: string; session_id: string; status: string; started_at: string; ended_at: string | null; summary: string | null }
export type Session = { id: string; host_id: string; agent_type: string; status: string; started_at: string; last_activity_at: string; ended_at: string | null }
export type Overview = { stats: { running: number; waiting: number; failed: number; completed_today: number; online_hosts: number; offline_hosts: number }; tasks: Task[]; hosts: Host[]; attention: Attention[]; server_time: string }
export type TaskDetail = { task: Task; runs: Run[]; sessions: Session[]; events: AgentEvent[]; attention: Attention[] }
export type Identity = { role: string; email: string; local: boolean }

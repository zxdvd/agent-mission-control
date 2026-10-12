import { createHash, randomUUID } from 'node:crypto';

export const AGENTS = new Set(['codex', 'claude']);
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'];
export const EVENT_TYPES = new Set(['session_started', 'turn_started', 'turn_finished', 'approval_required', 'waiting_for_input', 'task_completed', 'task_failed', 'heartbeat', 'session_ended']);
export function id(prefix, ...parts) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}
export function safeId(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}; use 1–128 letters, numbers, dots, colons, dashes or underscores.`);
  return value;
}
export function safeLabel(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : undefined;
}
export function makeEvent(config, agent, eventType, nativeSession, options = {}) {
  if (!AGENTS.has(agent) || !EVENT_TYPES.has(eventType)) throw new Error('Unsupported event.');
  if (typeof nativeSession !== 'string' || !nativeSession || nativeSession.length > 1024) throw new Error('Missing or invalid session identifier.');
  const session = options.sessionId || id('session', config.host_id, agent, nativeSession);
  const event = {
    event_id: options.eventId || randomUUID(), timestamp: new Date().toISOString(),
    host_id: safeId(config.host_id, 'host ID'), agent_type: agent,
    session_id: session, event_type: eventType,
    payload: {},
  };
  if (eventType !== 'heartbeat') {
    event.task_id = options.taskId ? safeId(options.taskId, 'task ID') : id('task', config.host_id, agent, nativeSession);
    if (options.runId || !['session_started', 'session_ended'].includes(eventType)) event.run_id = safeId(options.runId || id('run', config.host_id, agent, nativeSession, 'unobserved-start'), 'run ID');
    // User-selected labels only. Never copy arbitrary hook payload fields.
    for (const key of ['name', 'project', 'repo', 'branch']) {
      if (config.metadata?.[key]) event.payload[key] = safeLabel(config.metadata[key]);
    }
  }
  // The wire payload is deliberately restricted to the backend's public metadata
  // schema. All summaries below are static adapter text, never model/user content.
  const summaries = {
    codex_notify: 'Codex turn finished (notify only; task remains open)',
    codex_hook: 'Observed a Codex lifecycle event',
    claude_hook: 'Observed a Claude Code lifecycle event',
    wrapper: 'Launcher process activity; model activity is not observed by the wrapper',
    manual: eventType === 'task_completed' ? 'Task explicitly marked complete' : 'Task explicitly marked failed',
  };
  if (summaries[options.source]) event.payload.summary = summaries[options.source];
  if (options.message) event.payload.summary = safeLabel(options.message);
  return event;
}
export function codexNotify(config, input, context = {}) {
  if (input?.type !== 'agent-turn-complete') return null;
  const session = input['thread-id'];
  if (typeof session !== 'string' || !session) return null;
  const turn = typeof input['turn-id'] === 'string' && input['turn-id'].length <= 1024 ? input['turn-id'] : undefined;
  return makeEvent(config, 'codex', 'turn_finished', session, {
    ...context, source: 'codex_notify',
    runId: context.runId || id('run', config.host_id, 'codex', session, context.taskId || id('task', config.host_id, 'codex', session), 'session-run'),
    eventId: turn ? id('event', config.host_id, 'codex', session, turn, 'turn_finished') : undefined,
  });
}
export function hookEventType(agent, input) {
  const name = input?.hook_event_name;
  const mapping = {
    SessionStart: 'session_started', UserPromptSubmit: 'turn_started',
    PermissionRequest: 'approval_required', Stop: 'turn_finished', SessionEnd: 'session_ended',
  };
  if (agent === 'codex' && name === 'Interrupt') return 'turn_finished';
  if (agent === 'claude' && name === 'Notification') {
    if (input.notification_type === 'permission_prompt') return 'approval_required';
    // idle_prompt is a heuristic and is intentionally not an observed input request.
    return null;
  }
  return mapping[name] || null;
}
export function hookEvent(config, agent, input, context = {}) {
  const eventType = hookEventType(agent, input);
  if (!eventType || typeof input.session_id !== 'string' || !input.session_id) return null;
  return makeEvent(config, agent, eventType, input.session_id, {
    ...context,
    runId: context.runId || id('run', config.host_id, agent, input.session_id, context.taskId || id('task', config.host_id, agent, input.session_id), 'session-run'),
    source: agent === 'codex' ? 'codex_hook' : 'claude_hook', hookEvent: input.hook_event_name,

    message: eventType === 'approval_required' ? 'Permission requested in the local agent' :
      eventType === 'waiting_for_input' ? 'Agent may be waiting for input (idle notification)' : undefined,
  });
}

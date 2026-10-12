# Monitoring API

All routes except event ingestion require a valid Cloudflare Access identity. Mutations require an admin identity. Static assets are also authenticated. The loopback-only development identity is available solely when LOCAL_DEV=true.

## Events

POST /api/events uses `Authorization: Bearer <per-host token>` independently of browser authentication.

```json
{
  "event_id": "event-unique-id",
  "timestamp": "2026-10-12T03:00:00.000Z",
  "host_id": "my-mac",
  "agent_type": "codex",
  "session_id": "session-example",
  "task_id": "task-example",
  "run_id": "run-example",
  "event_type": "turn_finished",
  "payload": {"name": "Review service", "repo": "example/service", "summary": "Response ended; task outcome remains unknown."}
}
```

Allowed event types: session_started, turn_started, turn_finished, approval_required, waiting_for_input, task_completed, task_failed, heartbeat, session_ended.

Allowed payload keys are bounded strings: name, summary, repo, branch, project, error, question, commit, pr_url. Unknown fields, control characters, obvious credential patterns, credential-bearing repository URLs, and PR URLs with query/fragment are rejected. Do not rely on pattern checks as a complete data-loss-prevention system. The adapters use an even smaller whitelist and never copy native response/prompt/tool text.

Non-session lifecycle/task activity events require task_id and run_id. For a host-only heartbeat, omit both and use session_id=`host:<host_id>`. A run is bound to one task and session; tasks/sessions are bound to one host and agent. Moving work across hosts creates distinct identities.

The same event_id and canonical body can be retried; the timeline stores one row. Reusing an event_id with changed contents returns409. Accepted ingestion is atomically limited to240 events per host per60 seconds; repeats do not consume accepted-event quota. 429 includes Retry-After. Requests are limited to16KiB. Timestamps must be UTC ISO8601, no earlier than2000, at most5 minutes ahead of server time.

## Console routes

- GET /api/me → role,email,local
- GET /api/overview → stats,tasks,hosts,attention,server_time
- GET /api/hosts → hosts
- GET /api/tasks → tasks (unarchived); `?archived=all` includes archived
- GET /api/tasks/:id → task,runs,sessions,events,attention,next_cursor
- GET /api/tasks/:id/events?cursor=<opaque>&limit=100 → events,next_cursor (maximum200)
- PATCH /api/tasks/:id with `{name}` and/or `{archived:boolean}`
- PATCH /api/attention/:id with `{state:"open"|"read"|"ignored"}`
- POST /api/admin/hosts with `{host_id,name}` → host,token (one-time plaintext result)
- DELETE /api/admin/hosts/:id/credential → revoked,host_id

Overview/task lists are bounded to500 rows; overview attention is bounded to200 records. The timeline is paginated and must be followed through next_cursor for older history. This MVP is designed for a personal fleet, not an unbounded organization-wide task index. Credential rotation uses a new host identity after revocation; there is no silent token replacement.

Observed approval/input remains in attention until the operator organizes the item; native event coverage cannot prove resolution. Read/ignore does not mean approved or answered. Stale/offline alerts are inferred, never task failures. A task follows its latest run; explicit terminal outcomes within a run use a separate ordering clock. Session closure never means successful completion, and only an explicit newer session start resumes an ended session.

No remote execution, approvals, replies, shell, workflow triggering, or task-retry endpoint exists.

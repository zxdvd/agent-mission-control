PRAGMA foreign_keys = ON;

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_heartbeat_at TEXT
);
CREATE TABLE host_credentials (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  ended_at TEXT,
  state_clock TEXT NOT NULL,
  lifecycle_clock TEXT,
  last_end_clock TEXT,
  last_ended_at TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  agent_type TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')),
  activity TEXT NOT NULL DEFAULT 'unknown' CHECK(activity IN ('running','idle','unknown')),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  completed_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  current_run_id TEXT,
  state_clock TEXT NOT NULL,
  metadata_clock TEXT NOT NULL,
  name_clock TEXT NOT NULL DEFAULT '',
  project_clock TEXT NOT NULL DEFAULT '',
  repo_clock TEXT NOT NULL DEFAULT '',
  branch_clock TEXT NOT NULL DEFAULT '',
  summary_clock TEXT NOT NULL DEFAULT '',
  name_overridden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL CHECK(status IN ('running','idle','completed','failed','unknown')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  state_clock TEXT NOT NULL,
  outcome_clock TEXT,
  observed_activity TEXT NOT NULL DEFAULT 'unknown' CHECK(observed_activity IN ('running','idle','unknown')),
  activity_clock TEXT
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  agent_type TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('session_started','turn_started','turn_finished','approval_required','waiting_for_input','task_completed','task_failed','heartbeat','session_ended')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  fingerprint TEXT NOT NULL,
  clock TEXT NOT NULL
);
CREATE TABLE attention (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK(kind IN ('approval','input','error','stale','offline')),
  message TEXT NOT NULL,
  inferred INTEGER NOT NULL DEFAULT 0 CHECK(inferred IN (0,1)),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','read','ignored')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  event_id TEXT REFERENCES events(event_id)
);
CREATE INDEX events_task_time ON events(task_id, timestamp DESC);
CREATE INDEX events_host_time ON events(host_id, received_at DESC);
CREATE INDEX sessions_host ON sessions(host_id, last_received_at);
CREATE INDEX tasks_host_activity ON tasks(host_id, last_activity_at DESC);
CREATE INDEX runs_task ON runs(task_id, started_at DESC);
CREATE INDEX attention_open ON attention(state, resolved_at, created_at DESC);

-- Validate identities inside the same INSERT transaction as projections. Separate
-- read-then-write checks alone would allow two hosts to race to claim an ID.
CREATE TRIGGER event_identity_guard BEFORE INSERT ON events
WHEN NOT EXISTS (SELECT 1 FROM events WHERE event_id = NEW.event_id)
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM events WHERE host_id=NEW.host_id AND received_at > strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at,'-60 seconds')) >= 240 THEN RAISE(ABORT, 'rate_limit') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sessions WHERE id = NEW.session_id AND (host_id != NEW.host_id OR agent_type != NEW.agent_type)
  ) THEN RAISE(ABORT, 'identity_conflict:session') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM tasks WHERE id = NEW.task_id AND (host_id != NEW.host_id OR agent_type != NEW.agent_type)
  ) THEN RAISE(ABORT, 'identity_conflict:task') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM runs WHERE id = NEW.run_id AND (task_id != NEW.task_id OR session_id != NEW.session_id)
  ) THEN RAISE(ABORT, 'identity_conflict:run') END;
END;

-- An inserted event and all materialized state are one SQLite transaction.
-- ON CONFLICT(event_id) DO NOTHING means retries never run these projections.
CREATE TRIGGER event_project AFTER INSERT ON events
BEGIN
  UPDATE hosts SET last_heartbeat_at = max(coalesce(last_heartbeat_at, ''), NEW.received_at) WHERE id = NEW.host_id;
  UPDATE attention SET resolved_at = NEW.received_at
    WHERE host_id = NEW.host_id AND kind = 'offline' AND resolved_at IS NULL;

  INSERT INTO sessions (id,host_id,agent_type,status,started_at,last_activity_at,last_received_at,ended_at,state_clock,lifecycle_clock,last_end_clock,last_ended_at)
  SELECT NEW.session_id,NEW.host_id,NEW.agent_type,
    CASE WHEN NEW.event_type = 'session_ended' THEN 'ended' ELSE 'active' END,
    NEW.timestamp,NEW.timestamp,NEW.received_at,
    CASE WHEN NEW.event_type = 'session_ended' THEN NEW.timestamp END,NEW.clock,
    CASE WHEN NEW.event_type IN ('session_started','session_ended') THEN NEW.clock END,
    CASE WHEN NEW.event_type = 'session_ended' THEN NEW.clock END,
    CASE WHEN NEW.event_type = 'session_ended' THEN NEW.timestamp END
  WHERE NOT (NEW.event_type = 'heartbeat' AND NEW.session_id = 'host:' || NEW.host_id)
  ON CONFLICT(id) DO UPDATE SET
    started_at = min(sessions.started_at, excluded.started_at),
    last_activity_at = max(sessions.last_activity_at, excluded.last_activity_at),
    last_received_at = max(sessions.last_received_at, excluded.last_received_at),
    status = CASE WHEN NEW.event_type IN ('session_started','session_ended') AND NEW.clock > coalesce(sessions.lifecycle_clock,'') THEN excluded.status ELSE sessions.status END,
    ended_at = CASE WHEN NEW.event_type IN ('session_started','session_ended') AND NEW.clock > coalesce(sessions.lifecycle_clock,'') THEN excluded.ended_at ELSE sessions.ended_at END,
    state_clock = max(sessions.state_clock,excluded.state_clock),
    lifecycle_clock = CASE WHEN NEW.event_type IN ('session_started','session_ended') THEN max(coalesce(sessions.lifecycle_clock,''),NEW.clock) ELSE sessions.lifecycle_clock END,
    last_end_clock = CASE WHEN NEW.event_type = 'session_ended' THEN max(coalesce(sessions.last_end_clock,''),NEW.clock) ELSE sessions.last_end_clock END,
    last_ended_at = CASE WHEN NEW.event_type = 'session_ended' THEN max(coalesce(sessions.last_ended_at,''),NEW.timestamp) ELSE sessions.last_ended_at END;

  UPDATE attention SET resolved_at = NEW.received_at
    WHERE session_id = NEW.session_id AND kind = 'stale' AND resolved_at IS NULL;

  INSERT INTO tasks (id,name,host_id,agent_type,project,repo,branch,summary,status,activity,created_at,last_activity_at,completed_at,current_run_id,state_clock,metadata_clock,name_clock,project_clock,repo_clock,branch_clock,summary_clock)
  SELECT NEW.task_id,coalesce(json_extract(NEW.payload,'$.name'), 'Untitled task'),NEW.host_id,NEW.agent_type,
    coalesce(json_extract(NEW.payload,'$.project'),''),coalesce(json_extract(NEW.payload,'$.repo'),''),
    coalesce(json_extract(NEW.payload,'$.branch'),''),coalesce(json_extract(NEW.payload,'$.summary'),''),
    CASE NEW.event_type WHEN 'task_completed' THEN 'completed' WHEN 'task_failed' THEN 'failed' ELSE 'active' END,
    CASE NEW.event_type WHEN 'turn_started' THEN 'running' WHEN 'turn_finished' THEN 'idle' WHEN 'task_completed' THEN 'idle' WHEN 'task_failed' THEN 'idle' ELSE 'unknown' END,
    NEW.timestamp,NEW.timestamp,CASE WHEN NEW.event_type IN ('task_completed','task_failed') THEN NEW.timestamp END,
    NEW.run_id,NEW.clock,NEW.clock,
    CASE WHEN json_type(NEW.payload,'$.name')='text' THEN NEW.clock ELSE '' END,
    CASE WHEN json_type(NEW.payload,'$.project')='text' THEN NEW.clock ELSE '' END,
    CASE WHEN json_type(NEW.payload,'$.repo')='text' THEN NEW.clock ELSE '' END,
    CASE WHEN json_type(NEW.payload,'$.branch')='text' THEN NEW.clock ELSE '' END,
    CASE WHEN json_type(NEW.payload,'$.summary')='text' THEN NEW.clock ELSE '' END
  WHERE NEW.task_id IS NOT NULL
  ON CONFLICT(id) DO UPDATE SET
    created_at = min(tasks.created_at,excluded.created_at),
    last_activity_at = max(tasks.last_activity_at,excluded.last_activity_at),
    name = CASE WHEN tasks.name_overridden = 0 AND json_type(NEW.payload,'$.name')='text' AND NEW.clock > tasks.name_clock THEN json_extract(NEW.payload,'$.name') ELSE tasks.name END,
    project = CASE WHEN json_type(NEW.payload,'$.project')='text' AND NEW.clock > tasks.project_clock THEN json_extract(NEW.payload,'$.project') ELSE tasks.project END,
    repo = CASE WHEN json_type(NEW.payload,'$.repo')='text' AND NEW.clock > tasks.repo_clock THEN json_extract(NEW.payload,'$.repo') ELSE tasks.repo END,
    branch = CASE WHEN json_type(NEW.payload,'$.branch')='text' AND NEW.clock > tasks.branch_clock THEN json_extract(NEW.payload,'$.branch') ELSE tasks.branch END,
    summary = CASE WHEN json_type(NEW.payload,'$.summary')='text' AND NEW.clock > tasks.summary_clock THEN json_extract(NEW.payload,'$.summary') ELSE tasks.summary END,
    status = CASE WHEN NEW.clock > tasks.state_clock AND tasks.status = 'active' AND NEW.event_type IN ('task_completed','task_failed') THEN excluded.status ELSE tasks.status END,
    completed_at = CASE WHEN NEW.clock > tasks.state_clock AND tasks.status = 'active' AND NEW.event_type IN ('task_completed','task_failed') THEN NEW.timestamp ELSE tasks.completed_at END,
    activity = CASE WHEN tasks.status != 'active' THEN 'idle' WHEN NEW.clock > tasks.state_clock AND NEW.event_type IN ('turn_started','turn_finished','task_completed','task_failed','session_ended') THEN excluded.activity ELSE tasks.activity END,
    current_run_id = CASE WHEN NEW.clock > tasks.state_clock AND NEW.run_id IS NOT NULL THEN NEW.run_id ELSE tasks.current_run_id END,
    state_clock = CASE WHEN NEW.event_type != 'heartbeat' THEN max(tasks.state_clock,NEW.clock) ELSE tasks.state_clock END,
    metadata_clock = max(tasks.metadata_clock,NEW.clock),
    name_clock = CASE WHEN json_type(NEW.payload,'$.name')='text' THEN max(tasks.name_clock,NEW.clock) ELSE tasks.name_clock END,
    project_clock = CASE WHEN json_type(NEW.payload,'$.project')='text' THEN max(tasks.project_clock,NEW.clock) ELSE tasks.project_clock END,
    repo_clock = CASE WHEN json_type(NEW.payload,'$.repo')='text' THEN max(tasks.repo_clock,NEW.clock) ELSE tasks.repo_clock END,
    branch_clock = CASE WHEN json_type(NEW.payload,'$.branch')='text' THEN max(tasks.branch_clock,NEW.clock) ELSE tasks.branch_clock END,
    summary_clock = CASE WHEN json_type(NEW.payload,'$.summary')='text' THEN max(tasks.summary_clock,NEW.clock) ELSE tasks.summary_clock END;

  INSERT INTO runs (id,task_id,session_id,status,started_at,ended_at,summary,state_clock,outcome_clock,observed_activity,activity_clock)
  SELECT NEW.run_id,NEW.task_id,NEW.session_id,
    CASE NEW.event_type WHEN 'turn_started' THEN 'running' WHEN 'turn_finished' THEN 'idle' WHEN 'task_completed' THEN 'completed' WHEN 'task_failed' THEN 'failed' ELSE 'unknown' END,
    NEW.timestamp,CASE WHEN NEW.event_type IN ('task_completed','task_failed','session_ended') THEN NEW.timestamp END,
    coalesce(json_extract(NEW.payload,'$.summary'),''),NEW.clock,CASE WHEN NEW.event_type IN ('task_completed','task_failed') THEN NEW.clock END,
    CASE NEW.event_type WHEN 'turn_started' THEN 'running' WHEN 'turn_finished' THEN 'idle' ELSE 'unknown' END,
    CASE WHEN NEW.event_type IN ('turn_started','turn_finished') THEN NEW.clock END
  WHERE NEW.run_id IS NOT NULL
  ON CONFLICT(id) DO UPDATE SET
    started_at = min(runs.started_at,excluded.started_at),
    status = CASE WHEN NEW.event_type IN ('task_completed','task_failed') AND NEW.clock > coalesce(runs.outcome_clock,'') THEN excluded.status WHEN NEW.clock > runs.state_clock AND runs.status NOT IN ('completed','failed') AND NEW.event_type IN ('turn_started','turn_finished','session_ended') THEN excluded.status ELSE runs.status END,
    ended_at = CASE WHEN NEW.event_type IN ('task_completed','task_failed') AND NEW.clock > coalesce(runs.outcome_clock,'') THEN NEW.timestamp WHEN NEW.clock > runs.state_clock AND runs.status NOT IN ('completed','failed') AND NEW.event_type='session_ended' THEN NEW.timestamp WHEN NEW.clock > runs.state_clock AND runs.status NOT IN ('completed','failed') AND NEW.event_type='turn_started' THEN NULL ELSE runs.ended_at END,
    summary = CASE WHEN NEW.clock > runs.state_clock THEN coalesce(json_extract(NEW.payload,'$.summary'),runs.summary) ELSE runs.summary END,
    state_clock = CASE WHEN NEW.event_type != 'heartbeat' THEN max(runs.state_clock,NEW.clock) ELSE runs.state_clock END,
    outcome_clock = CASE WHEN NEW.event_type IN ('task_completed','task_failed') THEN max(coalesce(runs.outcome_clock,''),NEW.clock) ELSE runs.outcome_clock END,
    observed_activity = CASE WHEN NEW.event_type IN ('turn_started','turn_finished') AND NEW.clock > coalesce(runs.activity_clock,'') THEN excluded.observed_activity ELSE runs.observed_activity END,
    activity_clock = CASE WHEN NEW.event_type IN ('turn_started','turn_finished') THEN max(coalesce(runs.activity_clock,''),NEW.clock) ELSE runs.activity_clock END;

  UPDATE runs SET status = 'unknown', ended_at = coalesce(ended_at,NEW.timestamp),state_clock = NEW.clock
    WHERE session_id = NEW.session_id AND NEW.event_type = 'session_ended' AND status NOT IN ('completed','failed') AND NEW.clock >= state_clock;
  UPDATE tasks SET activity = 'unknown', state_clock = NEW.clock
    WHERE NEW.event_type = 'session_ended' AND status = 'active' AND NEW.clock >= state_clock
      AND current_run_id IN (SELECT id FROM runs WHERE session_id = NEW.session_id);

  -- Reconcile observed activity against independently ordered session lifecycle.
  -- Keep observations intact while ended, so a delayed explicit resume can
  -- restore a post-resume turn that arrived first. Historical end clocks still
  -- suppress pre-end activity. Neither heartbeat nor inferred state completes
  -- a task, and explicit terminal outcomes remain independent of lifecycle.
  UPDATE runs SET
    status=CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND
      (s.status='ended' OR coalesce(runs.activity_clock,'') <= coalesce(s.last_end_clock,''))) THEN 'unknown' ELSE observed_activity END,
    ended_at=CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND
      (s.status='ended' OR coalesce(runs.activity_clock,'') <= coalesce(s.last_end_clock,'')))
      THEN (SELECT last_ended_at FROM sessions WHERE id=NEW.session_id) ELSE NULL END
    WHERE session_id=NEW.session_id AND outcome_clock IS NULL;

  -- The logical task follows the latest run by its START time, not by the
  -- arrival time of an old run's completion. This permits explicit retries and
  -- prevents delayed old-run failures from clobbering a newer successful run.
  UPDATE tasks SET
    current_run_id = (SELECT id FROM runs WHERE task_id=tasks.id ORDER BY started_at DESC,id DESC LIMIT 1),
    status = coalesce((SELECT CASE status WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' ELSE 'active' END FROM runs WHERE task_id=tasks.id ORDER BY started_at DESC,id DESC LIMIT 1),status),
    activity = coalesce((SELECT CASE status WHEN 'running' THEN 'running' WHEN 'idle' THEN 'idle' WHEN 'completed' THEN 'idle' WHEN 'failed' THEN 'idle' ELSE 'unknown' END FROM runs WHERE task_id=tasks.id ORDER BY started_at DESC,id DESC LIMIT 1),activity),
    completed_at = (SELECT CASE WHEN status IN ('completed','failed') THEN ended_at END FROM runs WHERE task_id=tasks.id ORDER BY started_at DESC,id DESC LIMIT 1)
    WHERE id=NEW.task_id OR id IN (SELECT task_id FROM runs WHERE session_id=NEW.session_id);

  INSERT INTO attention (id,host_id,task_id,session_id,kind,message,inferred,state,created_at,event_id)
  SELECT 'event:' || NEW.event_id,NEW.host_id,NEW.task_id,NEW.session_id,
    CASE NEW.event_type WHEN 'approval_required' THEN 'approval' WHEN 'waiting_for_input' THEN 'input' ELSE 'error' END,
    CASE NEW.event_type WHEN 'approval_required' THEN 'Permission required' WHEN 'waiting_for_input' THEN 'Agent is waiting for input' ELSE coalesce(json_extract(NEW.payload,'$.error'),'Task failed') END,
    0,'open',NEW.timestamp,NEW.event_id
  WHERE NEW.event_type IN ('approval_required','waiting_for_input','task_failed');
END;

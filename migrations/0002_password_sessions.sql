-- Authentication configuration lives only in Worker Secrets. D1 stores short-
-- lived sessions and login throttling state, never password/host-token verifiers.
-- Old credentials are deliberately removed; AGENT_TOKENS_JSON is authoritative.
DROP TABLE host_credentials;

CREATE TABLE dashboard_sessions (
  id_hash TEXT PRIMARY KEY CHECK(length(id_hash) = 64),
  expires_at INTEGER NOT NULL,
  config_version TEXT NOT NULL CHECK(length(config_version) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions(expires_at);
CREATE TABLE login_attempts (
  bucket_key TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(bucket_key,window_id)
);
CREATE INDEX login_attempts_expiry ON login_attempts(expires_at);

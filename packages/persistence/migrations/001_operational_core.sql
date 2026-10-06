CREATE TABLE server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  protected_private_key BLOB NOT NULL,
  security_epoch INTEGER NOT NULL DEFAULT 1 CHECK (security_epoch >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  label TEXT,
  credential_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT,
  linked_at TEXT NOT NULL,
  unlinked_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL,
  identity_key TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE trusted_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  mode TEXT NOT NULL CHECK (mode IN ('full_access', 'ask_sensitive', 'read_only')),
  security_epoch INTEGER NOT NULL CHECK (security_epoch >= 1),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  integrity_tag TEXT NOT NULL
);

CREATE TABLE grant_scopes (
  grant_id TEXT NOT NULL REFERENCES trusted_grants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  PRIMARY KEY (grant_id, scope)
);

CREATE TABLE grant_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id TEXT NOT NULL REFERENCES trusted_grants(id),
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  workspace_id TEXT REFERENCES workspaces(id),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  action_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  session_id TEXT REFERENCES sessions(id),
  risk_tier INTEGER NOT NULL CHECK (risk_tier BETWEEN 0 AND 3),
  action_class TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  preview_json TEXT NOT NULL,
  recovery_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT
);

CREATE TABLE approval_uses (
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  used_at TEXT NOT NULL,
  action_id TEXT REFERENCES actions(id),
  PRIMARY KEY (approval_id)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT NOT NULL,
  principal_id TEXT,
  client_id TEXT,
  session_id TEXT,
  workspace_id TEXT,
  grant_id TEXT,
  approval_id TEXT,
  job_id TEXT,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  targets_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  session_id TEXT,
  workspace_id TEXT,
  grant_id TEXT,
  specification_json TEXT NOT NULL,
  idempotency_key TEXT,
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  process_identity_json TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  verification_json TEXT
);

CREATE UNIQUE INDEX jobs_idempotency_key_unique
  ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE job_steps (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  state TEXT NOT NULL,
  specification_json TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  PRIMARY KEY (job_id, step_number)
);

CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE TABLE job_logs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  content_redacted TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE TABLE searches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE search_results (
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (search_id, sequence)
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workspace_id TEXT,
  grant_id TEXT,
  specification_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watch_events (
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (watch_id, sequence)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  grant_id TEXT,
  timezone TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  state TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  state TEXT NOT NULL,
  preview_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  rolled_back_at TEXT
);

CREATE TABLE transaction_changes (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  target_identity TEXT NOT NULL,
  change_json TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (transaction_id, sequence)
);

CREATE TABLE recovery_points (
  id TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id),
  target_identity TEXT NOT NULL,
  recovery_json TEXT NOT NULL,
  artifact_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE resource_locks (
  resource_identity TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE lock_leases (
  resource_identity TEXT NOT NULL REFERENCES resource_locks(resource_identity) ON DELETE CASCADE,
  fencing_token INTEGER NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (resource_identity, fencing_token)
);

CREATE TABLE runtime_checkpoints (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  state_json TEXT NOT NULL,
  verification_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE operational_state (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  kind TEXT NOT NULL,
  canonical_location TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  validation_state TEXT NOT NULL,
  retention_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE artifact_relations (
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  child_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (parent_artifact_id, child_artifact_id, relation)
);

CREATE TABLE credential_refs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  vault_target TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE tool_versions (
  tool_name TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  state TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (tool_name, version)
);

CREATE TABLE capability_runs (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  state TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX audit_events_correlation_idx ON audit_events(correlation_id, id);
CREATE INDEX job_events_job_idx ON job_events(job_id, sequence);
CREATE INDEX watches_state_idx ON watches(state);
CREATE INDEX schedules_next_run_idx ON schedules(state, next_run_at);
CREATE INDEX artifacts_workspace_idx ON artifacts(workspace_id, created_at);

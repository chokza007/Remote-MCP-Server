CREATE TABLE operational_events (
  namespace TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (namespace, sequence)
);

CREATE UNIQUE INDEX operational_events_dedupe_unique
  ON operational_events(namespace, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX operational_events_source_idx
  ON operational_events(namespace, source_type, source_id, sequence);

ALTER TABLE watches ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE watches ADD COLUMN target TEXT;
ALTER TABLE watches ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE watches ADD COLUMN cursor_json TEXT;
ALTER TABLE watches ADD COLUMN last_fingerprint TEXT;
ALTER TABLE watches ADD COLUMN next_poll_at TEXT;
ALTER TABLE watches ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX watches_owner_idx ON watches(owner_id, created_at);
CREATE INDEX watches_poll_idx ON watches(state, next_poll_at);

ALTER TABLE schedules ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE schedules ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'run_once';
ALTER TABLE schedules ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip';

CREATE INDEX schedules_owner_idx ON schedules(owner_id, created_at);
CREATE INDEX schedules_due_idx ON schedules(state, next_run_at);

CREATE TABLE schedule_runs (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  state TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (schedule_id, run_id),
  UNIQUE (schedule_id, scheduled_for)
);

CREATE INDEX schedule_runs_state_idx ON schedule_runs(schedule_id, state, started_at);

ALTER TABLE notifications ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN next_attempt_at TEXT;
ALTER TABLE notifications ADD COLUMN error TEXT;

CREATE INDEX notifications_owner_idx ON notifications(owner_id, created_at);
CREATE INDEX notifications_retry_idx ON notifications(state, next_attempt_at);

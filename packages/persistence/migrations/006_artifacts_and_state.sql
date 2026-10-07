ALTER TABLE artifacts ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'reference';
ALTER TABLE artifacts ADD COLUMN original_location TEXT;
ALTER TABLE artifacts ADD COLUMN updated_at TEXT;

CREATE INDEX artifacts_namespace_idx
  ON artifacts(namespace, workspace_id, created_at, id);
CREATE INDEX artifacts_location_idx
  ON artifacts(canonical_location, storage_mode);

CREATE INDEX runtime_checkpoints_namespace_idx
  ON runtime_checkpoints(namespace, completed_at, updated_at, id);
CREATE INDEX operational_state_namespace_idx
  ON operational_state(namespace, updated_at, key);

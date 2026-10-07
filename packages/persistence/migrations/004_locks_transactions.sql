CREATE TABLE resource_lock_counters (
  resource_identity TEXT PRIMARY KEY,
  current_token INTEGER NOT NULL CHECK (current_token >= 0)
);

ALTER TABLE resource_locks ADD COLUMN canonical_target_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE resource_locks ADD COLUMN lease_id TEXT;

CREATE INDEX resource_locks_lease_idx ON resource_locks(lease_id);
CREATE INDEX resource_locks_expiry_idx ON resource_locks(expires_at);

ALTER TABLE transactions ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transactions ADD COLUMN preview_evidence TEXT;
ALTER TABLE transactions ADD COLUMN lock_lease_id TEXT;
ALTER TABLE transactions ADD COLUMN error TEXT;
ALTER TABLE transactions ADD COLUMN completed_at TEXT;

ALTER TABLE transaction_changes ADD COLUMN change_id TEXT;
ALTER TABLE transaction_changes ADD COLUMN kind TEXT;
ALTER TABLE transaction_changes ADD COLUMN target TEXT;
ALTER TABLE transaction_changes ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE transaction_changes ADD COLUMN atomic INTEGER NOT NULL DEFAULT 1 CHECK (atomic IN (0, 1));
ALTER TABLE transaction_changes ADD COLUMN prepared_json TEXT;
ALTER TABLE transaction_changes ADD COLUMN result_json TEXT;
ALTER TABLE transaction_changes ADD COLUMN verification_json TEXT;

CREATE INDEX transactions_owner_idx ON transactions(owner_id, created_at);
CREATE INDEX transactions_state_idx ON transactions(state, updated_at);

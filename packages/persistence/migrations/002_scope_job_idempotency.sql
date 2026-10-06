DROP INDEX jobs_idempotency_key_unique;

CREATE UNIQUE INDEX jobs_idempotency_identity_key_unique
  ON jobs(principal_id, client_id, COALESCE(workspace_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

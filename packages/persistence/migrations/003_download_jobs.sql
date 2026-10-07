CREATE TABLE download_jobs (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  input_json TEXT NOT NULL,
  destination TEXT NOT NULL,
  partial_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX download_jobs_namespace_updated_idx
  ON download_jobs(namespace, updated_at);

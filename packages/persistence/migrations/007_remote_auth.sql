CREATE TABLE oauth_clients (
  client_key TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'trusted', 'disconnected')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  disconnected_at TEXT,
  UNIQUE (issuer, subject, oauth_client_id)
);

CREATE TABLE oauth_authorization_requests (
  request_id TEXT PRIMARY KEY,
  client_key TEXT NOT NULL REFERENCES oauth_clients(client_key),
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision TEXT CHECK (decision IN ('approved', 'denied'))
);

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES oauth_authorization_requests(request_id),
  client_key TEXT NOT NULL REFERENCES oauth_clients(client_key),
  redirect_uri TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE oauth_tokens (
  jti TEXT PRIMARY KEY,
  client_key TEXT NOT NULL REFERENCES oauth_clients(client_key),
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT
);

CREATE INDEX idx_oauth_tokens_client ON oauth_tokens(client_key, token_type, revoked_at);

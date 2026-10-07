# Credentials

Secret values must not pass through model-visible tool results. Credential tools create/list/update/delete metadata and return opaque references. The Windows credential manager stores protected material under a namespace that includes the principal, client, and device boundary. Use is authorized against the current persistent grant at the moment an adapter requests a lease.

The redactor fingerprints registered secrets and filters terminal output, audit payloads, health/error data, URLs, and common token/password patterns. URL query parameters such as `token`, `api_key`, `password`, `secret`, and signatures are replaced before audit. Redaction is defense in depth; do not deliberately print, screenshot, OCR, commit, or paste secrets.

Owner tokens and OAuth signing keys live under the dedicated ProgramData data root with restricted ACLs. Backups contain security-sensitive operational state and require equivalent protection. Never commit `.env`, browser profiles, operational databases, backup directories, private keys, owner tokens, or real credential fixtures.

If exposure is suspected: activate Emergency Stop, disconnect affected clients, run security reset to rotate the epoch and invalidate tokens/grants, rotate the external credential at its provider, inspect redacted audit history, and only then authorize a new client.

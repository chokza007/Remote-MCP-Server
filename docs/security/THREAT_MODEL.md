# Threat Model

Protected assets include the Windows account's accessible files, process/service control, browser sessions, credentials, privileged-broker authority, grant/token material, audit integrity, and user project content. Trust boundaries are the remote HTTPS proxy, OAuth client, MCP session, model/tool boundary, local adapters, helper processes, SQLite state, Windows credential manager, interactive desktop, and LocalSystem broker.

Primary threats and controls:

- Impersonation or session swapping: stable principal/client/device binding, signed tokens, PKCE, exact issuer/audience, session identity checks, restricted proxy origin.
- Stolen/replayed authority: signed persistent grants tied to security epoch; short-lived broker capabilities, payload hashes, one-time nonces, immediate revoke/unlink/reset.
- Prompt injection from content: typed untrusted-content wrappers and a rule that files/web/OCR output are data, never control instructions.
- Path escape or destructive scope: canonical targets, ADS/root rejection, allowed roots, symlink/TOCTOU revalidation, atomic commits, explicit permanent-delete semantics, recycle and recovery.
- Network pivot/SSRF: URL normalization, DNS resolution and pinned addresses, private/link-local/loopback blocking unless explicitly policy-authorized, redirect revalidation, size/time limits.
- Secret disclosure: Windows credential boundary, opaque references, centralized redaction, sanitized audit targets, restricted data-root ACLs.
- Resource exhaustion: request/archive/search/job/output/concurrency limits, cancellation, timeouts, bounded logs and SQLite error normalization.
- Silent capability fraud: runtime inventory, health/self-test evidence, acceptance tests, and explicit optional-unavailable status.

Residual risks include compromise of the authorized Windows account, malicious software already running as that user/administrator, supply-chain compromise, screen observation, and incorrect owner authorization. Full Access intentionally has a large blast radius. Maintain backups, patch dependencies, restrict network exposure, protect the owner token, review audit logs, and know the Emergency Stop path.

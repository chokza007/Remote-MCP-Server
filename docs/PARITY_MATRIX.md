# Capability Parity Matrix

Status reflects implemented behavior at release verification. `PASS` means automated behavior exists and is covered. `CONDITIONAL` means the adapter is implemented but the host must provide hardware/software or a human-only boundary.

| Master area | Status | Evidence / boundary |
|---|---|---|
| A whole-machine list/read/search | PASS | Filesystem and progressive search acceptance on explicit roots; Windows ACL still applies. |
| B create/patch/copy/move/rename/hash/recycle/delete | PASS | Atomic/recoverable adapter and mutation integration/security tests. |
| C PowerShell/Python/interactive terminal | PASS | PTY create/send/read/resize/control/close and orphan reconciliation tests. |
| D long jobs/reconnect/recovery | PASS | SQLite durable job/events/logs/checkpoints and restart acceptance. |
| E process/service/port control | PASS | Identity-safe process termination, service backend, port discovery integration. Admin service changes may require broker. |
| F image/PDF/DOCX/XLSX | PASS | Inspect/extract/render/OCR/convert plus source-preserving DOCX replace and XLSX update acceptance. |
| G filename/content/regex/progressive/cancel | PASS | Search state/results persistence, bounds, cancellation/resume tests. |
| H policy/approval/replay defense | PASS | Persistent grant and payload-bound optional approvals; altered command cannot replay. |
| I secret redaction | PASS | Fingerprint/pattern redaction in tool, log, health, audit security tests. |
| J project discovery, proposal-only boundary | PASS | Project guidance discovery and no project-body persistence contract. |
| K audit/checkpoint/reconnect | PASS | Chained audit integrity, operational checkpoints, persistent state tests. |
| L GUI/browser | CONDITIONAL | Real adapters and integration tests; requires interactive unlocked desktop and supported browser. Secure desktop/CAPTCHA/MFA remain human. |
| Persistent Full Access lifecycle | PASS | Grant once, reconnect/restart persistence, revoke/Emergency Stop acceptance. |
| Administrator broker without repeat UAC | CONDITIONAL | Signed capability and service tests pass; one-time elevated install is required on the target host. |
| Windows reboot continuation | CONDITIONAL | Signed two-stage suite reconnects to MCP and performs a grant-authorized mutation; disruptive live reboot runs only with explicit system-test switch. |

The canonical machine-readable list is `config/tool-inventory.v1.json`, generated from the running MCP `tools/list` response. `docs/TOOL_INVENTORY.md` is its human-readable form. A release must fail if required core capabilities are unavailable; conditional capabilities must never be silently converted to PASS.

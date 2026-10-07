# Changelog

## Unreleased

- Fixed the Windows scheduled-task runner so the MCP server always starts from `ProjectRoot` instead of inheriting `C:\Windows\System32`.
- Fixed service-data ACL setup for Windows account names containing spaces, switched grants to language-neutral SIDs, and made ACL failures stop installation.

## 0.1.0 - 2026-10-08

- Initial universal Windows Remote MCP server with Streamable HTTP, OAuth/PKCE, persistent Full Access grants, dark owner console, immediate revoke/disconnect, Emergency Stop, and security reset.
- Added 177 runtime-enumerated tools spanning filesystem, search, terminals, processes/services/ports, durable jobs, transactions, schedules/watches, Git, network/downloads, archives, media, documents/OCR/DOCX/XLSX updates, GUI, browser, credentials, artifacts, checkpoints, health, and audit-aware operational state.
- Added optional signed privileged broker and persistent Windows startup task.
- Added central limits, SSRF and path hardening, untrusted-content provenance, secret redaction, integrity-checked backup/restore, fault/security suites, and project-owned memory boundary.
- Added Thai user documentation, developer onboarding, generated tool inventory, parity matrix, acceptance evidence, opt-in reboot continuation suite, and release verifier.

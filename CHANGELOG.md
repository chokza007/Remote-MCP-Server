# Changelog

## Unreleased

- Added an offline owner-only PowerShell command to clear Emergency Stop and health-check restart the scheduled service; hardened the paired stop/reset scripts against missing ProgramData environment values. Added isolated tests for recovery, idempotency and grant/epoch preservation.
- Added a tested pre-install broker signing-key and signed-authorization-snapshot preparation utility, while keeping production administrator dispatch disabled until signed snapshot synchronization and broker transport integration pass end-to-end tests.

- Hardened Privileged Broker installer, status, and uninstall Windows known-folder paths against unset `ProgramData`/`ProgramFiles` variables; added path regression tests. Clarified that a production signed authorization snapshot, key provisioning, secure MCP dispatch, and explicit elevated first installation remain required, and documented how Emergency Stop must be respected.

- Clarified account migration: a new ChatGPT account can reuse a permitted existing Tunnel without rotating the Platform runtime key; if its Platform organization cannot access the existing Tunnel, create a new Tunnel/key and update only the local tunnel-client and new ChatGPT plugin, not the Windows MCP installation.

- Documented new-chat versus new-ChatGPT-account reconnect procedures in the Thai setup/quickstart guides and explicitly identified the current Local Tunnel static-header identity limitation, which can share an existing Full Access grant across accounts allowed into the same Tunnel; account-specific isolation remains unverified and needs separate implementation/tests.

- Fixed the service installer, service status script, and Full Access enrollment script default database paths when the `ProgramData` environment variable is empty; added Windows regression tests and clarified copy/paste owner approval, new-machine prerequisites, and independent ChatGPT safety restrictions in the Thai first-run and troubleshooting guides.
- Added a one-command `เปิดใช้งานระบบ.ps1` recovery/start flow and simplified Thai first-install versus later-start instructions for non-developer users.
- Fixed tunnel-client installation when a previous interrupted run left an empty `VERSION.txt`.

- Added automatic installation and SHA-256 verification of the latest official OpenAI `tunnel-client`, with `tools\tunnel-client` as the project-wide default location.
- Fixed Windows PowerShell 5.1 default project-path resolution for service, tunnel-client, and reboot acceptance scripts.
- Added a Thai first-run and ChatGPT Secure MCP Tunnel guide, including the correct Tunnel connection flow and troubleshooting for the raw MCP endpoint.
- Added an elevated local-owner command that binds a pending ChatGPT identity to persistent `computer:*` Full Access once, with an integration test covering persistence.
- Fixed a Windows process-termination race by waiting for the exact process identity to disappear before reporting termination complete.
- Fixed the Windows scheduled-task runner so the MCP server always starts from `ProjectRoot` instead of inheriting `C:\Windows\System32`.
- Fixed service-data ACL setup for Windows account names containing spaces, switched grants to language-neutral SIDs, and made ACL failures stop installation.

## 0.1.0 - 2026-10-08

- Initial universal Windows Remote MCP server with Streamable HTTP, OAuth/PKCE, persistent Full Access grants, dark owner console, immediate revoke/disconnect, Emergency Stop, and security reset.
- Added 177 runtime-enumerated tools spanning filesystem, search, terminals, processes/services/ports, durable jobs, transactions, schedules/watches, Git, network/downloads, archives, media, documents/OCR/DOCX/XLSX updates, GUI, browser, credentials, artifacts, checkpoints, health, and audit-aware operational state.
- Added optional signed privileged broker and persistent Windows startup task.
- Added central limits, SSRF and path hardening, untrusted-content provenance, secret redaction, integrity-checked backup/restore, fault/security suites, and project-owned memory boundary.
- Added Thai user documentation, developer onboarding, generated tool inventory, parity matrix, acceptance evidence, opt-in reboot continuation suite, and release verifier.

# Acceptance Report

Release candidate: `v0.1.0`  
Verification date: 2026-10-08 (Asia/Bangkok)  
Verified source: Task 26 release commit and annotated `v0.1.0` tag (resolve with `git rev-list -n 1 v0.1.0`)  
Runtime inventory: schema 1, server 0.1.0, 177 tools generated through MCP `tools/list`

## Automated evidence

The release verifier runs inventory regeneration, TypeScript typecheck, production build, unit, contract, integration, security, fault, acceptance, and capability self-test coverage. Acceptance scenarios include filesystem/search/terminal operations, DOCX/XLSX source-preserving updates, one persistent grant across database restart, Emergency Stop persistence, immediate revoke, unattended durable jobs across restart, authorization recheck before the next job step, runtime parity inventory, required documents, dark consent UI, remote OAuth reconnect, and server restart.

Final release verification: **68 test files passed; 224 tests passed and 1 explicitly optional-environment test skipped (225 total)**. Typecheck, production build, four acceptance files (5 scenarios), runtime inventory generation, and the required core capability self-test all passed. The self-test finished as a durable verified job. Dark-theme verification covers both browser pages and the visible Windows GUI fixture. This report must not claim a machine capability that health marked unavailable.

## System-dependent evidence

The two-stage reboot scripts use a signed state file and one-shot startup continuation. Their non-disruptive prepare/continue path reconnects to the loopback MCP endpoint as the persisted principal/client, verifies `authorization_status=granted`, and performs a harmless filesystem mutation without a second approval. A physical reboot is intentionally opt-in with `REMOTE_MCP_AUTHORIZED_REBOOT_TEST=1` and `-Reboot`; it was not forced on the user's active desktop merely to make a report green.

GUI/browser/broker capabilities are conditional on an interactive desktop, supported browser, .NET, elevation, and installation state. Unit/integration/security tests verify their protocols and policy boundaries. Secure desktop, UAC installation, CAPTCHA, MFA, and third-party consent remain human boundaries.

## Release decision

Core gateway, persistence, authorization, audit, filesystem, terminal, job, recovery, project isolation, and release documentation are mandatory. The release is accepted only when `scripts/release/verify.ps1` exits zero and `git status --short` shows only intentional release metadata. Optional unavailable capabilities must be reported by health and the parity matrix, never silently skipped.

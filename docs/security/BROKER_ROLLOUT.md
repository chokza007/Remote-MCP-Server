# Privileged Broker production rollout status

Updated: 2026-10-08 (Asia/Bangkok)

## Current verification (do not claim production-ready)

- Broker source, Windows Service installer, .NET 10 SDK, and an isolated broker integration test exist.
- Production deployment must check that the broker is actually installed and that the setup shell is elevated; neither status should be assumed from the MCP grant.
- Check `security/emergency_stop` through the approved read-only owner diagnostics before rollout. If active, stop and obtain explicit owner consent before clearing it; never bypass it via a different tool. Do not publish device-specific event timestamps or state in this repository.
- Production `apps/server` currently does **not** call `createCapabilityTokenService`, produce a signed broker authorization snapshot/public key for deployment, or dispatch privileged requests through `BrokerClient`. Those APIs appear only in the isolated broker test and control-plane library. Installing the Windows Service by itself therefore does **not** make MCP administrator commands functional.
- Do not invent public keys, unsigned snapshots, or identity headers; do not use a fake `authorization.json` to make the service show Running.

## Before attempting administrator installation

1. Confirm the owner intends to turn off Emergency Stop; use the normal owner recovery flow only after explicit approval.
2. Implement and test trusted, DPAPI-protected ECDSA P-256 key provisioning (persisted signing key); export its **public** key without exposing private material.
3. Produce a signed, atomically written authorization snapshot from the **live** grant database, and synchronize it whenever grants, device state, security epoch, and Emergency Stop change. Test immediate revocation and anti-rollback across process/server restart. A stale snapshot must never authorize a newly revoked grant.
4. Wire the production MCP server to issue short-lived, action/target/payload/caller-SID-bound capability tokens and send supported administrator actions over the authenticated local named pipe. Never add an unrestricted shell verb as a default shortcut.
5. Make readiness depend on a real pipe handshake and a harmless authorized end-to-end operation, not just service status. Add acceptance tests for deny-before-approval, replay, revocation, Emergency Stop, wrong SID and rejected signatures.
6. Prepare a supported **one-time administrator installation** using the real generated snapshot and public key, with explicit owner UAC consent and rollback. Check that existing Windows paths and credentials are protected, and never surface tokens to ChatGPT.
7. After deployment, check `scripts/broker/status.ps1`, then an actual approved operation, audit redaction, and revocation. Do not run the full release test suite against the live server without protecting service availability.

## Correct operator expectation

- `authorization_status=granted` only confirms the MCP grant.
- `privileged.broker=unavailable` means administrator broker functionality is **not** available through MCP.
- A separate Administrator PowerShell session can still be used by the owner for explicit one-off setup operations.
- The permanent broker installation must not bypass Windows UAC at first install or platform safety controls.

## Regression coverage

`tests/integration/service/broker-script-paths.test.ts` verifies that Broker install/status/uninstall default to Windows known folders when `ProgramData` and `ProgramFiles` environment variables are absent.

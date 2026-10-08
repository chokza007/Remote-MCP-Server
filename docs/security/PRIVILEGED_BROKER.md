# Privileged Broker

The optional Windows service performs narrowly described administrator operations after a one-time elevated installation. It runs as LocalSystem on a local named pipe whose ACL is restricted to SYSTEM, Administrators, and the configured caller SID. Installation requires an explicit Administrator PowerShell session and is never performed invisibly.

Each request carries a short-lived signed capability containing issuer/audience, principal/client/device/grant, security epoch, action, canonical target, payload hash, issued/expiry times, and nonce. The broker verifies the signature, exact payload hash, nonce freshness, caller SID, current signed authorization snapshot, grant revocation state, and Emergency Stop before dispatch. It logs a redacted result. A valid persistent grant avoids repeated UAC prompts after the broker is installed; it does not grant arbitrary callers access.

**Production deployment is not yet wired end-to-end.** The existing installer requires a genuine signed authorization snapshot and its corresponding public key. The server currently does not export those values or route administrator tool requests through the production broker, so running the installer alone must not be represented as full administrator capability. See [production rollout blockers and acceptance plan](BROKER_ROLLOUT.md). Keep Emergency Stop in force until the owner explicitly authorizes clearing it.

After production signing, snapshot synchronization and dispatch have been implemented and verified, use an explicit elevated Administrator session to install:

```powershell
.\scripts\broker\install.ps1 -AuthorizationStatePath <path> -PublicKey <base64-public-key>
.\scripts\broker\status.ps1
```

Use `scripts\broker\uninstall.ps1` to stop and delete the service. Rotating the security epoch or revoking the underlying grant invalidates new capabilities. Never loosen the pipe ACL, accept unsigned snapshots, reuse nonces, log capability tokens, or add a generic unrestricted shell verb to the broker.

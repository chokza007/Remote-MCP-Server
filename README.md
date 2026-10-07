# Remote-MCP-Server

Universal, project-agnostic Windows MCP infrastructure that lets an authenticated ChatGPT/MCP client work on the computer through filesystem, search, terminal, processes, durable jobs, browser, GUI, documents, media, Git, schedules, and operational controls.

The authorization model is **grant once, trusted until revoked**. After the owner approves a Full Access grant, covered actions do not create per-command approval popups. The grant survives a new chat, reconnect, server restart, and Windows restart because it is bound to the authenticated principal/client and this device. Revocation, Emergency Stop, device unlink, or a security reset blocks new work immediately.

This is powerful software. Full Access removes approval friction; it does not bypass Windows ACLs, secure desktop, CAPTCHA/MFA, unavailable software, or the server's safety limits. Important operations remain audited and secrets are redacted.

## Quick install on Windows

Requirements: Windows 10/11, PowerShell 5.1+, Git, Node.js `>=24.15 <25`, and npm. Python, FFmpeg, Edge/Chrome, and .NET 8 are optional capabilities detected by health checks.

Open PowerShell:

```powershell
git clone https://github.com/chokza007/Remote-MCP-Server.git E:\Remote-MCP-Server
Set-Location E:\Remote-MCP-Server
npm ci
npm run build
npm test
```

For a persistent startup task, open **PowerShell as Administrator** once:

```powershell
Set-Location E:\Remote-MCP-Server
.\scripts\service\install.ps1
```

The local MCP endpoint is `http://127.0.0.1:7331/mcp`. The service installer writes the owner token and OAuth signing key under `%ProgramData%\Remote-MCP-Server` with restricted ACLs; do not paste those secrets into chat or commit them. For remote web access, terminate TLS at a trusted reverse proxy and reinstall with `-PublicOrigin https://your-host.example`.

To develop without installing the service:

```powershell
npm run dev
```

## Connect and grant once

Register the Streamable HTTP MCP endpoint in the client. On first connection, choose **Grant Full Access to This Computer** in the dark owner consent page. Reconnects from the same authenticated principal/client reuse the existing grant. The owner console lists trusted clients and supports disconnect/revoke.

The exact 177-tool catalog and schemas are generated in [docs/TOOL_INVENTORY.md](docs/TOOL_INVENTORY.md). Start with the Thai guides: [Quickstart](docs/THAI_QUICKSTART.md) and [User guide](docs/THAI_USER_GUIDE.md).

## Update

```powershell
Set-Location E:\Remote-MCP-Server
git pull --ff-only
npm ci
npm run build
npm test
Restart-ScheduledTask -TaskName RemoteMcpServer
```

Back up operational state before a major update:

```powershell
.\scripts\operations\backup.ps1 -DataRoot "$env:ProgramData\Remote-MCP-Server" -DestinationRoot "D:\Remote-MCP-Backups"
```

## Stop, revoke, reset, and uninstall

Emergency stop persists in the database and stops the service task:

```powershell
.\scripts\operations\emergency-stop.ps1 -Force
```

Use the owner console for a single-client revoke. Use `scripts\operations\security-reset.ps1` only to invalidate every grant/token/session after a security incident. Uninstall the startup task with:

```powershell
.\scripts\service\uninstall.ps1
```

The uninstall script does not silently erase operational data. Back up, inspect, and remove the dedicated data directory separately if that is truly intended.

## Architecture and project boundary

`Remote-MCP-Server` is an infrastructure/tool layer. It stores only operational state such as sessions, grants, job IDs, approvals, schedules, audit records, and artifact path references. Project overview, workflow, research, history, checkpoints, and production status remain inside each project. The MCP can discover/read/update a project's own guidance but must never centralize that content in its database.

Before changing code, read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Detailed references:

- [Data flow](docs/architecture/DATA_FLOW.md) and [operations](docs/architecture/OPERATIONS.md)
- [Authorization](docs/security/AUTHORIZATION.md), [credentials](docs/security/CREDENTIALS.md), [broker](docs/security/PRIVILEGED_BROKER.md), and [threat model](docs/security/THREAT_MODEL.md)
- [Parity matrix](docs/PARITY_MATRIX.md), [acceptance report](docs/ACCEPTANCE_REPORT.md), and [troubleshooting](docs/TROUBLESHOOTING.md)

## Verification

```powershell
.\scripts\release\verify.ps1
```

The verifier regenerates the runtime inventory, type-checks, builds, and runs the complete test suite. Hardware-dependent GUI/browser/broker and a real Windows reboot are explicitly reported rather than silently treated as passed. See [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md).

## License and support

No license grant is implied unless a `LICENSE` file is added. Use the GitHub issue tracker with redacted logs; never upload tokens, credentials, private files, or the operational database.

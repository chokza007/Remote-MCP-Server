# Operations Architecture

The server is designed for unattended hours-long work. The Windows scheduled task starts at logon, has no execution time limit, restarts on failure, and points at a dedicated `%ProgramData%\Remote-MCP-Server` data root. After a reboot, core automation resumes when the authorized Windows account signs in; the reboot acceptance continuation uses the same logon boundary and waits for the MCP endpoint. The Node service owns the MCP gateway and operational database; optional Python, PowerShell UI Automation, FFmpeg, Git, browser, and privileged-broker components are discovered independently.

Durable work is represented as jobs with dependency-ordered, idempotent steps, event streams, bounded logs, heartbeats, process identity, and verification evidence. Jobs do not depend on an open browser/chat connection. Schedules and watches store only operational definitions and recheck the original grant before dispatch. Resource locks and transaction recovery prevent overlapping unsafe mutations.

Health reports `healthy`, `degraded`, or `unavailable` capability states. Required core failures block release. Optional dependencies remain usable when present and are explicitly reported when absent. The release verifier regenerates tool inventory, checks types/build/tests, scans for obvious committed secret material, and validates required documentation.

Backups stop the scheduled task briefly, copy the dedicated data root, hash every file, and write a manifest before atomically publishing the backup directory. Restore verifies every size/hash before replacing state. Emergency Stop is a persistent database flag plus service stop. Security reset rotates the security epoch and invalidates grants, tokens, sessions, and pending approvals.

Never use the operational database as project memory. Artifact records reference canonical paths and lineage; large/user-owned content stays at its source. Logs and database files need the same access protection as the Windows account because they reveal filenames, job history, and operational metadata even after values are redacted.

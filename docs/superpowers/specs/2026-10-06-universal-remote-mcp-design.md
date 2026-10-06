# Universal Remote MCP Server — Architecture Design

**Date:** 2026-10-06  
**Status:** Approved in conversation; written-spec review pending  
**Target:** `E:\Remote-MCP-Server`  
**Platform:** Authorized Windows workstation  

## 1. Authority and source of truth

The implementation must follow this precedence order:

1. The user's current explicit request and safety boundaries.
2. `docs/specs/REMOTE_MCP_FULL_CAPABILITY_SPEC.md` (the Master Spec).
3. `docs/specs/USER_APPROVAL_AND_EXTENSIONS_TH.txt` (approved additions and execution authority).
4. `docs/specs/PROJECT_AGNOSTIC_CLARIFICATION_TH.md` (final project-boundary clarification).
5. This architecture design.
6. The implementation plan and source code.

The two source documents are preserved verbatim inside the project. This is a new implementation. Existing MCP servers and Desktop Commander are compatibility references only; their architecture and source code are not reused.

## 2. Product goal

Build a self-hosted remote MCP server that lets an authorized ChatGPT session operate an authorized Windows workstation through a complete, observable, recoverable workflow:

`OBSERVE → UNDERSTAND → PLAN → ACT → WATCH RESULT → VERIFY → FIX → CONTINUE`

The server must provide broad workstation capability without silently weakening the Master Spec. Potentially dangerous operations are not permanently blocked when a safe approval flow is possible; they are routed through an exact, expiring Approval Gate.

The server is a universal, project-agnostic infrastructure/tool layer. It exposes capabilities and operational continuity; it does not own or impose any project's knowledge, memory, rules, production process, or workflow.

### Core outcomes

- Full-machine filesystem, search, terminal, process, service, port, system, Git, network, archive, media, rich-document, GUI, and browser capabilities.
- Durable jobs that continue through HTTP or chat disconnects and reconcile after server restart.
- Persistent operational state, runtime checkpoints, artifacts, watches, schedules, transactions, resource locks, and notifications.
- Remote Streamable HTTP access with secure authentication and an HTTPS deployment path.
- Clear, versioned tool schemas; structured errors; audit logs with secret redaction.
- Thai-first user documentation plus precise technical references.

## 3. Scope boundaries

### In scope

- One authorized Windows machine per server installation.
- Multiple explicit workspaces/projects on that machine.
- Both synchronous tools and asynchronous durable operations.
- Local testing and opt-in remote HTTPS deployment.
- GUI and browser automation with semantic methods first and coordinate fallback.
- Package installation and system-administration workflows behind approval and OS privilege checks.

### Project-agnostic boundary

Project knowledge belongs inside the project that owns it. This includes project overviews, billboards, checklists, `WORK_CHECKPOINT.md`, project history, project-specific workflows and rules, research, sources, and production status. For example:

```text
E:\Project-A\WORK_CHECKPOINT.md
E:\Project-A\PROJECT_OVERVIEW.md
E:\Project-A\docs\...
```

The MCP must not create a parallel knowledge tree such as `E:\Remote-MCP-Server\memory\Project-A\...`.

The server may provide neutral helpers to discover, read, and update files such as `README`, `PROJECT_OVERVIEW`, `WORK_CHECKPOINT`, rules, and workflow documents. Those helpers are filesystem/discovery tools only: the source of truth and file contents remain in the target project. When ChatGPT enters a new project, the MCP helps locate these files and the client decides how to interpret them.

Persistent MCP state is limited to operational data: authenticated sessions, running job IDs, pending approvals, process tracking, watches, schedules, audit history, runtime recovery data, and artifact references/path mappings. Every record is explicitly namespaced by principal, workspace, and/or session as appropriate so Project A cannot leak into Project B.

### Inherent platform boundaries

- Windows secure desktop and some UAC prompts may require visible human confirmation; a non-elevated service cannot reliably automate the secure desktop.
- DRM-protected surfaces, protected applications, CAPTCHA, and MFA may require user interaction.
- Sleep, shutdown, and power loss pause active work. Persisted jobs reconcile after boot; uninterrupted restart recovery requires an approved service or scheduled-start installation.
- The server operates with the rights of its Windows account unless the user explicitly approves elevation.

These are runtime constraints, not reasons to omit the associated tools.

## 4. Technology decisions

### Primary stack

- **Runtime:** Current Node.js LTS on Windows.
- **Language:** TypeScript with strict compiler settings.
- **MCP:** Official Model Context Protocol TypeScript SDK.
- **Transport:** Streamable HTTP as the primary transport; stdio retained for local diagnostics and compatibility.
- **Persistence:** SQLite in WAL mode with migrations, foreign keys, busy timeouts, and periodic integrity checks.
- **Validation:** JSON Schema-compatible runtime validation generated from typed schemas.
- **Testing:** Unit, integration, contract, fault-injection, and harmless end-to-end acceptance suites.

### Focused helpers

- PowerShell/.NET helpers for Windows-native operations, services, registry, UI Automation, credentials, and system discovery.
- Python helpers only where the document/media ecosystem is materially stronger.
- FFmpeg/ffprobe, Git, 7-Zip, LibreOffice, and browser engines are capability-detected rather than assumed.
- ConPTY through a maintained pseudo-terminal adapter for truly interactive terminal sessions.

Helpers communicate with the TypeScript service through versioned JSON messages. They never become independent policy authorities.

## 5. High-level architecture

```text
ChatGPT / MCP client
        │ Streamable HTTP + authenticated MCP
        ▼
┌─────────────────────────────────────────────────────────┐
│ MCP Gateway                                             │
│ session • workspace • schemas • rate/size limits       │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Control Plane                                           │
│ policy • approval gate • credential broker • audit     │
│ transactions • locks • state • artifacts • scheduler   │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Execution Plane                                         │
│ filesystem/search • terminal/process • Git/system      │
│ network/archive/media/docs • GUI • browser             │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Durable Runtime                                         │
│ jobs • events • logs • watches • notifications         │
│ reconciliation • recovery • health/self-test           │
└──────────────────────────┬──────────────────────────────┘
                           ▼
             Windows OS / applications / browsers
```

The Control Plane is separate from tool adapters. No adapter can bypass workspace validation, policy classification, approval checks, secret redaction, audit logging, resource locking, or transaction rules.

## 6. Repository layout

```text
E:\Remote-MCP-Server
├─ apps/
│  ├─ server/                 MCP gateway and composition root
│  └─ worker/                 durable execution worker
├─ packages/
│  ├─ contracts/              schemas, errors, versions
│  ├─ control-plane/          policy, approval, audit, redaction
│  ├─ persistence/            SQLite repositories and migrations
│  ├─ runtime/                jobs, events, locks, scheduler
│  ├─ adapters/               capability adapters
│  └─ test-support/           safe fixtures and fault injection
├─ helpers/
│  ├─ powershell/
│  └─ python/
├─ config/
├─ scripts/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ contract/
│  └─ acceptance/
├─ docs/
│  ├─ specs/
│  ├─ architecture/
│  ├─ security/
│  ├─ operations/
│  └─ superpowers/specs/
└─ var/                       ignored runtime database/log/artifact data
```

## 7. MCP gateway and tool contracts

Every tool definition contains:

- Stable tool name and semantic version.
- Input and output schemas.
- Capability category and permission tier.
- Whether `dry_run` is supported or mandatory before execution.
- Whether approval, locking, transactions, or durable execution may be required.
- Size, timeout, cancellation, and pagination behavior.
- Examples that do not contain secrets.

### Schema lifecycle

- Additive changes remain backward compatible within a major version.
- Deprecated fields/tools include a replacement and removal version.
- Breaking changes require a new major tool version and a compatibility window.
- A capability manifest exposes versions, availability, dependencies, and degraded states.
- Contract tests compare runtime registration against the checked-in manifest.

### Structured errors

All tool failures return the following stable fields:

```json
{
  "error_code": "RESOURCE_LOCKED",
  "message": "The target is locked by another operation.",
  "retryable": true,
  "suggested_action": "Wait for the reported job or cancel it.",
  "target": "E:\\example\\file.txt",
  "underlying_error": "sanitized diagnostic"
}
```

Stack traces and secrets are excluded from MCP responses. Full sanitized diagnostics remain in the local audit/debug store.

## 8. Sessions, workspaces, and operational state

Each request is bound to:

- An authenticated principal.
- An MCP session.
- An explicit workspace, when the operation is project-scoped.
- A correlation ID and optional transaction/job IDs.

Workspace selection never restricts explicitly authorized full-machine tools, but it prevents accidental relative-path ambiguity. All paths are normalized to canonical Windows paths before policy evaluation.

Persistent MCP state stores only resumable operational facts: active sessions, execution checkpoints, job/process relationships, pending approvals, watches, schedules, safe runtime preferences, audit references, and artifact path mappings. An execution checkpoint describes how the MCP runtime can safely resume an operation; it is not a project status document.

Project goals, task status, research, sources, rules, history, and workflow decisions are never copied into the MCP database as project memory. The database may retain a canonical workspace ID and a reference to a project-owned checkpoint file, but not a shadow copy of its contents. It does not store model chain-of-thought, plaintext secrets, or untrusted instructions as policy.

## 9. Persistence model

SQLite is the authoritative local state store. Principal tables include:

- `schema_migrations`
- `principals`, `sessions`, `workspaces`
- `actions`, `approvals`, `approval_uses`
- `jobs`, `job_steps`, `job_events`, `job_logs`
- `searches`, `search_results`
- `watches`, `watch_events`, `schedules`, `notifications`
- `transactions`, `transaction_changes`, `recovery_points`
- `resource_locks`, `lock_leases`
- `runtime_checkpoints`, `operational_state`
- `artifacts`, `artifact_relations`
- `credential_refs`
- `tool_versions`, `capability_runs`
- `audit_events`

Large logs, screenshots, recovered files, and generated documents live in the artifact store; SQLite records their hashes, metadata, lineage, and retention state.

## 10. Approval Gate

### Classification

- **Tier 0:** Read-only inspection and harmless discovery.
- **Tier 1:** Reversible writes inside an explicit workspace.
- **Tier 2:** Broad, external, destructive, sensitive, credentialed, or machine-level changes; approval required.
- **Tier 3:** Extremely dangerous or irreversible operations; exact approval plus extra preconditions and recovery evidence required. Some operations remain impossible when the OS cannot provide a safe execution path.

### Approval binding

An approval record binds all of the following:

- Canonical action name and schema version.
- Canonicalized payload hash using SHA-256.
- Canonical target set.
- Authenticated principal and MCP session.
- Requested permission tier and action class.
- Creation and expiration time.
- One-time-use nonce.
- Preview, recovery plan, and estimated impact.

Changing any bound field invalidates the approval. Approvals default to one-time use. Optional session-scoped grants are narrow action-class grants with a short expiry and explicit targets; they never become unrestricted permanent grants.

### Client experience

- Clients supporting MCP elicitation receive explicit Allow Once / Deny choices.
- Other clients receive an `APPROVAL_REQUIRED` result and use `approve_action` or `deny_action` with the approval ID.
- Execution always revalidates the request after approval to defeat time-of-check/time-of-use changes.

## 11. Credential Broker and secret handling

- Credential material is stored through Windows Credential Manager or DPAPI-protected storage.
- SQLite stores opaque references and metadata, never plaintext credentials.
- Tools request use of a credential by reference; adapters receive it only for the execution window.
- Creating, replacing, exporting, or deleting credential references requires appropriate approval.
- Command output, logs, URLs, headers, environment values, screenshots metadata, and errors pass through layered secret redaction.
- Known secret values are registered as ephemeral redaction fingerprints without persisting their plaintext.

Untrusted file content, web pages, tool output, and document text can never modify security policy or approve actions.

## 12. Filesystem and search

Filesystem tools support inspect, list, read ranges, create, edit, patch, copy, move, rename, recycle/delete, metadata, hashes, permissions, links, and storage discovery across authorized drives.

Search supports:

- Filename, path, metadata, content, regex, date, size, and file-type filters.
- Native text, structured files, archive members, document extraction, and optional OCR.
- Streaming and paginated results with `search_id`.
- Cancellation, progress, resumability where practical, and durable result storage.
- Explicit inclusion/exclusion and safe limits to avoid runaway scans.

Writes support `dry_run`. Destructive operations prefer recycle/recovery paths and record before/after evidence.

## 13. Transactions, recovery, and resource locks

The transaction API consists of:

- `begin_transaction`
- `preview_changes`
- `commit_transaction`
- `rollback_transaction`

Transactional adapters stage changes or create reversible snapshots before mutation. Operations that cannot be made atomic declare that fact in their preview and require an appropriate approval tier.

Locks use canonical resource identities and expiring leases. Locks prevent conflicting file, workspace, process, browser-profile, and transaction operations. On restart, reconciliation verifies owner liveness, recovers valid leases, and marks stale locks releasable with an audit event.

Recovery points can include file copies, patches, metadata, Git commits/stashes created only inside the controlled workflow, and adapter-specific undo records. Recovery never overwrites unrelated user data silently.

## 14. Terminal, processes, services, and ports

### Interactive terminal

- PowerShell, CMD, Python, and Node sessions run through ConPTY.
- Tools can create sessions, send exact input/control keys, resize, read incremental output, inspect status, and close sessions.
- Output is sequenced and retained with configurable limits.
- Sessions can be promoted to durable jobs when the command is suitable.

### Process and system control

- List, inspect, start, wait, terminate, and tree-terminate processes.
- Inspect and manage Windows services with approval where state changes are sensitive.
- Resolve port listeners and related process identity.
- Inspect OS, CPU, memory, disks, network, environment, runtimes, and installed capability dependencies.
- Broad termination, registry changes, package installs, service installation, firewall changes, and elevation use the Approval Gate.

## 15. Durable jobs

Long-running work returns a `job_id` immediately. The worker records command/specification, state transitions, progress, heartbeats, output offsets, artifacts, dependencies, cancellation requests, and exit evidence.

States are explicit: `queued`, `waiting_approval`, `running`, `paused`, `cancelling`, `succeeded`, `failed`, `cancelled`, `orphaned`, and `needs_attention`.

On restart, reconciliation:

1. Finds jobs previously marked running.
2. Checks persisted process identity, creation time, and command fingerprint.
3. Reattaches when identity is trustworthy.
4. Otherwise marks the job orphaned or restarts only when its declared retry policy permits.
5. Emits a durable event and notification.

No job is silently reported successful without verification evidence.

## 16. Watches, events, scheduler, and notifications

Persisted watch types include:

- `watch_file`
- `watch_directory`
- `watch_process`
- `watch_port`
- `watch_job`
- `watch_log`
- `watch_url`
- list, pause, resume, and cancel operations

Watch adapters use native events where reliable and bounded polling where necessary. Events are deduplicated, sequenced, retained, and associated with sessions/jobs/artifacts.

Schedules support one-time and recurring local-time execution with timezone, misfire policy, overlap policy, and approval classification. A schedule cannot bypass the approval requirements of the action it invokes.

Notifications can target MCP events, local Windows notifications, durable inbox records, and configured outbound adapters. External destinations and credentials require explicit configuration and approval.

## 17. Git, network, archives, media, and rich formats

### Git

Repository discovery, status, diff, log, branch, add, commit, fetch, pull, push, and conflict inspection are supported. Remote mutations and destructive history operations receive higher policy tiers. The server never assumes that unrelated dirty changes belong to it.

### Network and downloads

HTTP tools support headers, auth references, redirects, ranges, resumable downloads, hashes, size limits, cancellation, and durable jobs. TLS verification is enabled by default; disabling it requires exact approval.

### Archives

List, inspect, create, extract, and verify common archive formats. Extraction defends against path traversal, unsafe links, zip bombs, and unexpected overwrite.

### Media

FFmpeg/ffprobe-backed inspection, remuxing, transcoding, trimming, concatenation, frame extraction, metadata removal, audio extraction, and verification preserve requested properties whenever technically possible. Commands and probes become reproducible artifacts.

### Rich documents

Adapters handle images, PDF, DOCX, XLSX, CSV, JSON, XML, Markdown, and plain text. Operations include metadata inspection, text/table extraction, rendering/preview, OCR where configured, conversion, and validation. Original files remain untouched unless mutation is explicitly requested.

## 18. GUI and browser automation

### GUI

The selection order is:

1. Supported application API or CLI.
2. Windows UI Automation semantic selectors.
3. Window-relative image/text targeting.
4. Absolute coordinates as an explicit fallback.

GUI tools inspect desktops/windows/controls, focus, click, type, invoke controls, capture screenshots, wait for conditions, and verify the resulting state. Sensitive-field typing uses the Credential Broker and redacts logs. Secure desktop is reported as requiring user action.

### Browser

Playwright-backed automation supports managed browser profiles, navigation, semantic locators, tabs, downloads/uploads, screenshots, PDFs, DOM/text extraction, network-aware waits, and verification. Profile locks prevent concurrent corruption. Cookies and tokens are never exposed by default. CAPTCHA/MFA pauses with `needs_attention` rather than guessing or bypassing safeguards.

## 19. Artifact Registry and runtime checkpoints

Every meaningful output can be registered as an artifact with:

- Unique artifact ID, type, canonical path or URI, content hash, size, and MIME type.
- Originating session, tool call, job, transaction, and checkpoint.
- Parent/child lineage and transformation metadata.
- Validation status and retention policy.

Runtime checkpoints record only execution intent, completed technical steps, pending approvals, related jobs, artifacts, verification evidence, and safe continuation instructions required to recover the MCP operation. They are namespaced and resumable across chat reconnects and server restarts.

Project-level checkpoints remain project-owned files. A neutral checkpoint helper can locate or edit such a file when explicitly asked, using normal filesystem policy, approval, locking, transaction, and audit controls. The Artifact Registry records only the file reference, hash, lineage, and operational relationship needed for traceability; it does not treat the document's project knowledge as MCP memory.

## 20. Audit and observability

Each action produces correlated audit events for request, policy decision, approval, execution start, progress, result, verification, rollback, and notification. Audit events are append-oriented and hash-linked in batches to detect casual tampering.

Operational telemetry includes:

- Structured rotating logs.
- Health/readiness endpoints that reveal no secrets.
- Queue depth, job latency, failures, retries, lock contention, watch lag, and database health.
- Storage retention and cleanup reports.

`health_report` summarizes the current service state. `capability_self_test` safely exercises dependencies and adapters using isolated fixtures; it never mutates unrelated user data.

## 21. Remote access and authentication

- The default listener binds to loopback only.
- Remote exposure is opt-in and must use HTTPS through a documented reverse proxy or secure tunnel.
- The authentication layer supports a local development token and a production provider interface for OAuth 2.1/PKCE-compatible remote MCP access.
- Tokens are scoped, expiring, revocable, and stored through the Credential Broker.
- Origin, host, request size, timeout, concurrency, and rate limits are enforced at the gateway.
- A deployment guide covers certificate setup, firewall scope, service startup, revocation, backup, update, and recovery.

Installing a Windows service, creating firewall rules, or exposing a public endpoint requires explicit approval at execution time.

## 22. Security model

Key controls are:

- Authenticate every remote request and bind it to a principal/session.
- Canonicalize paths and targets before authorization.
- Separate untrusted content from control instructions.
- Enforce permission tiers and exact approvals centrally.
- Use least privilege and short-lived credential access.
- Redact secrets before storage and response emission.
- Apply bounded I/O, timeouts, cancellation, and concurrency limits.
- Defend archive extraction, URL fetching, redirects, local-network access, and browser profiles.
- Preserve recoverability and provide preview/dry-run for risky changes.
- Record enough evidence to explain what changed without recording sensitive values.

## 23. Test strategy

Development follows test-driven implementation: a failing behavior test is written and observed before production code, then the minimum code makes it pass, followed by refactoring under green tests.

### Test layers

- **Unit:** canonicalization, policy, approval hashes, redaction, state machines, schemas.
- **Contract:** MCP registration, tool schema versions, structured errors, compatibility manifests.
- **Integration:** SQLite migrations/recovery, filesystem fixtures, PTY, jobs, locks, watches, transactions.
- **Adapter:** capability checks with controlled test assets and mocked dangerous edges.
- **Fault injection:** process death, HTTP disconnect, server restart, DB busy, stale lock, partial write.
- **Acceptance:** Master Spec scenarios A–L and the complete parity checklist.
- **Security:** path traversal, prompt-injection separation, credential leakage, approval replay, SSRF, archive bombs.

Acceptance tests use a dedicated fixture root and disposable browser/profile/process resources. Tests do not touch unrelated user files.

## 24. Delivery phases

The implementation proceeds continuously in the user-approved order, with a checkpoint and verification record after every phase:

1. Architecture and repository foundation.
2. Core MCP gateway and contracts.
3. Filesystem and search.
4. Terminal and process control.
5. Persistent jobs and reconciliation.
6. Approval Gate.
7. Git, system, and network.
8. Media, archives, and rich formats.
9. GUI automation.
10. Browser automation.
11. Events, watches, scheduler, notifications.
12. Operational state, runtime checkpoints, artifacts, transactions, locks.
13. Security hardening and redaction.
14. Acceptance and fault-injection suite.
15. Remote HTTPS/authentication deployment path.
16. Documentation, inventory, parity evidence, and release verification.

Failures are fixed before a phase is marked complete. Work stops only for an actual blocker, an action that needs user approval, or a decision that materially changes authorized scope.

## 25. Required documentation and deliverables

The completed repository includes:

- Tool inventory with schemas, versions, tiers, dry-run behavior, and examples.
- Architecture and data-flow documentation.
- Security, Approval Gate, Credential Broker, and redaction documentation.
- Durable jobs, operational state, runtime checkpoints, project-owned checkpoint helpers, transactions, locks, watches, schedules, and artifact documentation.
- Local setup, remote HTTPS setup, operation, backup, restore, update, and troubleshooting guides.
- GUI/browser limitations and recovery guidance.
- Master Spec parity matrix with evidence links.
- Acceptance test report and capability self-test report.
- Thai quick-start and practical user manual.
- Versioned source code and Git history.

## 26. Definition of done

The project is complete only when:

1. The Master Spec and approved additions are represented in the tool inventory or explicitly documented as a verified platform constraint.
2. All required tool schemas are versioned and contract-tested.
3. Approval replay, payload alteration, secret leakage, and untrusted-content policy escalation tests fail safely.
4. A durable job survives client disconnect and reconciles correctly after server restart.
5. Search streaming, interactive terminal, transactions, locks, watches, schedules, runtime checkpoints, project checkpoint discovery helpers, and artifacts pass end-to-end tests.
6. Filesystem, Git, network, archive, media, rich-document, GUI, and browser workflows produce verification evidence.
7. `capability_self_test` and `health_report` accurately report ready, degraded, unavailable, and failed capabilities.
8. Local and remote authenticated connection paths are documented and verified.
9. Master Spec acceptance scenarios A–L pass on safe fixtures.
10. Documentation, parity matrix, acceptance evidence, and all source are committed to Git.

## 27. Thai review summary

เอกสารนี้ยืนยันว่าจะสร้างเซิร์ฟเวอร์ใหม่ใน `E:\Remote-MCP-Server` โดยไม่เอาโค้ดของโปรเจกต์เก่ามาปน ใช้ Master Spec เป็นข้อกำหนดหลัก และเพิ่มระบบสถานะการทำงานถาวร งานเบื้องหลัง การอนุมัติแบบผูกกับคำสั่งจริง การย้อนกลับ การล็อกทรัพยากร การเฝ้าดู การตั้งเวลา คลังผลงาน การจัดการรหัสลับ การแจ้งเตือน GUI และ Browser ตามที่ผู้ใช้กำหนด MCP เป็นเครื่องมือกลางที่ไม่ผูกกับโปรเจกต์: ความรู้ กฎ ประวัติ และ checkpoint ของงานต้องอยู่ในโฟลเดอร์โปรเจกต์นั้นเอง ส่วนฐานข้อมูล MCP เก็บเฉพาะสถานะเชิงปฏิบัติการที่ namespace แยก workspace/session ชัดเจน ทุกงานเสี่ยงต้องแสดงผลกระทบและขออนุมัติแบบเจาะจง ขณะที่งานอ่านข้อมูลทั่วไปทำได้ทันที ระบบต้องพิสูจน์ผลลัพธ์ กู้คืนได้ และทำงานต่อหลังการเชื่อมต่อหลุดหรือเซิร์ฟเวอร์เริ่มใหม่ได้

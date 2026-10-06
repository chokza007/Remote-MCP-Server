# Universal Remote MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for the user-selected Native execution method. Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a project-agnostic Windows Remote MCP server with persistent-until-revoked Full Access, durable operations, broad workstation tooling, GUI/browser control, secure remote access, and complete audit/recovery behavior.

**Architecture:** An official MCP SDK Streamable HTTP gateway authenticates clients and delegates every request through a central control plane before focused adapters touch Windows. SQLite stores only operational state, while a durable worker, optional privileged Windows broker, artifact store, and versioned helper protocols provide restart-safe execution. Project knowledge remains in each project; this server stores only namespaced operational references.

**Tech Stack:** Node.js 24.15.0, npm workspaces, TypeScript 7.0.2 (strict ESM), MCP TypeScript SDK 1.32.1, Zod 4.6.5, SQLite via better-sqlite3 13.0.3, Pino 10.4.0, Vitest 5.0.3, PowerShell 5.1/.NET helpers, Python helpers, Playwright, FFmpeg/ffprobe, Git, and Windows UI Automation.

**Spec:** `docs/superpowers/specs/2026-10-06-universal-remote-mcp-design.md`; authoritative inputs are under `docs/specs/`.

## Global Constraints

- Target Windows 10/11 x64 and Node.js `>=24.15.0 <25`; the checked-in lockfile pins all JavaScript dependencies.
- The service is universal and project-agnostic; project memory, rules, research, history, and workflow documents stay inside their owning project.
- Full Access is persistent until explicit revoke, credential/client cancellation, device unlink, or security reset; it has no automatic short expiry.
- Policy determines the authorization level; a valid covering Full Access Grant satisfies it without per-action human approval.
- Unknown clients are restricted until first-time authorization; Read Only and Ask for Sensitive Actions remain supported modes.
- Every request is authenticated and bound to stable principal, client, server/device, session, and correlation identities.
- The privileged broker has local-only IPC, validates current grants independently, and never exposes an unauthenticated arbitrary-command endpoint.
- SQLite uses WAL, foreign keys, busy timeout, migrations, backups, and integrity checks; no plaintext credential is stored in SQLite or logs.
- Every tool has a stable schema version, structured errors, cancellation/timeout behavior, audit coverage, and explicit `dry_run` behavior.
- Tests use disposable fixture roots, profiles, processes, ports, and databases; no automated test mutates unrelated user data.
- TDD is mandatory: observe the focused test fail before production implementation, then observe it pass before committing.
- Each phase ends with an updated implementation checkpoint, verification evidence, and a focused Git commit.

## Review Focus

1. **Identity continuity and revoke races:** the same authenticated client must retain Full Access across sessions/restarts, while revoke blocks the very next dispatch and job step (Tasks 4, 5, 12).
2. **Windows path ambiguity and destructive targets:** canonicalization must handle UNC, long paths, case, links, alternate data streams, traversal, and drive roots before policy/locking (Tasks 2, 8, 17).
3. **Restart recovery:** durable jobs, PTYs, watches, schedules, locks, and artifacts must reconcile without false success or duplicate side effects (Tasks 10, 12, 18, 19).
4. **Privileged broker trust boundary:** stale epochs, replayed nonces, caller substitution, malformed requests, and disconnected policy state must fail closed (Task 13).
5. **Untrusted content and secret leakage:** file/web/document text cannot become policy, and secrets must be redacted across logs, errors, artifacts, screenshots metadata, and audit (Tasks 6, 20, 25).

---

## File Structure

```text
E:\Remote-MCP-Server
├─ package.json, package-lock.json, tsconfig*.json, vitest.config.ts
├─ apps/
│  ├─ server/src/                 composition root, HTTP/MCP gateway, auth middleware
│  └─ worker/src/                 durable worker and reconciliation loop
├─ packages/
│  ├─ contracts/src/              IDs, schemas, error envelope, tool manifest
│  ├─ control-plane/src/          authorization, policy, audit, redaction, credentials
│  ├─ persistence/src/            SQLite connection, migrations, repositories
│  ├─ runtime/src/                jobs, locks, transactions, watches, schedules, artifacts
│  ├─ adapters/src/               workstation capability adapters
│  └─ test-support/src/           temp fixtures, fake clock, process/browser helpers
├─ helpers/
│  ├─ powershell/                 Windows/UIA/service/broker scripts and modules
│  └─ python/                     rich-document/OCR helpers and locked requirements
├─ broker/                        Windows privileged broker source, installer, protocol
├─ config/                        example and schema-validated configuration
├─ scripts/                       setup, service, backup, acceptance, release scripts
├─ tests/{unit,contract,integration,acceptance,security,fixtures}/
├─ docs/                          specs, plans, operations, security, parity, reports
└─ var/                           ignored databases, logs, artifacts, profiles, recovery
```

### Task 1: Repository and deterministic toolchain

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`
- Create: `apps/server/package.json`, `apps/worker/package.json`
- Create: `packages/{contracts,control-plane,persistence,runtime,adapters,test-support}/package.json`
- Create: `packages/contracts/src/build-info.ts`, `tests/contract/workspace-layout.test.ts`

**Interfaces:**
- Produces: `BuildInfo { name: "remote-mcp-server"; version: string; node: string; schemaVersion: 1 }`
- Produces: `loadBuildInfo(packageJsonPath?: string): Promise<BuildInfo>` from `@remote-mcp/contracts`.

- [ ] **Step 1: Write the failing workspace-layout contract test** asserting all workspaces resolve, ESM imports work, `loadBuildInfo()` returns schema version `1`, and Node major is `24`.
- [ ] **Step 2: Run** `rtk npm test -- tests/contract/workspace-layout.test.ts`; expect FAIL because manifests and `loadBuildInfo` do not exist.
- [ ] **Step 3: Create the npm workspace, strict TypeScript project references, pinned dependencies, scripts (`build`, `test`, `test:acceptance`, `lint`, `typecheck`, `dev`, `start`), and minimal `loadBuildInfo` implementation.**
- [ ] **Step 4: Run** `rtk npm ci`, `rtk npm run typecheck`, and the focused test; expect all PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "build: establish TypeScript workspace"`.

### Task 2: Shared contracts, canonical targets, and structured errors

**Files:**
- Create: `packages/contracts/src/{ids,errors,targets,tools,events,index}.ts`
- Create: `tests/unit/contracts/{errors,targets,tools}.test.ts`

**Interfaces:**
- Produces: branded `PrincipalId`, `ClientId`, `DeviceId`, `SessionId`, `WorkspaceId`, `GrantId`, `JobId`, `ArtifactId`, `CorrelationId`.
- Produces: `canonicalizeTarget(input: TargetInput): Promise<CanonicalTarget>` with `kind`, `canonical`, `display`, and `identityKey`.
- Produces: `ToolErrorEnvelope { error_code; message; retryable; suggested_action; target; underlying_error }` and `toToolError(error, context): ToolErrorEnvelope`.
- Produces: `ToolDescriptorV1` with name/version/risk tier/scope/dry-run/timeout/cancellation metadata.

- [ ] **Step 1: Write failing tests** for drive-letter case, `.`/`..`, UNC, `\\?\` long paths, drive roots, alternate data streams, symlink identity, schema-version rejection, and complete sanitized error fields.
- [ ] **Step 2: Run** `rtk npm test -- tests/unit/contracts`; expect FAIL on missing exports.
- [ ] **Step 3: Implement the branded IDs, canonical target service, tool descriptor schemas, event envelopes, and structured error conversion.**
- [ ] **Step 4: Run** focused tests and `rtk npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: define versioned core contracts"`.

### Task 3: SQLite foundation and migrations

**Files:**
- Create: `packages/persistence/src/{database,migrator,index}.ts`
- Create: `packages/persistence/migrations/001_operational_core.sql`
- Create: `tests/integration/persistence/database.test.ts`

**Interfaces:**
- Produces: `openDatabase(options: DatabaseOptions): OperationalDatabase`.
- Produces: `migrateDatabase(db: OperationalDatabase): MigrationResult`.
- `OperationalDatabase` exposes typed `read`, `writeTransaction`, `integrityCheck`, `backup`, and `close` operations; feature packages consume repositories rather than raw SQL.

- [ ] **Step 1: Write a failing integration test** that opens a temp database, verifies WAL/foreign keys/busy timeout, runs migration twice idempotently, checks required tables, reopens data, creates a backup, and detects a deliberately malformed migration checksum.
- [ ] **Step 2: Run** `rtk npm test -- tests/integration/persistence/database.test.ts`; expect FAIL because the database module is absent.
- [ ] **Step 3: Implement the SQLite wrapper and migration ledger; create tables for identities, grants, approvals, actions, audit, jobs/events/logs, watches/schedules, transactions/locks, runtime checkpoints, artifacts, credentials, tool versions, and capability runs.**
- [ ] **Step 4: Run** the focused test and `rtk npm run typecheck`; expect PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add durable operational database"`.

### Task 4: Device identity and persistent trusted grants

**Files:**
- Create: `packages/control-plane/src/auth/{device-identity,grant-types,grant-repository,grant-service}.ts`
- Create: `tests/unit/control-plane/grant-service.test.ts`
- Create: `tests/integration/control-plane/grant-persistence.test.ts`

**Interfaces:**
- Produces: `GrantMode = "full_access" | "ask_sensitive" | "read_only"`.
- Produces: `GrantService.request(input): GrantRequest`, `grant(requestId, actor): TrustedGrant`, `resolve(identity): GrantResolution`, `revoke(grantId, actor, reason): void`, `rotateSecurityEpoch(actor): number`, `list(filter): TrustedGrantSummary[]`.
- `TrustedGrant` binds principal/client/device/server IDs, scope array, creation evidence, epoch, and nullable revocation fields; `full_access` defaults to no expiry.

- [ ] **Step 1: Write failing tests** for unknown client restriction, one-time Full Access enrollment, wrong client/device rejection, persistence after database close/reopen, no default expiry after simulated weeks, same identity in a new session, revoke-before-next-dispatch, device unlink, and security-epoch reset.
- [ ] **Step 2: Run** both grant test files; expect FAIL because identity/grant services are absent.
- [ ] **Step 3: Implement DPAPI-protected server identity storage, grant repositories, transactional creation/revocation, stable identity matching, epoch rotation, and append-only grant events.**
- [ ] **Step 4: Run** focused tests twice, including a reopened database; expect PASS with no grant plaintext secrets in rows.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: persist trusted full access grants"`.

### Task 5: Central policy engine and optional interactive approval

**Files:**
- Create: `packages/control-plane/src/policy/{action-context,policy-engine,authorization-decision}.ts`
- Create: `packages/control-plane/src/approval/{approval-repository,approval-service}.ts`
- Create: `tests/unit/control-plane/{policy-engine,approval-service}.test.ts`

**Interfaces:**
- Produces: `PolicyEngine.authorize(context: ActionContext): Promise<AuthorizationDecision>`.
- `AuthorizationDecision` is `allow` with grant/controls, `require_approval` with `approvalId`, or `deny` with structured reason.
- Produces: `ApprovalService.request`, `approveOnce`, `deny`, and `consume`; request binding includes action version, canonical payload SHA-256, targets, identity/session, tier, expiry, nonce, preview, and recovery plan.

- [ ] **Step 1: Write failing tests** proving Full Access immediately allows covered Tier 0–3 actions, Read Only denies mutation, Ask Sensitive requests approval only for configured tiers, grant scope mismatch cannot be bypassed, payload mutation/replay fails, revoke wins a dispatch race, and Emergency Stop denies every action.
- [ ] **Step 2: Run** the focused policy/approval tests; expect FAIL.
- [ ] **Step 3: Implement centralized policy evaluation, optional exact approvals, transactional consume, and Emergency Stop state.**
- [ ] **Step 4: Run** focused tests with fake clock and concurrent revoke/dispatch cases; expect PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: enforce persistent authorization policy"`.

### Task 6: Secret redaction and append-oriented audit

**Files:**
- Create: `packages/control-plane/src/security/{redactor,secret-fingerprints}.ts`
- Create: `packages/control-plane/src/audit/{audit-event,audit-repository,audit-service}.ts`
- Create: `tests/unit/control-plane/{redactor,audit-service}.test.ts`

**Interfaces:**
- Produces: `Redactor.registerEphemeral(secret): Disposable`, `redact(value): RedactedValue`.
- Produces: `AuditService.record(event): AuditEventId`, `query(filter): AuditPage`, `verifyChain(range): AuditIntegrityResult`.
- Audit events carry identity, grant/approval, tool/action, canonical targets, timestamps, result, job/session/correlation IDs, and hash-chain fields.

- [ ] **Step 1: Write failing tests** for bearer tokens, API keys, environment values, URL credentials, command arguments, nested JSON, Unicode, multiline output, known secret fingerprints, audit hash-chain tampering, and untrusted text attempting to issue policy instructions.
- [ ] **Step 2: Run** the focused tests; expect FAIL.
- [ ] **Step 3: Implement layered redaction before persistence/response and transactional append-oriented audit batches.**
- [ ] **Step 4: Run** tests and scan the temp database/log output for seeded secrets; expect PASS and zero plaintext hits.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add redacted tamper-evident audit"`.

### Task 7: Core MCP gateway, sessions, and authorization management

**Files:**
- Create: `apps/server/src/{config,context,tool-registry,create-mcp-server,http-server,index}.ts`
- Create: `apps/server/src/tools/{server-info,authorization,health}.ts`
- Create: `config/default.example.json`, `tests/contract/mcp-gateway.test.ts`, `tests/integration/server/session-auth.test.ts`

**Interfaces:**
- Produces: `createMcpServer(deps): McpServer`, `createHttpServer(deps): HttpServerHandle`, and `ToolRegistry.register(descriptor, handler)`.
- Registers `server_info`, `authorization_status`, `request_full_access`, `list_trusted_clients`, `revoke_full_access`, `emergency_stop`, `clear_emergency_stop`, and initial `health_report`.
- Auth middleware produces `RequestIdentity { principalId; clientId; deviceId; sessionId; correlationId }`; enrollment completion requires an authenticated owner/local-control actor, never an untrusted tool call alone.

- [ ] **Step 1: Write failing MCP contract tests** for initialize/list/call, schema versions, session isolation, unknown-client restriction, grant recognition in a new MCP session, revoke rejection, loopback default binding, request-size limits, and structured errors.
- [ ] **Step 2: Run** the gateway/session tests; expect FAIL because the server is not registered.
- [ ] **Step 3: Implement the official SDK Streamable HTTP transport, session/context lifecycle, versioned registry, authentication boundary, core tools, graceful shutdown, and local enrollment control path.**
- [ ] **Step 4: Run** focused tests, start on an ephemeral port, connect an SDK client, and expect all PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: expose authenticated MCP core"`.

### Task 8: Filesystem adapter and safe project discovery

**Files:**
- Create: `packages/adapters/src/filesystem/{contracts,filesystem-adapter,patcher,metadata,project-discovery}.ts`
- Create: `apps/server/src/tools/filesystem.ts`
- Create: `tests/integration/adapters/{filesystem,project-discovery}.test.ts`

**Interfaces:**
- Produces: `FilesystemAdapter` methods `list`, `stat`, `readRange`, `write`, `applyPatch`, `copy`, `move`, `rename`, `recycle`, `remove`, `hash`, `permissions`, and `links` with `dryRun` and cancellation inputs.
- Produces: `discoverProjectGuidance(root): ProjectGuidanceReference[]` for README, PROJECT_OVERVIEW, WORK_CHECKPOINT, rules, and workflow files; returns references only and never copies contents into MCP operational state.

- [ ] **Step 1: Write failing tests** for all methods plus UNC/long paths, case collisions, links escaping fixtures, ADS, roots, existing destinations, partial-write recovery, recycle versus permanent delete, dry-run no-op, cancellation, and project guidance remaining project-owned.
- [ ] **Step 2: Run** filesystem integration tests; expect FAIL.
- [ ] **Step 3: Implement filesystem operations through canonical targets, central policy, locks, atomic temp-file replacement, recovery evidence, bounded ranges, and audit.**
- [ ] **Step 4: Run** focused tests and a fixture-only MCP round trip; expect PASS and no writes outside the fixture root.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add safe full-machine filesystem tools"`.

### Task 9: Streaming search and content extraction

**Files:**
- Create: `packages/adapters/src/search/{search-service,walker,filters,extractors,result-store}.ts`
- Create: `apps/server/src/tools/search.ts`, `tests/integration/adapters/search.test.ts`

**Interfaces:**
- Produces: `SearchService.start(request): Promise<{ searchId: string }>`, `page(searchId, cursor): SearchPage`, `status`, `cancel`, and `resume`.
- `SearchRequest` supports path/name/content/regex/date/size/type/include/exclude/archive/document/OCR filters and explicit limits.

- [ ] **Step 1: Write failing tests** for Unicode filenames/content, regex errors, binary skipping, date/size filters, symlink loops, inaccessible paths, archive members, paginated streaming, cancellation, restart-resumable result access, and bounded runaway scans.
- [ ] **Step 2: Run** search tests; expect FAIL.
- [ ] **Step 3: Implement bounded concurrent traversal, extractor registry, durable search/result records, streaming events, pagination, cancellation, and audit.**
- [ ] **Step 4: Run** focused tests using mixed fixture formats; expect PASS with deterministic ordering.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add durable streaming search"`.

### Task 10: Truly interactive terminal sessions

**Files:**
- Create: `packages/adapters/src/terminal/{pty-adapter,terminal-service,output-buffer}.ts`
- Create: `apps/server/src/tools/terminal.ts`, `tests/integration/adapters/terminal.test.ts`

**Interfaces:**
- Produces: `TerminalService.create`, `send`, `sendControl`, `resize`, `read`, `status`, `close`, and `promoteToJob`.
- Supports PowerShell, CMD, Python, and Node through ConPTY; reads use monotonic output offsets.

- [ ] **Step 1: Write failing tests** for prompts, exact stdin, control keys, resize, Unicode, stdout/stderr ordering, incremental offsets, buffer truncation markers, process exit, cancellation, shell allow/deny policy, and restart reconciliation as `orphaned` rather than false success.
- [ ] **Step 2: Run** terminal tests; expect FAIL.
- [ ] **Step 3: Implement ConPTY-backed sessions with sequenced output, lifecycle tracking, limits, policy checks, redaction, and promotion metadata.**
- [ ] **Step 4: Run** focused tests against all four shells present on the host; unavailable optional shells must report `CAPABILITY_UNAVAILABLE` rather than fail the suite.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add interactive Windows terminals"`.

### Task 11: Processes, services, ports, and system discovery

**Files:**
- Create: `packages/adapters/src/system/{processes,services,ports,discovery,environment}.ts`
- Create: `helpers/powershell/RemoteMcp.System.psm1`, `apps/server/src/tools/system.ts`
- Create: `tests/integration/adapters/system.test.ts`

**Interfaces:**
- Produces: `ProcessService.list/inspect/start/wait/terminateTree`, `WindowsServiceService.list/inspect/start/stop/restart`, `PortService.listeners/resolve`, and `SystemDiscovery.snapshot/capabilities`.

- [ ] **Step 1: Write failing tests** using a disposable child process/service mock/ephemeral listener for process identity, creation-time matching, tree termination, missing PID, protected process errors, port ownership, environment redaction, and capability discovery.
- [ ] **Step 2: Run** system tests; expect FAIL.
- [ ] **Step 3: Implement CIM/.NET-backed inspection and controlled mutations through policy, broker routing, timeout/cancellation, and structured errors.**
- [ ] **Step 4: Run** focused tests as standard user; privileged cases use a fake broker until Task 13.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add process and system controls"`.

### Task 12: Durable jobs and restart reconciliation

**Files:**
- Create: `packages/runtime/src/jobs/{job-types,job-repository,job-service,runner,reconciler,log-store}.ts`
- Create: `apps/worker/src/{worker,reconcile,index}.ts`, `apps/server/src/tools/jobs.ts`
- Create: `tests/integration/runtime/{jobs,reconciliation}.test.ts`

**Interfaces:**
- Produces: `JobService.submit/get/list/events/logs/cancel/retry/pause/resume` and `JobRunner.register(kind, handler)`.
- State union: `queued | waiting_approval | running | paused | cancelling | succeeded | failed | cancelled | orphaned | needs_attention`.
- Every step rechecks current grant/security epoch before dispatch.

- [ ] **Step 1: Write failing tests** for immediate `job_id`, ordered events/log offsets, disconnect continuation, cancellation, idempotency keys, dependency graph, heartbeat loss, process identity reattachment, safe retry policy, revoke between steps, server/worker restart, and never claiming success without verification evidence.
- [ ] **Step 2: Run** job/reconciliation tests; expect FAIL.
- [ ] **Step 3: Implement persistent queues, leases, runners, append logs, heartbeats, reconciliation, current-grant checks, and verification evidence.**
- [ ] **Step 4: Run** focused tests including forced worker termination/restart; expect PASS without duplicate fixture side effects.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add restart-safe durable jobs"`.

### Task 13: Authorized Windows privileged broker

**Files:**
- Create: `broker/src/{Program,BrokerService,NamedPipeServer,RequestVerifier,Handlers,AuditSink}.cs`
- Create: `broker/RemoteMcp.Broker.csproj`, `broker/protocol/v1.schema.json`
- Create: `packages/control-plane/src/broker/{broker-client,capability-token}.ts`
- Create: `scripts/broker/{install,uninstall,status}.ps1`
- Create: `tests/security/broker-protocol.test.ts`, `tests/integration/broker/broker.test.ts`

**Interfaces:**
- Produces: `BrokerClient.execute(request: PrivilegedRequest): Promise<PrivilegedResult>`.
- Protocol v1 binds action, canonical targets, payload hash, nonce, correlation ID, grant ID, current security epoch, issued time, and device signature.
- Broker handlers cover structured service, package, registry, firewall, process, filesystem, and approved privileged-command operations.

- [ ] **Step 1: Write failing protocol/security tests** for valid Full Access, read-only denial, revoked grant, stale epoch, expired capability token, replayed nonce, caller SID mismatch, signature/payload alteration, malformed framing, pipe ACL, broker disconnect, and audit redaction.
- [ ] **Step 2: Run** broker protocol tests and non-elevated integration tests; expect FAIL.
- [ ] **Step 3: Implement the .NET Windows service, restricted named pipe, mutual device authentication, independent grant verification, handler routing, audit, installer, rollback, and Emergency Stop invalidation.**
- [ ] **Step 4: Run** protocol tests; then in the authorized system-test environment install once, execute two distinct covered admin fixture actions without repeated UAC, revoke, verify the next action is denied, and uninstall/reinstall cleanly.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add persistent-authorized privileged broker"`.

### Task 14: Git and workspace-safe repository operations

**Files:**
- Create: `packages/adapters/src/git/{git-adapter,repository-discovery,git-errors}.ts`
- Create: `apps/server/src/tools/git.ts`, `tests/integration/adapters/git.test.ts`

**Interfaces:**
- Produces: `GitAdapter.discover/status/diff/log/branches/add/commit/fetch/pull/push/conflicts` with explicit repository root, dry-run metadata, cancellation, and output limits.

- [ ] **Step 1: Write failing tests** for nested repository discovery, unrelated dirty files, staged/unstaged/untracked states, Unicode paths, detached HEAD, merge conflicts, missing remote/auth, dry-run mutation, cancellation, and Full Access versus restricted policy.
- [ ] **Step 2: Run** `rtk npm test -- tests/integration/adapters/git.test.ts`; expect FAIL.
- [ ] **Step 3: Implement non-interactive Git process execution, porcelain parsing, safe pathspecs, credential references, policy classification, redacted output, and audit.**
- [ ] **Step 4: Run** focused tests against disposable local and bare remotes; expect PASS without changing the project repository.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add auditable Git tools"`.

### Task 15: HTTP, downloads, and safe archives

**Files:**
- Create: `packages/adapters/src/network/{http-client,download-service,url-policy}.ts`
- Create: `packages/adapters/src/archive/{archive-service,extraction-policy}.ts`
- Create: `apps/server/src/tools/{network,archives}.ts`
- Create: `tests/integration/adapters/{network,archives}.test.ts`, `tests/security/{ssrf,archive-extraction}.test.ts`

**Interfaces:**
- Produces: `HttpService.request` and `DownloadService.start/status/cancel/resume/verify`.
- Produces: `ArchiveService.list/create/extract/verify` with canonical destination, overwrite policy, entry/expanded-size/ratio limits, and dry-run.

- [ ] **Step 1: Write failing tests** for redirects, ranges/resume, content length mismatch, hash verification, timeout/cancel, credential redaction, DNS rebinding/private-network policy, TLS failure, archive traversal, absolute paths, unsafe links, duplicate/case-colliding entries, bombs, and unexpected overwrite.
- [ ] **Step 2: Run** network/archive/security tests; expect FAIL.
- [ ] **Step 3: Implement bounded HTTP/download jobs and archive adapters with policy checks before every redirect/extraction target.**
- [ ] **Step 4: Run** focused tests against local fixture servers/archives; expect PASS and no network dependency.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add secure network and archive tools"`.

### Task 16: Media and rich-document adapters

**Files:**
- Create: `packages/adapters/src/media/{ffmpeg-adapter,media-service,media-verifier}.ts`
- Create: `packages/adapters/src/documents/{document-service,helper-client}.ts`
- Create: `helpers/python/{requirements.lock,remote_mcp_docs/__main__.py,remote_mcp_docs/protocol.py,remote_mcp_docs/handlers.py}`
- Create: `apps/server/src/tools/{media,documents}.ts`
- Create: `tests/integration/adapters/{media,documents}.test.ts`

**Interfaces:**
- Produces: `MediaService.probe/remux/transcode/trim/concat/extractFrames/removeMetadata/extractAudio/verify` as durable jobs when long-running.
- Produces: `DocumentService.inspect/extract/render/ocr/convert/validate` for images, PDF, DOCX, XLSX, CSV, JSON, XML, Markdown, and text.
- Python helper protocol is newline-delimited JSON v1 with request ID, method, validated parameters, progress events, result, and structured error.

- [ ] **Step 1: Write failing tests** for media stream preservation, rotation/color/audio metadata, exact trim/concat duration tolerances, metadata removal, corrupt inputs, spaces/Unicode paths, helper framing, formula cells, merged tables, scanned PDF OCR, conversion validation, and originals remaining unchanged.
- [ ] **Step 2: Run** focused tests; expect FAIL or explicit skipped capability fixtures before adapters exist.
- [ ] **Step 3: Implement detected-dependency adapters, durable progress, reproducible command artifacts, helper isolation, output verification, and `CAPABILITY_UNAVAILABLE` degradation.**
- [ ] **Step 4: Run** media/document fixtures and compare probes, page/image counts, extracted tables/text, and hashes; expect PASS.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add verified media and document tools"`.

### Task 17: Resource locks, transactions, dry-run, and rollback

**Files:**
- Create: `packages/runtime/src/locks/{lock-repository,lock-service}.ts`
- Create: `packages/runtime/src/transactions/{transaction-service,change-set,recovery-store}.ts`
- Create: `apps/server/src/tools/{locks,transactions}.ts`
- Create: `tests/integration/runtime/{locks,transactions}.test.ts`

**Interfaces:**
- Produces: `LockService.acquire/renew/release/reconcile` with canonical resource identity and lease fencing token.
- Produces: `TransactionService.begin/preview/commit/rollback/status`; change adapters implement `prepare`, `apply`, `verify`, and `compensate`.

- [ ] **Step 1: Write failing tests** for path aliases contending on one lock, lease expiry, stale owner recovery, fencing stale writers, deadlock ordering, dry-run zero mutation, crash between prepare/apply/verify, atomic replacement, partial multi-resource rollback, and a non-atomic operation requiring explicit preview evidence.
- [ ] **Step 2: Run** lock/transaction tests; expect FAIL.
- [ ] **Step 3: Implement leased locks with fencing and persisted staged change sets/recovery points; integrate filesystem and supported adapters.**
- [ ] **Step 4: Run** focused tests with forced process termination at each transaction boundary; expect PASS and fixture hashes restored after rollback.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add transactional recovery and resource locks"`.

### Task 18: Watches, scheduler, notifications, and event stream

**Files:**
- Create: `packages/runtime/src/events/{event-bus,event-repository}.ts`
- Create: `packages/runtime/src/watches/{watch-service,file-watch,process-watch,port-watch,job-watch,log-watch,url-watch}.ts`
- Create: `packages/runtime/src/scheduler/{schedule-service,schedule-runner}.ts`
- Create: `packages/runtime/src/notifications/{notification-service,local-notifier,mcp-notifier}.ts`
- Create: `apps/server/src/tools/{watches,schedules,notifications}.ts`
- Create: `tests/integration/runtime/{watches,scheduler,notifications}.test.ts`

**Interfaces:**
- Produces: `WatchService.create/list/pause/resume/cancel/events`, `ScheduleService.create/list/update/pause/resume/delete/runs`, and `NotificationService.send/inbox/acknowledge`.
- Watch kinds: `file | directory | process | port | job | log | url`; schedule fields include IANA timezone, misfire policy, overlap policy, action specification, and grant reference.

- [ ] **Step 1: Write failing tests** for native file events and polling fallbacks, log rotation/truncation, URL jitter/backoff, event dedup/order, cancel, restart restoration, Bangkok timezone/DST-safe calculations, misfires, overlap, revoked grant at fire time, notification retries, and unchanged-state silence.
- [ ] **Step 2: Run** runtime event tests; expect FAIL.
- [ ] **Step 3: Implement persisted event sequencing, watch adapters, schedule runner, policy recheck at dispatch, and local/MCP durable inbox notifications.**
- [ ] **Step 4: Run** focused tests with fake clock and service restart; expect PASS without duplicate scheduled execution.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add persistent watches and scheduler"`.

### Task 19: Artifact Registry, operational state, and project-owned checkpoint helpers

**Files:**
- Create: `packages/runtime/src/artifacts/{artifact-store,artifact-repository,lineage}.ts`
- Create: `packages/runtime/src/state/{operational-state,runtime-checkpoints}.ts`
- Create: `packages/adapters/src/projects/checkpoint-helper.ts`
- Create: `apps/server/src/tools/{artifacts,state,project-checkpoints}.ts`
- Create: `tests/integration/runtime/{artifacts,state}.test.ts`, `tests/contract/project-boundary.test.ts`

**Interfaces:**
- Produces: `ArtifactService.register/get/list/verify/relate/retain/delete` and `RuntimeCheckpointService.save/load/list/complete`.
- Produces: `ProjectCheckpointHelper.discover/read/update`; updates use filesystem transactions, while operational SQLite stores only canonical reference/hash/relationship metadata.

- [ ] **Step 1: Write failing tests** for content hashes, lineage, missing/moved artifacts, retention, cross-workspace namespace isolation, restart-resumable runtime checkpoints, and a database scan proving project overview/checkpoint body text is never copied into MCP state.
- [ ] **Step 2: Run** artifact/state/boundary tests; expect FAIL.
- [ ] **Step 3: Implement content-addressed artifact storage, metadata/lineage, namespaced operational state, runtime checkpoints, and neutral project file helpers.**
- [ ] **Step 4: Run** focused tests and seeded-secret/project-text scans; expect PASS and references only in SQLite.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add artifacts and project-agnostic state"`.

### Task 20: Credential Broker

**Files:**
- Create: `packages/control-plane/src/credentials/{credential-store,credential-service,windows-credential-manager}.ts`
- Create: `helpers/powershell/RemoteMcp.Credentials.psm1`, `apps/server/src/tools/credentials.ts`
- Create: `tests/security/credentials.test.ts`, `tests/integration/control-plane/credentials.test.ts`

**Interfaces:**
- Produces: `CredentialService.create/update/use/delete/listMetadata`; `use` accepts a callback/adapter request and never returns plaintext through MCP.
- SQLite stores only opaque credential reference, type, owner namespace, timestamps, and Windows vault target.

- [ ] **Step 1: Write failing tests** for create/use/update/delete, wrong workspace/client scope, redacted output/errors, environment cleanup, process inheritance denial, database/log scans, missing vault item, revoked grant, and export denial.
- [ ] **Step 2: Run** credential tests; expect FAIL.
- [ ] **Step 3: Implement Windows Credential Manager/DPAPI-backed storage, short-lived adapter injection, ephemeral redaction fingerprints, and authorization/audit.**
- [ ] **Step 4: Run** focused tests using disposable vault entries and confirm cleanup; expect PASS with no plaintext persistence.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add non-exporting credential broker"`.

### Task 21: Windows GUI automation

**Files:**
- Create: `packages/adapters/src/gui/{gui-service,uia-client,window-model,screenshot-service,targeting}.ts`
- Create: `helpers/powershell/RemoteMcp.UIAutomation.psm1`, `apps/server/src/tools/gui.ts`
- Create: `tests/integration/adapters/gui.test.ts`, `tests/fixtures/gui-app/`

**Interfaces:**
- Produces: `GuiService.desktops/windows/inspect/focus/invoke/click/type/keys/wait/capture`.
- Target priority is application API/CLI, UIA semantic selector, window-relative image/text, then explicit absolute coordinates; every action returns observed postcondition evidence.

- [ ] **Step 1: Write failing tests** against the disposable fixture app for duplicate labels, changing window positions/DPI, stale elements, modal dialogs, focus theft, Unicode/secret-field typing, screenshot artifacts, timeout, coordinate fallback labeling, secure desktop detection, and result verification.
- [ ] **Step 2: Run** GUI tests in interactive-session mode; expect FAIL because the UIA helper is absent.
- [ ] **Step 3: Implement UI Automation inspection/actions, screenshot capture, semantic waits, redaction metadata, fallback targeting, policy/broker integration, and `needs_attention` for secure desktop.**
- [ ] **Step 4: Run** focused GUI tests at two DPI/window positions; expect PASS with no absolute-coordinate use in semantic cases.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add verified Windows GUI automation"`.

### Task 22: Browser automation and managed profiles

**Files:**
- Create: `packages/adapters/src/browser/{browser-service,profile-manager,download-manager,browser-policy}.ts`
- Create: `apps/server/src/tools/browser.ts`, `tests/integration/adapters/browser.test.ts`, `tests/fixtures/web/`

**Interfaces:**
- Produces: `BrowserService.launch/close/contexts/tabs/navigate/inspect/click/type/upload/download/wait/screenshot/pdf/evaluate`.
- Profiles are workspace-namespaced artifacts protected by resource locks; cookie/token export is denied by default.

- [ ] **Step 1: Write failing tests** for semantic locators, redirects/popups/tabs, file upload/download verification, profile lock contention, restart cleanup, cookie/token redaction, same-origin evaluation policy, navigation timeout, CAPTCHA/MFA `needs_attention`, and grant revoke during a sequence.
- [ ] **Step 2: Run** browser tests against the local fixture site; expect FAIL.
- [ ] **Step 3: Implement Playwright-backed managed profiles, semantic actions, downloads/artifacts, screenshots/PDFs, network-aware waits, redaction, locks, policy checks, and verified postconditions.**
- [ ] **Step 4: Run** focused tests headless and interactive; expect PASS with no external-site dependency.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add managed browser automation"`.

### Task 23: Remote OAuth authentication and HTTPS deployment

**Files:**
- Create: `apps/server/src/auth/{oauth-provider,token-validator,client-registry,owner-consent}.ts`
- Create: `apps/server/src/routes/{oauth-metadata,owner-console}.ts`
- Create: `config/reverse-proxy/{caddy.example,CLOUDFLARE_TUNNEL.example.md}`
- Create: `scripts/service/{install,uninstall,status}.ps1`
- Create: `tests/security/remote-auth.test.ts`, `tests/integration/server/oauth.test.ts`

**Interfaces:**
- Produces OAuth 2.1/PKCE-compatible authorization/resource metadata, token validation, stable principal/client mapping, revocation/disconnect, and owner consent that creates grants only after authenticated confirmation.
- Local development token mode remains loopback-only; production mode refuses non-HTTPS forwarded origins and validates issuer/audience/nonce/state/PKCE.

- [ ] **Step 1: Write failing tests** for PKCE/state/nonce, wrong issuer/audience, token replay/revoke, refresh mapping to the same persistent grant, new client requiring consent, host/origin spoofing, insecure remote binding refusal, rate/size limits, disconnect, and OAuth credential rotation without losing a still-valid linked grant.
- [ ] **Step 2: Run** remote-auth tests; expect FAIL.
- [ ] **Step 3: Implement provider abstraction, metadata/routes, owner consent UI, stable client registry, auth middleware, service scripts, and documented HTTPS reverse-proxy/tunnel examples.**
- [ ] **Step 4: Run** focused tests with an in-process OAuth fixture and TLS proxy fixture; expect PASS, then verify an MCP SDK remote client reconnects to the same grant.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: secure remote MCP authentication"`.

### Task 24: Capability self-test and health reporting

**Files:**
- Create: `packages/runtime/src/health/{health-service,self-test-service,capability-registry}.ts`
- Modify: `apps/server/src/tools/health.ts`
- Create: `tests/integration/runtime/health.test.ts`, `tests/contract/capability-manifest.test.ts`

**Interfaces:**
- Produces: `HealthService.report(): HealthReport` and `SelfTestService.run(selection): Promise<CapabilityRunId>`.
- Capability status is `ready | degraded | unavailable | failed` with dependency/version evidence, remediation, last test, and no secret values.

- [ ] **Step 1: Write failing tests** for missing optional dependencies, database corruption/read-only storage, worker/broker disconnect, expired browser binary, unavailable interactive desktop, safe isolated self-tests, manifest/runtime schema drift, and truthful degraded status.
- [ ] **Step 2: Run** health/manifest tests; expect FAIL.
- [ ] **Step 3: Implement capability registration, readiness/liveness reports, safe fixture self-tests as durable jobs, dependency evidence, and checked-in versioned manifest generation.**
- [ ] **Step 4: Run** focused tests and `capability_self_test` against the local machine; expect a truthful report where unavailable optional capabilities do not masquerade as ready.
- [ ] **Step 5: Commit** with `rtk git commit -m "feat: add capability diagnostics"`.

### Task 25: Security hardening, fault injection, backup, and recovery

**Files:**
- Create: `packages/control-plane/src/security/{limits,untrusted-content,ssrf-guard}.ts`
- Create: `scripts/operations/{backup,restore,security-reset,emergency-stop}.ps1`
- Create: `tests/security/{authorization-boundary,prompt-injection,secret-leakage,resource-exhaustion}.test.ts`
- Create: `tests/fault/{server-crash,worker-crash,database-busy,partial-write}.test.ts`

**Interfaces:**
- Produces centralized `SecurityLimits`, explicit `UntrustedContent<T>` wrappers, backup/restore manifests with hashes, and security reset that rotates epoch and invalidates grants/tokens.

- [ ] **Step 1: Write failing adversarial tests** for prompt injection in files/web/docs, Unicode/confusable paths, symlink swaps, TOCTOU target changes, SSRF/DNS rebinding, oversized payload/output, zip/media bombs, fork storms, DB busy/full disk, process/server crash, secret canaries across every sink, backup tamper, and security reset.
- [ ] **Step 2: Run** security/fault suites; expect controlled failures that expose current gaps.
- [ ] **Step 3: Implement central limits, untrusted-content type boundaries, revalidation before mutation, backpressure, quotas, recovery scripts, security reset, and all fixes required by the failing cases.**
- [ ] **Step 4: Run** security/fault suites repeatedly; expect PASS, no canary leaks, no mutation outside fixtures, and successful backup/restore integrity verification.
- [ ] **Step 5: Commit** with `rtk git commit -m "security: harden trust and recovery boundaries"`.

### Task 26: End-to-end acceptance, reboot persistence, documentation, and release

**Files:**
- Create: `tests/acceptance/{master-a-l,full-access-lifecycle,unattended-workflow,parity}.test.ts`
- Create: `scripts/system-acceptance/{reboot-persistence,continue-after-reboot}.ps1`
- Create: `docs/{TOOL_INVENTORY,PARITY_MATRIX,ACCEPTANCE_REPORT,THAI_QUICKSTART,THAI_USER_GUIDE,TROUBLESHOOTING}.md`
- Create: `docs/architecture/{DATA_FLOW,OPERATIONS}.md`, `docs/security/{AUTHORIZATION,PRIVILEGED_BROKER,CREDENTIALS,THREAT_MODEL}.md`
- Create: `CHANGELOG.md`, `scripts/release/verify.ps1`

**Interfaces:**
- Produces: complete acceptance evidence linked to tool/schema versions, test run IDs, artifacts, and commit SHA.
- System reboot suite uses a two-stage signed state file and startup continuation; it is opt-in and runs only in the authorized Windows system-test environment.

- [ ] **Step 1: Write the failing acceptance harness** for Master Spec A–L, parity inventory, one-grant unattended workflow, chat reconnect, server restart, Windows reboot continuation, revoke-before-next-action, broker admin action without repeat UAC, Emergency Stop, and project-boundary isolation.
- [ ] **Step 2: Run** `rtk npm run test:acceptance`; expect failures listing every unmet scenario rather than skipped silent gaps.
- [ ] **Step 3: Fix uncovered behavior and write the complete generated-plus-reviewed tool inventory, parity matrix, architecture/security/operations docs, Thai guides, setup/backup/restore/revoke/emergency procedures, and release verifier.**
- [ ] **Step 4: Run** typecheck, unit, contract, integration, security, fault, acceptance, capability self-test, remote reconnect, service restart, and authorized two-stage reboot suite; expect all mandatory capabilities PASS and optional unavailable capabilities explicitly documented with evidence.
- [ ] **Step 5: Commit** with `rtk git commit -m "release: verify universal remote MCP server"`, tag the verified version, and record the tag/commit in `docs/ACCEPTANCE_REPORT.md`.

## Spec Coverage Map

| Requirement area | Owning tasks |
|---|---|
| Versioned MCP core, schemas, structured errors | 1, 2, 7, 24 |
| Persistent Full Access, optional approval, revoke/Emergency Stop | 4, 5, 7, 12, 13, 23, 26 |
| Project-agnostic state boundary | 8, 19, 26 |
| Filesystem and streaming search | 8, 9 |
| Interactive terminal, process/service/port/system | 10, 11, 13 |
| Durable jobs and reconnect/restart recovery | 12, 18, 19, 26 |
| Git, HTTP/downloads, archives | 14, 15 |
| Media and rich formats | 16 |
| Transactions, dry-run, rollback, resource locks | 8, 17 |
| Watches, events, schedules, notifications | 18 |
| Artifact Registry, runtime state, project checkpoint helpers | 19 |
| Credential Broker and redaction/audit | 6, 20, 25 |
| GUI and browser automation | 21, 22 |
| Remote HTTPS/OAuth and trusted client continuity | 23, 26 |
| Health/self-test, hardening, acceptance A–L, docs | 24, 25, 26 |

## Execution Rule

Native execution is already selected by the user. Run Tasks 1–26 in order using `superpowers:executing-plans`; do not create parallel subagents. A task is complete only after its focused failing test was observed, its implementation passes, adjacent regression tests pass, evidence/checkpoint is updated, and the stated commit exists.


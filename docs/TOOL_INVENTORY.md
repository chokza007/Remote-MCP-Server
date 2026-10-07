# Tool Inventory

> Generated from the runtime MCP tools/list response. Run npm run inventory after changing any registered tool.

Total tools: **177**. Risk tier 0 is read-only/public metadata; tiers 1-3 require policy authorization. A valid persistent Full Access grant satisfies that authorization without per-action prompts.

| Tool | Version | Risk | Scope | Purpose |
|---|---:|---:|---|---|
| `archive_create` | 1.0.0 | 2 | `computer:*` | Creates a ZIP from explicit source/path pairs. |
| `archive_extract` | 1.0.0 | 2 | `computer:*` | Safely extracts a ZIP after validating every entry and target. |
| `archive_list` | 1.0.0 | 0 | `computer:*` | Lists validated ZIP entries without extraction. |
| `archive_verify` | 1.0.0 | 0 | `computer:*` | Validates and decompresses a ZIP within configured safety limits. |
| `artifact_delete` | 1.0.0 | 2 | `computer:*` | Deletes an owned artifact record and unshared managed bytes when retention allows it. |
| `artifact_get` | 1.0.0 | 0 | `computer:*` | Reads owned artifact metadata without reading artifact bytes. |
| `artifact_lineage` | 1.0.0 | 0 | `computer:*` | Reads owned parent and child artifact relations. |
| `artifact_list` | 1.0.0 | 0 | `computer:*` | Lists artifact metadata in one owned workspace. |
| `artifact_register` | 1.0.0 | 1 | `computer:*` | Registers a managed content-addressed artifact or a verified external reference. |
| `artifact_relate` | 1.0.0 | 1 | `computer:*` | Records an owned parent-child artifact lineage edge. |
| `artifact_retain` | 1.0.0 | 1 | `computer:*` | Pins an artifact or sets its minimum retention timestamp. |
| `artifact_verify` | 1.0.0 | 1 | `computer:*` | Re-hashes an artifact and optionally relocates a missing reference by matching content hash. |
| `authorization_status` | 1.0.0 | 0 | `computer:*` | Reports authorization for this client. |
| `browser_click` | 1.0.0 | 2 | `computer:*` | clicks one exact semantic target and verifies completion. |
| `browser_close` | 1.0.0 | 2 | `computer:*` | Closes a managed context and releases its profile lock. |
| `browser_contexts` | 1.0.0 | 0 | `computer:*` | Lists active managed browser contexts without cookies or tokens. |
| `browser_download` | 1.0.0 | 2 | `computer:*` | Downloads through one semantic target and returns hash evidence. |
| `browser_evaluate` | 1.0.0 | 2 | `computer:*` | Evaluates a bounded same-origin expression under non-exporting policy. |
| `browser_inspect` | 1.0.0 | 0 | `computer:*` | Returns a redacted semantic page model without form values, cookies, or tokens. |
| `browser_launch` | 1.0.0 | 2 | `computer:*` | Launches a workspace-namespaced persistent browser profile. |
| `browser_navigate` | 1.0.0 | 2 | `computer:*` | Navigates an existing or initial tab under browser URL policy. |
| `browser_pdf` | 1.0.0 | 1 | `computer:*` | Renders the current page to a PDF artifact with hash evidence. |
| `browser_screenshot` | 1.0.0 | 1 | `computer:*` | Captures a full-page PNG with hash evidence. |
| `browser_tabs` | 1.0.0 | 0 | `computer:*` | Lists tabs in a managed browser context. |
| `browser_type` | 1.0.0 | 2 | `computer:*` | types one exact semantic target and verifies completion. |
| `browser_upload` | 1.0.0 | 2 | `computer:*` | Sets files on one semantic file input. |
| `browser_wait` | 1.0.0 | 0 | `computer:*` | Waits for a semantic element state. |
| `capability_manifest` | 1.0.0 | 0 | `computer:*` | Returns the checked runtime capability contract. |
| `capability_self_test` | 1.0.0 | 1 | `computer:*` | Runs safe isolated checks as a durable verified job. |
| `clear_emergency_stop` | 1.0.0 | 3 | `computer:*` | Clears the global emergency stop. |
| `credential_create` | 1.0.0 | 2 | `computer:*` | Stores secret material in Windows Credential Manager and returns only opaque metadata. |
| `credential_delete` | 1.0.0 | 2 | `computer:*` | Deletes owned secret material and tombstones its opaque reference. |
| `credential_list` | 1.0.0 | 0 | `computer:*` | Lists owned credential references without reading secret material. |
| `credential_update` | 1.0.0 | 2 | `computer:*` | Replaces secret material in Windows Credential Manager without exposing it. |
| `credential_validate` | 1.0.0 | 1 | `computer:*` | Checks that an owned vault credential is available without exporting its value. |
| `document_convert` | 1.0.0 | 2 | `computer:*` | Converts a supported document to an explicit output format and validates the output. |
| `document_docx_replace` | 1.0.0 | 2 | `computer:*` | Writes a new DOCX with exact text replacements while preserving the source document. |
| `document_extract` | 1.0.0 | 0 | `computer:*` | extracts a supported image or rich document through the isolated helper. |
| `document_inspect` | 1.0.0 | 0 | `computer:*` | inspects a supported image or rich document through the isolated helper. |
| `document_ocr` | 1.0.0 | 1 | `computer:*` | Recognizes text in an image or rendered PDF pages. |
| `document_render` | 1.0.0 | 2 | `computer:*` | Renders every PDF page to a verified PNG image. |
| `document_validate` | 1.0.0 | 0 | `computer:*` | validates a supported image or rich document through the isolated helper. |
| `document_xlsx_update` | 1.0.0 | 2 | `computer:*` | Writes a new XLSX with explicit A1 cell updates while preserving the source workbook. |
| `download_cancel` | 1.0.0 | 1 | `computer:*` | cancels or inspects a download job. |
| `download_resume` | 1.0.0 | 2 | `computer:*` | resumes or inspects a download job. |
| `download_start` | 1.0.0 | 2 | `computer:*` | Starts a bounded atomic download with optional SHA-256 verification. |
| `download_status` | 1.0.0 | 0 | `computer:*` | statuss or inspects a download job. |
| `download_verify` | 1.0.0 | 0 | `computer:*` | verifys or inspects a download job. |
| `emergency_stop` | 1.0.0 | 3 | `computer:*` | Stops all new privileged actions immediately. |
| `environment_snapshot` | 1.0.0 | 0 | `computer:*` | Reports environment keys and redacted values. |
| `event_stream` | 1.0.0 | 0 | `computer:*` | Reads an ordered cursor page of durable events owned by this client. |
| `filesystem_apply_patch` | 1.0.0 | 2 | `computer:*` | Atomically applies exact text edits. |
| `filesystem_copy` | 1.0.0 | 2 | `computer:*` | Copies without implicit overwrite. |
| `filesystem_hash` | 1.0.0 | 0 | `computer:*` | Computes a streaming cryptographic hash. |
| `filesystem_links` | 1.0.0 | 0 | `computer:*` | Reports link target and allowed-root escape state. |
| `filesystem_list` | 1.0.0 | 0 | `computer:*` | Lists directory entries with bounded recursion. |
| `filesystem_move` | 1.0.0 | 2 | `computer:*` | Moves without implicit overwrite. |
| `filesystem_permissions` | 1.0.0 | 0 | `computer:*` | Reports effective filesystem access. |
| `filesystem_read_range` | 1.0.0 | 0 | `computer:*` | Reads a bounded byte range. |
| `filesystem_recycle` | 1.0.0 | 2 | `computer:*` | Moves an entry to recoverable storage. |
| `filesystem_remove` | 1.0.0 | 3 | `computer:*` | Permanently removes an explicitly selected entry. |
| `filesystem_rename` | 1.0.0 | 2 | `computer:*` | Renames within the same directory. |
| `filesystem_stat` | 1.0.0 | 0 | `computer:*` | Reports filesystem metadata. |
| `filesystem_write` | 1.0.0 | 2 | `computer:*` | Writes using atomic replacement and explicit overwrite. |
| `git_add` | 1.0.0 | 2 | `computer:*` | Stages only explicit literal repository-relative paths. |
| `git_branches` | 1.0.0 | 0 | `computer:*` | Reads local branches and detached-HEAD state. |
| `git_commit` | 1.0.0 | 2 | `computer:*` | Commits the existing index with an explicit message. |
| `git_conflicts` | 1.0.0 | 0 | `computer:*` | Lists unresolved merge conflicts. |
| `git_diff` | 1.0.0 | 0 | `computer:*` | Reads a bounded Git diff from an explicit repository root. |
| `git_discover` | 1.0.0 | 0 | `computer:*` | Discovers a repository without mutating it. |
| `git_fetch` | 1.0.0 | 1 | `computer:*` | Runs non-interactive Git fetch with an optional credential reference. |
| `git_log` | 1.0.0 | 0 | `computer:*` | Reads bounded Git history from an explicit repository root. |
| `git_pull` | 1.0.0 | 2 | `computer:*` | Runs non-interactive Git pull with an optional credential reference. |
| `git_push` | 1.0.0 | 3 | `computer:*` | Runs non-interactive Git push with an optional credential reference. |
| `git_status` | 1.0.0 | 0 | `computer:*` | Reads porcelain Git status from an explicit repository root. |
| `gui_capture` | 1.0.0 | 1 | `computer:*` | Captures a window or desktop PNG with hash and size evidence. |
| `gui_click` | 1.0.0 | 2 | `computer:*` | clicks a UI Automation control and verifies its postcondition. |
| `gui_desktops` | 1.0.0 | 0 | `computer:*` | Reports whether the interactive Windows desktop is available. |
| `gui_focus` | 1.0.0 | 2 | `computer:*` | Focuses a window and verifies the observed foreground window. |
| `gui_inspect` | 1.0.0 | 0 | `computer:*` | Inspects UI Automation controls in an exact window. |
| `gui_invoke` | 1.0.0 | 2 | `computer:*` | invokes a UI Automation control and verifies its postcondition. |
| `gui_keys` | 1.0.0 | 2 | `computer:*` | Sends a bounded key chord and verifies foreground focus. |
| `gui_type` | 1.0.0 | 2 | `computer:*` | Types Unicode text through UI Automation with password-field result redaction. |
| `gui_wait` | 1.0.0 | 0 | `computer:*` | Waits for an observed UI Automation condition. |
| `gui_windows` | 1.0.0 | 0 | `computer:*` | Lists top-level windows on the current interactive desktop. |
| `health_report` | 1.0.0 | 0 | `computer:*` | Reports truthful core and optional capability health. |
| `http_request` | 1.0.0 | 1 | `computer:*` | Performs a bounded GET or HEAD request with redirect and SSRF checks. |
| `job_cancel` | 1.0.0 | 2 | `computer:*` | cancels an owned durable job. |
| `job_events` | 1.0.0 | 0 | `computer:*` | Reads an ordered page of durable job events. |
| `job_get` | 1.0.0 | 0 | `computer:*` | Reads current durable job state and verification. |
| `job_list` | 1.0.0 | 0 | `computer:*` | Lists durable jobs owned by this client. |
| `job_logs` | 1.0.0 | 0 | `computer:*` | Reads an ordered redacted page of durable job logs. |
| `job_pause` | 1.0.0 | 2 | `computer:*` | pauses an owned durable job. |
| `job_resume` | 1.0.0 | 2 | `computer:*` | resumes an owned durable job. |
| `job_retry` | 1.0.0 | 2 | `computer:*` | retrys an owned durable job. |
| `job_submit` | 1.0.0 | 1 | `computer:*` | Queues a restart-safe background job and returns immediately. |
| `list_trusted_clients` | 1.0.0 | 0 | `computer:*` | Lists persistent trusted grants. |
| `lock_acquire` | 1.0.0 | 1 | `computer:*` | Atomically acquires canonically ordered leased resources with fencing tokens. |
| `lock_list` | 1.0.0 | 0 | `computer:*` | Lists active resource leases owned by this client. |
| `lock_reconcile` | 1.0.0 | 1 | `computer:*` | Releases only resource leases whose persisted expiration has passed. |
| `lock_release` | 1.0.0 | 1 | `computer:*` | Releases every resource in an owned lease atomically. |
| `lock_renew` | 1.0.0 | 1 | `computer:*` | Renews an owned resource lease without changing fencing tokens. |
| `media_concat` | 1.0.0 | 2 | `computer:*` | Concatenates compatible media inputs and verifies the combined duration. |
| `media_extract_audio` | 1.0.0 | 2 | `computer:*` | Copies the first audio stream to a verified standalone output. |
| `media_extract_frames` | 1.0.0 | 2 | `computer:*` | Extracts lossless PNG frames at explicit timestamps. |
| `media_probe` | 1.0.0 | 0 | `computer:*` | Reads stream, duration, rotation, color, audio, and format metadata with ffprobe. |
| `media_remove_metadata` | 1.0.0 | 2 | `computer:*` | Copies media streams while removing global metadata and chapters. |
| `media_remux` | 1.0.0 | 2 | `computer:*` | Copies all compatible streams into a new container and verifies the output. |
| `media_transcode` | 1.0.0 | 2 | `computer:*` | Transcodes media with explicit codecs and verifies the output before atomic publication. |
| `media_trim` | 1.0.0 | 2 | `computer:*` | Creates an exact re-encoded time range and verifies its duration. |
| `media_verify` | 1.0.0 | 0 | `computer:*` | Checks media duration, stream counts, codecs, and absent metadata against expectations. |
| `notification_acknowledge` | 1.0.0 | 1 | `computer:*` | Acknowledges an owned durable notification. |
| `notification_inbox` | 1.0.0 | 0 | `computer:*` | Lists durable notifications owned by this client. |
| `notification_retry_due` | 1.0.0 | 1 | `computer:*` | Retries due pending notification deliveries. |
| `notification_send` | 1.0.0 | 1 | `computer:*` | Queues and delivers a durable notification with retry state. |
| `operational_state_delete` | 1.0.0 | 1 | `computer:*` | Deletes one namespaced runtime state record. |
| `operational_state_get` | 1.0.0 | 0 | `computer:*` | Reads one namespaced runtime state record. |
| `operational_state_list` | 1.0.0 | 0 | `computer:*` | Lists namespaced runtime state records. |
| `operational_state_set` | 1.0.0 | 1 | `computer:*` | Stores namespaced runtime state; project knowledge remains in project files. |
| `port_listeners` | 1.0.0 | 0 | `computer:*` | Lists TCP and UDP listeners with owning PIDs. |
| `port_resolve` | 1.0.0 | 0 | `computer:*` | Resolves a local port to owning processes. |
| `process_inspect` | 1.0.0 | 0 | `computer:*` | Inspects one Windows process and its creation identity. |
| `process_list` | 1.0.0 | 0 | `computer:*` | Lists Windows processes with redacted command lines. |
| `process_start` | 1.0.0 | 2 | `computer:*` | Starts a controlled non-interactive process. |
| `process_terminate_tree` | 1.0.0 | 3 | `computer:*` | Terminates an exact creation-bound process tree. |
| `process_wait` | 1.0.0 | 0 | `computer:*` | Waits for an exact process identity to exit. |
| `project_checkpoint_discover` | 1.0.0 | 0 | `computer:*` | Finds project-owned WORK_CHECKPOINT.md references without copying their contents. |
| `project_checkpoint_read` | 1.0.0 | 0 | `computer:*` | Reads a project-owned checkpoint directly from its project. |
| `project_checkpoint_update` | 1.0.0 | 2 | `computer:*` | Atomically updates a project-owned checkpoint and records only its path and hash as an artifact reference. |
| `project_discover_guidance` | 1.0.0 | 0 | `computer:*` | Finds project-owned guidance references without copying their contents into MCP state. |
| `request_full_access` | 1.0.0 | 1 | `computer:*` | Creates a pending Full Access enrollment request. |
| `revoke_full_access` | 1.0.0 | 3 | `computer:*` | Revokes a persistent trusted grant. |
| `runtime_checkpoint_complete` | 1.0.0 | 1 | `computer:*` | Marks an owned runtime checkpoint complete with verification evidence. |
| `runtime_checkpoint_list` | 1.0.0 | 0 | `computer:*` | Lists owned runtime checkpoint summaries. |
| `runtime_checkpoint_load` | 1.0.0 | 0 | `computer:*` | Loads resumable execution state from one owned workspace. |
| `runtime_checkpoint_save` | 1.0.0 | 1 | `computer:*` | Persists resumable execution state, not project status or project memory. |
| `schedule_create` | 1.0.0 | 1 | `computer:*` | Creates a persistent timezone-aware action schedule bound to the current grant. |
| `schedule_delete` | 1.0.0 | 1 | `computer:*` | deletes an owned schedule. |
| `schedule_list` | 1.0.0 | 0 | `computer:*` | Lists active and paused schedules owned by this client. |
| `schedule_pause` | 1.0.0 | 1 | `computer:*` | pauses an owned schedule. |
| `schedule_resume` | 1.0.0 | 1 | `computer:*` | resumes an owned schedule. |
| `schedule_run_due` | 1.0.0 | 1 | `computer:*` | Runs due schedules after rechecking their persistent grants. |
| `schedule_runs` | 1.0.0 | 0 | `computer:*` | Lists durable run history for an owned schedule. |
| `schedule_update` | 1.0.0 | 1 | `computer:*` | Updates an owned schedule and recalculates its next wall-clock occurrence. |
| `search_cancel` | 1.0.0 | 1 | `computer:*` | Cancels an active durable search. |
| `search_page` | 1.0.0 | 0 | `computer:*` | Reads one deterministic page of stored results. |
| `search_resume` | 1.0.0 | 1 | `computer:*` | Restarts a cancelled or failed durable search. |
| `search_start` | 1.0.0 | 1 | `computer:*` | Starts a bounded durable filesystem search. |
| `search_status` | 1.0.0 | 0 | `computer:*` | Reports durable search progress and limits. |
| `server_info` | 1.0.0 | 0 | `computer:*` | Reports this MCP server and device identity. |
| `service_inspect` | 1.0.0 | 0 | `computer:*` | Inspects one Windows service. |
| `service_list` | 1.0.0 | 0 | `computer:*` | Lists Windows service state. |
| `service_restart` | 1.0.0 | 3 | `computer:*` | restarts a Windows service through the configured privilege boundary. |
| `service_start` | 1.0.0 | 3 | `computer:*` | starts a Windows service through the configured privilege boundary. |
| `service_stop` | 1.0.0 | 3 | `computer:*` | stops a Windows service through the configured privilege boundary. |
| `system_capabilities` | 1.0.0 | 0 | `computer:*` | Reports detected local tool capabilities. |
| `system_snapshot` | 1.0.0 | 0 | `computer:*` | Reports operating system and runtime identity. |
| `terminal_close` | 1.0.0 | 2 | `computer:*` | Terminates a terminal process tree and closes its session. |
| `terminal_create` | 1.0.0 | 1 | `computer:*` | Creates an interactive Windows ConPTY session. |
| `terminal_promote_to_job` | 1.0.0 | 0 | `computer:*` | Returns durable-job promotion metadata. |
| `terminal_read` | 1.0.0 | 0 | `computer:*` | Reads output using monotonic byte offsets. |
| `terminal_resize` | 1.0.0 | 1 | `computer:*` | Resizes an interactive terminal viewport. |
| `terminal_send` | 1.0.0 | 1 | `computer:*` | Writes exact text to terminal stdin. |
| `terminal_send_control` | 1.0.0 | 1 | `computer:*` | Sends Ctrl+C, Ctrl+Break, or EOF. |
| `terminal_status` | 1.0.0 | 0 | `computer:*` | Reports interactive terminal lifecycle state. |
| `transaction_begin` | 1.0.0 | 1 | `computer:*` | Creates a persisted staged change set without mutating targets. |
| `transaction_commit` | 1.0.0 | 2 | `computer:*` | Applies, verifies, and automatically compensates a persisted change set on failure. |
| `transaction_preview` | 1.0.0 | 1 | `computer:*` | Prepares recovery points and returns explicit evidence without mutating targets. |
| `transaction_reconcile` | 1.0.0 | 2 | `computer:*` | Rolls back interrupted transactions from persisted recovery points. |
| `transaction_rollback` | 1.0.0 | 2 | `computer:*` | Compensates prepared or applied changes in reverse order from persisted recovery points. |
| `transaction_status` | 1.0.0 | 0 | `computer:*` | Reads an owned transaction and its per-change state. |
| `watch_cancel` | 1.0.0 | 1 | `computer:*` | cancels an owned persistent watch. |
| `watch_create` | 1.0.0 | 1 | `computer:*` | Creates a restart-safe file, directory, process, port, job, log, or URL watch. |
| `watch_events` | 1.0.0 | 0 | `computer:*` | Reads an ordered cursor page of durable watch events. |
| `watch_list` | 1.0.0 | 0 | `computer:*` | Lists watches owned by this client. |
| `watch_pause` | 1.0.0 | 1 | `computer:*` | pauses an owned persistent watch. |
| `watch_resume` | 1.0.0 | 1 | `computer:*` | resumes an owned persistent watch. |

# REMOTE MCP — FULL CAPABILITY / DESKTOP COMMANDER PARITY+ SPEC

**Purpose:** Build a self-hosted Remote MCP for ChatGPT that can use the authorized Windows workstation as a general-purpose production, development, research, and automation machine with **Desktop Commander parity or better**.

> **OBSERVE FREELY · WORK FREELY · ASK BEFORE RISK · EXECUTE ONLY AFTER APPROVAL · RESUME AFTER DISCONNECT**

This document is the reference specification for the custom MCP. It must not be tied to one repository or one production workflow.

---

## 1. Target behavior

The custom MCP should allow ChatGPT to:

- inspect the whole authorized computer;
- read/search/analyze files anywhere;
- run normal commands, scripts, applications, tests, production jobs, rendering, downloads, and automation;
- work across multiple projects/workspaces;
- interact with long-running and interactive processes;
- recover after reconnect/disconnect;
- use GUI automation when CLI/API is unavailable;
- propose source-code improvements without silently modifying unrelated code;
- ask the user before dangerous, destructive, irreversible, privacy-sensitive, public, paid, or system-level actions;
- continue the exact approved action only after approval;
- keep secrets private and maintain an audit trail.

The desired model is **full-machine capability with an approval gate**, not a restrictive project sandbox.

---

# 2. What the currently connected Desktop Commander actually provides

Verified against the currently connected Desktop Commander tool schema/configuration on the authorized Windows device.

## Current access model

- Windows host
- Default shell: PowerShell
- `allowedDirectories = []`
  - In Desktop Commander this means filesystem access is not restricted to a specific directory.
- Python is available.
- Node.js is available.
- Desktop Commander exposes filesystem, search, terminal/process, config, history, and device operations.

## Important limitation of Desktop Commander

Desktop Commander is **not literally unrestricted**.

The current configuration permanently blocks high-risk system commands including categories such as:

- disk formatting / partition operations (`format`, `diskpart`, `fdisk`, `mkfs`, `dd`, etc.)
- privilege/account commands
- shutdown/reboot/power commands
- firewall/network administration
- registry/service/account administration (`reg`, `net`, `sc`, etc.)
- ownership/security-related commands

For the custom MCP, the preferred design is **not permanent broad blocking**.

Instead:

> dangerous action → prepare exact action → request user approval → execute only after approval.

---

# 3. Desktop Commander parity requirements

The custom MCP must provide equivalents for the useful capabilities below.

## 3.1 Device / connection

Required:

- `list_devices`
- `device_info`
- `ping`
- `connection_status`
- `server_version`
- `system_info`
- `shutdown_agent`
- reconnect-safe device identity

Recommended:

- device aliases
- multi-device selection
- reconnect history
- last-seen timestamp

---

## 3.2 Configuration / capability discovery

Required:

- `get_config`
- `capabilities`
- `tool_help`
- `get_policy`
- `get_workspace`
- `set_workspace`

Configuration should expose:

- MCP/server version
- OS/platform
- default shell
- available shells
- Python/Node/runtime versions
- current workspace
- approval policy
- tool list
- active client/session identity
- read/write/runtime limits if any

Untrusted project content must never silently alter MCP security policy.

---

# 4. Filesystem — full authorized-machine visibility

Required:

- `list_directory`
- `tree`
- `read_file`
- `read_file_range`
- `read_multiple_files`
- `write_file`
- `append_file`
- `patch_file`
- `edit_block`
- `create_directory`
- `move_file`
- `copy_file`
- `rename_file`
- `delete_file`
- `delete_directory`
- `recycle`
- `restore_from_trash`
- `get_file_info`
- `stat`
- `hash_file`
- `compare_files`
- `directory_size`
- `disk_free_space`
- `glob`

Requirements:

- read/search visibility across the authorized machine;
- binary-file support;
- large-file streaming/chunking;
- line/range reads;
- atomic writes where possible;
- surgical patching without rewriting large files;
- correct Unicode and Windows path handling;
- hidden-file support when requested;
- metadata preservation where appropriate.

Destructive operations must use the Approval Gate when risk is material.

---

# 5. Rich file-format handling

The custom MCP should match or exceed Desktop Commander.

## Text / code

- line-numbered reading
- encoding detection
- partial reads
- patch/edit

## Images

Support at least:

- PNG
- JPEG/JPG
- GIF
- WebP
- dimensions/metadata
- preview transport to ChatGPT

## PDF

- extract text by page
- inspect page/embedded imagery where feasible
- page-range reading
- create PDF
- insert/delete pages where feasible

## DOCX

- readable text-bearing outline
- table/style awareness
- edit support

## Excel

Support:

- `.xlsx`
- `.xls`
- `.xlsm`
- list sheets
- read ranges
- update ranges
- preserve workbook structure where possible

## Other useful formats

- CSV/TSV
- JSON/YAML/TOML/XML
- SRT/VTT/ASS subtitles
- common archives

---

# 6. Search capability — parity+

Desktop Commander has streaming file/content search. The custom MCP should too.

Required:

- `start_search`
- `search_files`
- `search_content`
- `get_search_results`
- `stop_search`
- `list_searches`

Features:

- filename search
- extension filters
- regex
- literal/exact search
- case-sensitive/insensitive
- hidden-file search
- recursive search
- surrounding context lines
- path + line number
- progressive results
- pagination
- early termination
- cancellation

Recommended implementation: ripgrep-equivalent engine.

Search sessions should survive short reconnects when possible.

---

# 7. Terminal / shell — interactive parity

This is one of the most important requirements.

Required:

- `start_process`
- `run_command`
- `run_powershell`
- `run_cmd`
- `run_python`
- `run_node`
- `run_script`
- `read_process_output`
- `interact_with_process`
- `send_stdin`
- `force_terminate`
- `list_sessions`

Parameters:

- command
- shell
- cwd
- env
- stdin
- timeout
- encoding
- detached/background mode

Results:

- PID/session ID
- stdout
- stderr
- exit code
- runtime
- running/finished/waiting-for-input state
- prompt detection for REPLs

Must support interactive sessions such as:

- PowerShell
- CMD
- Python REPL
- Node REPL
- CLI prompts
- installed database/console tools

Do not limit execution to scripts inside one project.

---

# 8. Durable long-running jobs

This should exceed Desktop Commander.

Required:

- `start_job`
- `job_status`
- `job_logs`
- `job_list`
- `cancel_job`
- `pause_job` when technically possible
- `resume_job` when technically possible
- `job_artifacts`

Each job should contain:

- stable `job_id`
- action/workflow
- command
- workspace/CWD
- start time
- status
- progress
- stdout/stderr log location
- PID(s)
- output assets
- exit code
- end time
- error summary

Requirements:

- job survives the MCP HTTP request;
- job metadata survives ChatGPT reconnect;
- ideally reconcile jobs after MCP server restart;
- orphan-process recovery;
- multi-hour render/download/generation must not restart just because chat reconnects.

---

# 9. Process / service / port control

Required:

- `list_processes`
- `process_info`
- `find_process`
- `find_process_by_port`
- `start_process`
- `stop_process`
- `restart_process`
- `kill_process`
- `list_ports`
- `check_port`
- `wait_for_port`
- `service_status`
- `start_service`
- `stop_service`
- `restart_service`
- `health_check`

Return when available:

- PID
- executable/name
- command line
- CPU
- memory
- start time
- parent PID
- ports
- state

Critical-process/system-service changes require approval.

---

# 10. System / environment discovery

Required:

- `system_info`
- `cpu_info`
- `memory_info`
- `gpu_info`
- `disk_info`
- `network_info`
- `environment_info`
- `installed_programs`
- `installed_cli_tools`
- `python_versions`
- `node_versions`
- `dependency_versions`
- executable discovery / `which`

Useful production information:

- GPU model
- VRAM
- CUDA/runtime versions
- ffmpeg/ffprobe version
- browser versions
- codec availability
- free disk space

Secrets from environment variables must be redacted by default.

---

# 11. Git / development operations

Required:

- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- `git_branch`
- `git_switch`
- `git_checkout`
- `git_add`
- `git_commit`
- `git_restore`
- `git_stash`
- `git_fetch`
- `git_pull`
- `git_push`
- `git_tag`
- `git_remote`

Approval required for potentially destructive operations such as:

- force push
- destructive reset
- important branch/tag deletion
- history rewriting

---

# 12. Source-code rule — proposal first unless coding was requested

When ChatGPT enters a project for a non-development task, it may:

- read source code;
- understand architecture;
- identify bugs;
- identify bottlenecks;
- identify security/maintenance issues;
- propose improvements;
- write recommendations.

But it must **not silently modify source code just because it found something improvable**.

Modification is allowed when:

1. the user explicitly asked to fix/develop/debug/refactor the project; or
2. ChatGPT proposed the change and the user approved implementation.

When coding work itself is the explicit task, normal source edits within that task scope do not require separate approval for every file.

---

# 13. Project discovery / multi-project support

Required:

- `detect_project`
- `scan_project_structure`
- `find_readme`
- `find_checkpoint`
- `find_config`
- `find_entrypoints`
- `find_tests`
- `find_workflows`
- `find_dependencies`
- `set_workspace`
- `get_workspace`
- `list_recent_workspaces`

The MCP must not be locked to one project.

Every session/task should have an explicit workspace/CWD.

---

# 14. Checkpoint / resume

Required:

- `read_checkpoint`
- `save_checkpoint`
- `append_checkpoint`
- `list_checkpoints`

Checkpoint fields:

- project/workspace
- current task
- objective
- completed steps
- current state
- files changed
- commands run
- tests/results
- running jobs
- output assets
- blockers
- next steps
- timestamp

`WORK_CHECKPOINT.md` can remain the human-readable source of truth.

---

# 15. Audit / recent action history

Desktop Commander exposes recent tool-call history. The custom MCP should too.

Required:

- `get_recent_tool_calls`
- `get_action_history`
- `get_usage_stats`
- `get_recent_errors`

Audit entry:

- timestamp
- session/client
- tool
- action
- target
- result
- approval ID if applicable
- exit code
- duration

Never log secrets as plaintext.

Prefer persistent history instead of RAM-only history.

---

# 16. URL / network / download capability

Required:

- `http_get`
- `http_head`
- `check_url`
- `download_file`
- `download_status`
- resumable large downloads where possible
- checksum verification

Useful:

- DNS lookup
- connectivity test
- localhost endpoint test
- port reachability

Never exfiltrate secrets.

---

# 17. Archive operations

Required:

- `list_archive`
- `zip`
- `unzip`
- `extract_selected`
- `create_archive`
- `verify_archive`

Support at least:

- ZIP
- 7z if 7-Zip is installed

Useful:

- TAR/GZ
- protected archive workflow without exposing passwords in logs

---

# 18. Production / media capabilities

The machine is used for real media production, so first-class helpers are recommended.

Required:

- `ffprobe`
- `ffmpeg_job`
- `inspect_image`
- `inspect_video`
- `inspect_audio`
- `image_metadata`
- `video_metadata`
- `audio_metadata`
- `generate_thumbnail`
- `generate_preview`
- `extract_frame`
- `extract_audio`
- `probe_codec`

Expose:

- resolution
- aspect ratio
- FPS
- duration
- codec
- bitrate
- channels/sample rate
- file size

Allow existing production scripts/workflows on the workstation to run directly.

---

# 19. GUI / desktop automation — needed for true “do everything” coverage

The current Desktop Commander tool set does **not** expose a complete screenshot/mouse/window-control suite.

For a truly universal custom agent, add:

- `screenshot`
- `screenshot_region`
- `list_windows`
- `active_window`
- `window_info`
- `focus_window`
- `move_window`
- `resize_window`
- `open_application`
- `close_application`
- `click`
- `double_click`
- `right_click`
- `mouse_move`
- `drag`
- `scroll`
- `type_text`
- `key_press`
- `hotkey`
- `clipboard_get`
- `clipboard_set`
- `wait_for_window`
- optional Windows UI Automation / accessibility-tree inspection

Preferred order:

1. API
2. CLI
3. Windows UI Automation/accessibility
4. coordinate clicking only as fallback

Consequential UI actions still require approval.

---

# 20. Browser automation — recommended

For browser workflows, add a Playwright/CDP-style layer.

Recommended:

- launch/connect browser
- open URL
- list tabs
- switch tab
- inspect DOM/accessibility tree
- click element
- fill/type
- upload file
- download file
- wait for selector/navigation
- read page text
- screenshot page
- browser console errors
- network errors
- cookie/session use without exposing secrets

Prefer semantic selectors over raw coordinates.

Public posting, payment, deletion, permission changes, or other consequential actions require approval.

---

# 21. Package/software installation and machine administration

For true full-workstation capability, allow the MCP to perform, when explicitly approved:

- package installs/updates
- Windows package-manager operations
- Python package installs
- Node package installs
- application install/uninstall
- environment/PATH changes
- scheduled tasks
- Windows services
- registry changes
- firewall/network configuration
- account/permission changes
- reboot/shutdown
- disk/partition operations

These capabilities should not be permanently unavailable merely because they are powerful.

Use the Approval Gate.

---

# 22. Approval Gate — core security model

The Approval Gate replaces broad permanent restrictions.

## Flow

1. ChatGPT requests an action.
2. MCP classifies it as normal or approval-required.
3. If approval-required, the MCP **does not execute**.
4. MCP returns an approval request.
5. User sees exact details.
6. User selects Allow or Deny.
7. Only then may the exact action execute.

## Approval UI should show

- requested operation
- exact command/action
- target
- reason
- risk
- expected changes
- whether reversible
- estimated paid cost when applicable
- public/private consequence when relevant

Buttons:

- **Allow once**
- **Deny**

Optional:

- **Allow this action class for this session**

Avoid vague permanent “allow everything forever” approvals.

## Bind approval to the exact action

Approval must be tied to:

- action ID
- payload/command hash
- target
- session/user
- expiry

Approving A must never allow a changed B.

---

# 23. Actions that should require approval

At minimum:

- permanent deletion of important data
- large/bulk deletion
- destructive overwrite
- disk formatting/partition changes
- boot changes
- registry/system configuration
- firewall/network administration
- account/password/permission changes
- privilege escalation
- consequential system install/uninstall
- reboot/shutdown
- killing critical OS/service processes
- destructive Git history changes
- force push
- deleting important remote branches/tags
- sending private files to new external destinations
- revealing API keys/tokens/passwords/private keys
- public publish/upload/post
- production deployment with real external effects
- cloud-data deletion
- purchases/payments
- unusually expensive paid-API actions
- remote-access/security changes
- disabling security controls

Goal: **ask on real risk, not approval-spam**.

---

# 24. Actions that normally should NOT require approval

Examples:

- read files
- list directories
- search
- inspect metadata
- analyze source code
- read logs
- git status/diff/log
- tests/lint
- normal builds
- requested renders/production workflows
- create normal work/output files
- write normal files inside current task scope
- temp files
- generated media/assets
- checkpoints
- normal public-resource downloads
- process/port/system inspection

---

# 25. Secrets / credentials

Required:

- detect/redact secrets
- do not echo secrets into normal results
- do not store them in audit logs as plaintext

Protect:

- API keys
- access tokens
- OAuth tokens
- cookies/session tokens
- passwords
- private keys
- credential-bearing connection strings

Example display:

`OPENAI_API_KEY=sk-...REDACTED`

Authorized local processes may use secrets without returning their raw values to ChatGPT.

---

# 26. Recovery / rollback

Recommended:

- recycle bin before permanent delete
- backup before high-impact overwrite/patch
- pre/post diff
- rollback reference
- atomic temp-file + rename writes
- timeout handling
- process cleanup
- orphan-job detection
- crash-safe job metadata

Goal: **maximum capability with recoverability**.

---

# 27. Concurrency / production-scale work

Support:

- multiple searches
- multiple jobs
- multiple terminal sessions
- multiple projects/stories
- concurrent rendering when resources permit

Add resource-awareness:

- CPU/GPU/RAM/disk checks
- queue/priorities
- per-job resource metadata
- cancellation

Never mix output between projects/jobs.

---

# 28. Research + historical-documentary production

The production workflow may create factual historical/documentary content.

Recommended provenance chain:

`Sources → Verified Facts → Research Notes → Narrative Script → Scene Plan → Prompts/Assets → Voice/Audio → Video → QC → Final Export`

Recommended project records:

- source registry
- URL/source metadata
- citation/evidence notes
- fact status: verified / uncertain / disputed
- script version history
- scene manifest
- asset manifest
- production-status tracking
- QC report

Narrative prose must remain distinguishable from verified facts so invented connective narration does not become “historical evidence.”

---

# 29. Minimum acceptance tests

The implementation is not complete until these pass.

## A — Whole-machine file visibility

- list/read/search outside the main project
- confirm workspace remains explicit

## B — File operations

- create
- append
- patch
- copy
- move
- rename
- hash
- recycle/delete a harmless test file

## C — Interactive terminal

- start PowerShell
- start Python REPL
- send follow-up input
- read incremental output
- terminate session

## D — Long job + reconnect

- start multi-minute dummy job
- disconnect/reconnect client
- recover `job_id`
- read ongoing logs
- confirm completion without restarting

## E — Process/port control

- start local test server
- discover PID by port
- health check
- stop/restart

## F — Rich formats

- read image
- inspect PDF
- read/edit DOCX test copy
- read/update Excel test copy

## G — Search

- filename
- content
- regex
- progressive results
- cancel

## H — Approval Gate

Using harmless test targets, verify:

- action is not executed before approval
- exact action is displayed
- Deny prevents it
- Allow executes it
- approval cannot be replayed for a changed command

## I — Secrets

- create dummy fake API key
- verify result/log redaction

## J — Source-code proposal-only

- enter project for non-coding work
- identify improvement
- verify no source modification occurs

## K — Audit/checkpoint/recovery

- verify action history
- save checkpoint
- reconnect
- continue from checkpoint

## L — GUI, if implemented

- screenshot
- open/focus harmless app
- type/click harmless controls
- consequential action triggers approval

---

# 30. Final parity checklist

The custom MCP can be considered **Desktop Commander parity+** when:

- [ ] full authorized filesystem can be read/searched
- [ ] files can be created/edited/copied/moved/renamed
- [ ] surgical patching exists
- [ ] multi-file reads exist
- [ ] rich formats exist
- [ ] streaming search exists
- [ ] terminal is interactive
- [ ] incremental stdout/stderr exists
- [ ] long jobs survive reconnect
- [ ] processes can be inspected/controlled
- [ ] ports/services can be inspected
- [ ] system/environment can be inspected
- [ ] Git workflow is supported
- [ ] project discovery exists
- [ ] multi-project workspaces exist
- [ ] checkpoint/resume exists
- [ ] recent action/tool history exists
- [ ] URL/download tools exist
- [ ] media production helpers exist
- [ ] GUI automation exists for true full-workstation coverage
- [ ] browser automation exists for browser workflows
- [ ] secrets are redacted
- [ ] audit logging exists
- [ ] risky operations pause before execution
- [ ] exact approval resumes exact action
- [ ] source code is proposal-only unless editing is explicitly in scope
- [ ] rollback/recovery exists
- [ ] tools/capabilities are self-describing

---

# 31. Recommended permission model

Do not design around one huge permanent forbidden-command list.

## Tier 0 — Observe

Automatic:

- read
- list
- search
- inspect
- metadata

## Tier 1 — Normal work

Automatic inside the user-requested scope:

- write/create
- normal commands
- tests
- build
- render
- production workflows
- ordinary downloads

## Tier 2 — Consequential

Approval required:

- destructive operations
- privacy-sensitive actions
- external publishing
- costly actions
- system/service changes

## Tier 3 — Critical

Strong explicit approval with exact target/action:

- disk/partition
- boot/security settings
- credentials/accounts
- large irreversible deletion
- critical machine administration

This gives the AI freedom for routine work while preserving the user as final authority at real-risk boundaries.

---

# 32. Deliverables from the developer

After implementation, provide:

1. complete tool list;
2. tool schemas/parameters;
3. parity matrix against Desktop Commander;
4. automatic-operation list;
5. approval-required-operation list;
6. approval-flow architecture;
7. long-job/reconnect architecture;
8. secret-redaction architecture;
9. checkpoint/recovery architecture;
10. acceptance-test results;
11. known limitations;
12. updated documentation;
13. source-control commit containing implementation.

---

# 33. Bottom line

The target is not “24 tools.”

The target is a **complete machine-control layer** with the same practical freedom ChatGPT currently gets from Desktop Commander, plus capabilities that Desktop Commander does not currently expose directly, especially:

- approval-gated system administration instead of broad permanent blocking;
- durable long-running jobs;
- reconnect/resume;
- GUI/window/mouse/keyboard/clipboard automation;
- browser automation;
- production/media helpers;
- persistent checkpoint/audit state;
- explicit source-code proposal-only policy.

**Desired final behavior:** ChatGPT can use the authorized workstation as a complete working environment, while the user remains the final authority for genuinely risky actions.

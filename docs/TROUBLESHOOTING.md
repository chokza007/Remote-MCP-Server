# Troubleshooting

## Server does not start

Run `node --version` (must be 24.15.x or newer 24.x), `npm ci`, `npm run build`, and `scripts\service\status.ps1`. Inspect the dedicated ProgramData logs without posting secret values. Port 7331 may already be occupied; use the port tools or `Get-NetTCPConnection -LocalPort 7331` to identify the owner. Do not bind a non-loopback address without remote OAuth and HTTPS proxy configuration.

## Client says authorization required

Confirm the principal/client is the one previously trusted, the server device/data root did not change, Emergency Stop is clear, and the grant was not revoked, disconnected, unlinked, or invalidated by a security reset. A copied database on another device intentionally does not reuse trust. Re-authorize through the owner page rather than editing SQLite.

## Browser, GUI, document, media, Git, or broker unavailable

Run the health/self-test tool. Browser needs supported Edge/Chrome; GUI needs an interactive unlocked Windows desktop; OCR/DOCX/XLSX uses the pinned Python helper environment; media needs FFmpeg/ffprobe; Git needs `git.exe`; the privileged broker needs .NET and one elevated install. Optional absence is reported explicitly. Secure desktop, CAPTCHA, and MFA require the user.

## Long job stopped after reconnect

Read job status, events, and bounded logs. `authorization_revoked` means the next step correctly stopped after trust changed. `needs_attention` means a handler did not produce verification evidence. `orphaned` means a terminal/process could not safely be reattached. Do not mark such jobs successful manually; retry an idempotent step or submit a verified replacement.

## Database busy/full or backup/restore failure

Stop competing service instances and confirm free disk space. Use only the provided backup/restore scripts. Restore verifies sizes and SHA-256 before mutation and rejects tampered/incomplete sets. Never restore into a running service or overwrite the only backup. Keep backup ACLs as restrictive as the original data root.

## Emergency recovery

Activate `scripts\operations\emergency-stop.ps1 -Force`, preserve logs and a backup, disconnect remote access, then use `security-reset.ps1` if credentials or trust may be compromised. Rotate external credentials separately. After investigation, start the service, verify health, and authorize a fresh client. Redact tokens, private paths/content, and database files before filing a GitHub issue.

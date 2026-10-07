# Authorization

The primary mode is persistent **Full Access**. First connection creates a pending request bound to authenticated principal/client and the server device. The owner approves once. The resulting signed grant records grant ID, scopes, creation actor/time, security epoch, and `expiresAt: null`; it survives chat changes, reconnects, service restarts, Windows restarts, and ordinary passage of time.

Policy—not a fixed risk tier—determines the authorization level. A valid Full Access `computer:*` grant satisfies tiers 0–3 without per-action approval. `Ask for Sensitive Actions` may require an approval record; `Read Only` cannot authorize mutation. Approval requests are payload/target bound and cannot be replayed for an altered action.

Every action resolves the current grant. Durable jobs, schedules, and watches recheck immediately before each step/dispatch. Revoke, client disconnect, device unlink, credential/client invalidation, security-epoch rotation, or Emergency Stop therefore affects the next action rather than waiting for reconnect. Existing results are retained for audit; no new mutation is allowed.

The owner console is dark themed and exposes trusted-client summaries, not bearer tokens. Emergency Stop is deliberately separate from revoke: it freezes normal actions globally while owner recovery controls remain available. Clearing it requires an authenticated local owner path. A security reset is stronger and invalidates all trust material.

Full Access is not magic elevation. Operations still run under the server account unless the separately installed broker handles an allowed administrator action. Windows ACLs, secure desktop/UAC installation, CAPTCHA, MFA, provider consent, and unavailable executables remain external boundaries.

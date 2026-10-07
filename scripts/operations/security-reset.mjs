import Database from "better-sqlite3";

const [databasePath, timestamp] = process.argv.slice(2);
if (!databasePath || !timestamp) throw new Error("usage: security-reset.mjs <database> <timestamp>");
const database = new Database(databasePath, { fileMustExist: true });
try {
  database.pragma("foreign_keys = ON");
  database.transaction(() => {
    const identity = database.prepare("SELECT security_epoch FROM server_identity WHERE id = 1").get();
    if (!identity) throw new Error("Server identity is not initialized");
    const grants = database.prepare("SELECT id FROM trusted_grants WHERE revoked_at IS NULL").all();
    const event = database.prepare(`
      INSERT INTO grant_events(grant_id, event_type, actor, occurred_at, details_json)
      VALUES (?, 'revoked', 'system:security-reset', ?, '{"reason":"security_reset"}')
    `);
    for (const grant of grants) event.run(grant.id, timestamp);
    database.prepare(`
      UPDATE trusted_grants SET revoked_at = ?, revoked_by = 'system:security-reset', revoke_reason = 'security_reset'
      WHERE revoked_at IS NULL
    `).run(timestamp);
    database.prepare("UPDATE server_identity SET security_epoch = security_epoch + 1, updated_at = ? WHERE id = 1").run(timestamp);
    database.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?)").run(timestamp);
    database.prepare("UPDATE oauth_clients SET status = 'pending', approved_at = NULL, disconnected_at = NULL").run();
    database.prepare("UPDATE oauth_authorization_requests SET decision = COALESCE(decision, 'denied'), decided_at = COALESCE(decided_at, ?)").run(timestamp);
    database.prepare("UPDATE oauth_authorization_codes SET consumed_at = COALESCE(consumed_at, ?)").run(timestamp);
    database.prepare("UPDATE sessions SET disconnected_at = COALESCE(disconnected_at, ?), last_seen_at = ?").run(timestamp, timestamp);
    database.prepare("UPDATE approvals SET decision = 'denied', decided_at = ? WHERE decision = 'pending'").run(timestamp);
    database.prepare(`
      INSERT INTO operational_state(namespace, key, value_json, updated_at)
      VALUES ('security', 'last_reset', ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify({ at: timestamp, previousEpoch: identity.security_epoch }), timestamp);
  })();
} finally {
  database.close();
}

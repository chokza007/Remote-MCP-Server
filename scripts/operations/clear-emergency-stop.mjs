import Database from "better-sqlite3";

const [databasePath, timestamp, actor] = process.argv.slice(2);
if (!databasePath || !timestamp || !actor || !Number.isFinite(Date.parse(timestamp))) {
  throw new Error("usage: clear-emergency-stop.mjs <database> <iso-timestamp> <authenticated-owner>");
}
if (!actor.startsWith("owner:")) {
  throw new Error("Local owner recovery requires an owner identity");
}
const database = new Database(databasePath, { fileMustExist: true });
try {
  const state = { active: false, actor, reason: "cleared", changedAt: timestamp };
  database.transaction(() => {
    database.prepare(`
      INSERT INTO operational_state(namespace, key, value_json, updated_at)
      VALUES ('security', 'emergency_stop', ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(state), timestamp);
  })();
  process.stdout.write(JSON.stringify(state) + "\n");
} finally {
  database.close();
}

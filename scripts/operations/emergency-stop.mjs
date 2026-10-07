import Database from "better-sqlite3";

const [databasePath, timestamp, actor, reason] = process.argv.slice(2);
if (!databasePath || !timestamp || !actor || !reason) {
  throw new Error("usage: emergency-stop.mjs <database> <timestamp> <actor> <reason>");
}
const database = new Database(databasePath, { fileMustExist: true });
try {
  database.prepare(`
    INSERT INTO operational_state(namespace, key, value_json, updated_at)
    VALUES ('security', 'emergency_stop', ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify({ active: true, actor, reason, changedAt: timestamp }), timestamp);
} finally {
  database.close();
}

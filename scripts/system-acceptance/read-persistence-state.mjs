import Database from "better-sqlite3";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Usage: node read-persistence-state.mjs <operational.db>");
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const identity = database.prepare(
    "SELECT device_id AS deviceId, security_epoch AS securityEpoch FROM server_identity WHERE id = 1"
  ).get();
  if (!identity) throw new Error("Server identity is missing");
  const grants = database.prepare(
    "SELECT COUNT(*) AS count FROM trusted_grants WHERE revoked_at IS NULL AND mode = 'full_access'"
  ).get();
  process.stdout.write(JSON.stringify({ ...identity, activeGrants: Number(grants.count) }));
} finally {
  database.close();
}

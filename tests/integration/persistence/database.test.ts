import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

interface SqlConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
}

interface OperationalDatabase {
  read<T>(reader: (connection: SqlConnection) => T): T;
  writeTransaction<T>(writer: (connection: SqlConnection) => T): T;
  integrityCheck(): readonly string[];
  backup(destination: string): Promise<void>;
  close(): void;
}

interface PersistenceModule {
  openDatabase?: (options: {
    filename: string;
    migrationsDirectory?: string;
    busyTimeoutMs?: number;
    readonly?: boolean;
  }) => OperationalDatabase;
  migrateDatabase?: (
    database: OperationalDatabase,
    options?: { migrationsDirectory?: string }
  ) => { applied: number; currentVersion: number };
}

const requiredTables = [
  "actions",
  "approvals",
  "approval_uses",
  "artifacts",
  "artifact_relations",
  "audit_events",
  "capability_runs",
  "clients",
  "credential_refs",
  "devices",
  "grant_events",
  "grant_scopes",
  "job_events",
  "job_logs",
  "job_steps",
  "jobs",
  "lock_leases",
  "notifications",
  "operational_state",
  "principals",
  "recovery_points",
  "resource_locks",
  "runtime_checkpoints",
  "schedules",
  "schema_migrations",
  "search_results",
  "searches",
  "server_identity",
  "sessions",
  "tool_versions",
  "transaction_changes",
  "transactions",
  "trusted_grants",
  "watch_events",
  "watches",
  "workspaces"
] as const;

describe("operational database", () => {
  let fixtureRoot: string;
  const openDatabases: OperationalDatabase[] = [];

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "remote-mcp-database-"));
  });

  afterEach(async () => {
    while (openDatabases.length > 0) {
      openDatabases.pop()?.close();
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function loadPersistence(): Promise<Required<PersistenceModule>> {
    const persistence = (await import("@remote-mcp/persistence")) as PersistenceModule;
    expect(typeof persistence.openDatabase).toBe("function");
    expect(typeof persistence.migrateDatabase).toBe("function");
    return persistence as Required<PersistenceModule>;
  }

  function track(database: OperationalDatabase): OperationalDatabase {
    openDatabases.push(database);
    return database;
  }

  test("enables durable SQLite safety settings and applies the core migration once", async () => {
    const persistence = await loadPersistence();
    const database = track(
      persistence.openDatabase({
        filename: join(fixtureRoot, "operational.db"),
        busyTimeoutMs: 5_000
      })
    );

    expect(database.read((connection) => connection.pragma("journal_mode", { simple: true }))).toBe(
      "wal"
    );
    expect(database.read((connection) => connection.pragma("foreign_keys", { simple: true }))).toBe(
      1
    );
    expect(database.read((connection) => connection.pragma("busy_timeout", { simple: true }))).toBe(
      5_000
    );

    expect(persistence.migrateDatabase(database)).toEqual({ applied: 1, currentVersion: 1 });
    expect(persistence.migrateDatabase(database)).toEqual({ applied: 0, currentVersion: 1 });

    const tables = database.read((connection) =>
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)
    );
    expect(tables).toEqual(expect.arrayContaining(requiredTables));
    expect(database.integrityCheck()).toEqual(["ok"]);
  });

  test("persists operational state after close and produces a readable backup", async () => {
    const persistence = await loadPersistence();
    const filename = join(fixtureRoot, "operational.db");
    const backupFilename = join(fixtureRoot, "backup.db");
    const first = track(persistence.openDatabase({ filename }));
    persistence.migrateDatabase(first);

    first.writeTransaction((connection) => {
      connection
        .prepare(
          "INSERT INTO operational_state(namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run("workspace:test", "cursor", '{"offset":42}', "2026-10-06T15:00:00.000Z");
    });
    await first.backup(backupFilename);
    first.close();
    openDatabases.splice(openDatabases.indexOf(first), 1);

    const reopened = track(persistence.openDatabase({ filename }));
    const restored = reopened.read((connection) =>
      connection
        .prepare("SELECT value_json FROM operational_state WHERE namespace = ? AND key = ?")
        .get("workspace:test", "cursor")
    );
    expect(restored).toEqual({ value_json: '{"offset":42}' });

    const backup = track(persistence.openDatabase({ filename: backupFilename, readonly: true }));
    expect(
      backup.read((connection) =>
        connection
          .prepare("SELECT value_json FROM operational_state WHERE namespace = ? AND key = ?")
          .get("workspace:test", "cursor")
      )
    ).toEqual({ value_json: '{"offset":42}' });
  });

  test("rejects a migration whose applied checksum changes", async () => {
    const persistence = await loadPersistence();
    const migrationDirectory = join(fixtureRoot, "migrations");
    const sourceMigration = resolve(
      process.cwd(),
      "packages/persistence/migrations/001_operational_core.sql"
    );
    await import("node:fs/promises").then(({ mkdir }) => mkdir(migrationDirectory));
    const copiedMigration = join(migrationDirectory, "001_operational_core.sql");
    await copyFile(sourceMigration, copiedMigration);

    const database = track(
      persistence.openDatabase({
        filename: join(fixtureRoot, "checksum.db"),
        migrationsDirectory: migrationDirectory
      })
    );
    expect(
      persistence.migrateDatabase(database, { migrationsDirectory: migrationDirectory })
    ).toEqual({ applied: 1, currentVersion: 1 });

    const original = await readFile(copiedMigration, "utf8");
    await writeFile(copiedMigration, `${original}\n-- unexpected mutation\n`, "utf8");

    expect(() =>
      persistence.migrateDatabase(database, { migrationsDirectory: migrationDirectory })
    ).toThrow(/checksum/i);
  });
});

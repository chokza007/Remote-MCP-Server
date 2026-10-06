import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { OperationalDatabase } from "./database.js";

export interface MigrationOptions {
  readonly migrationsDirectory?: string;
}

export interface MigrationResult {
  readonly applied: number;
  readonly currentVersion: number;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

function checksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function loadMigrations(directory: string): readonly MigrationFile[] {
  const migrations = readdirSync(directory)
    .map((name) => {
      const match = /^(\d+)_.*\.sql$/u.exec(name);
      if (!match) {
        return undefined;
      }

      const version = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Invalid migration version in ${name}`);
      }

      const sql = readFileSync(resolve(directory, name), "utf8");
      return { version, name, checksum: checksum(sql), sql } satisfies MigrationFile;
    })
    .filter((migration): migration is MigrationFile => migration !== undefined)
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]?.version === migrations[index]?.version) {
      throw new Error(`Duplicate migration version: ${migrations[index]?.version}`);
    }
  }

  return migrations;
}

export function migrateDatabase(
  database: OperationalDatabase,
  options: MigrationOptions = {}
): MigrationResult {
  const directory =
    options.migrationsDirectory ??
    database.migrationsDirectory ??
    resolve(process.cwd(), "packages/persistence/migrations");

  database.writeTransaction((connection) => {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  });

  const appliedRows = database.read((connection) =>
    connection
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as AppliedMigrationRow[]
  );
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const migrations = loadMigrations(directory);
  let applied = 0;

  for (const migration of migrations) {
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for version ${migration.version}: ${migration.name}`
        );
      }
      continue;
    }

    database.writeTransaction((connection) => {
      connection.exec(migration.sql);
      connection
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        )
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    applied += 1;
  }

  const currentVersion = database.read((connection) => {
    const row = connection
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  });

  return { applied, currentVersion };
}

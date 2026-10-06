import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";

export interface DatabaseOptions {
  readonly filename: string;
  readonly migrationsDirectory?: string;
  readonly busyTimeoutMs?: number;
  readonly readonly?: boolean;
}

export class OperationalDatabase {
  readonly #connection: SqliteDatabase;
  public readonly migrationsDirectory: string | undefined;

  public constructor(connection: SqliteDatabase, migrationsDirectory?: string) {
    this.#connection = connection;
    this.migrationsDirectory = migrationsDirectory;
  }

  public read<Result>(reader: (connection: SqliteDatabase) => Result): Result {
    return reader(this.#connection);
  }

  public writeTransaction<Result>(writer: (connection: SqliteDatabase) => Result): Result {
    return this.#connection.transaction(() => writer(this.#connection))();
  }

  public integrityCheck(): readonly string[] {
    const rows = this.#connection.pragma("integrity_check") as Array<{
      integrity_check: unknown;
    }>;
    return rows.map((row) => String(row.integrity_check));
  }

  public async backup(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await this.#connection.backup(destination);
  }

  public close(): void {
    if (this.#connection.open) {
      this.#connection.close();
    }
  }
}

export function openDatabase(options: DatabaseOptions): OperationalDatabase {
  const readonly = options.readonly ?? false;
  const connection = new BetterSqlite3(options.filename, {
    readonly,
    fileMustExist: readonly
  });

  connection.pragma("foreign_keys = ON");
  connection.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  if (!readonly) {
    connection.pragma("journal_mode = WAL");
    connection.pragma("synchronous = NORMAL");
  }

  return new OperationalDatabase(connection, options.migrationsDirectory);
}

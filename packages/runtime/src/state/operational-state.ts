import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface OperationalStateRecord {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

export interface SetOperationalStateInput {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}

export interface OperationalStateServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
  readonly maxValueBytes?: number;
}

interface StateRow {
  readonly namespace: string;
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: string;
}

function record(row: StateRow): OperationalStateRecord {
  return { namespace: row.namespace, key: row.key, value: JSON.parse(row.value_json) as unknown, updatedAt: row.updated_at };
}

export class OperationalStateService {
  private readonly database: OperationalDatabase;
  private readonly now: () => Date;
  private readonly maxValueBytes: number;

  public constructor(options: OperationalStateServiceOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.maxValueBytes = options.maxValueBytes ?? 256 * 1024;
  }

  public set(input: SetOperationalStateInput): OperationalStateRecord {
    this.validate(input.namespace, input.key);
    const value = JSON.stringify(input.value);
    if (value === undefined) throw new Error("Operational state must be JSON serializable");
    if (Buffer.byteLength(value, "utf8") > this.maxValueBytes) {
      throw new Error(`Operational state is bounded to ${this.maxValueBytes} bytes`);
    }
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO operational_state(namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(input.namespace, input.key, value, now);
    });
    return this.get(input.namespace, input.key)!;
  }

  public get(namespace: string, key: string): OperationalStateRecord | null {
    this.validate(namespace, key);
    const row = this.database.read((connection) => connection.prepare(
      "SELECT * FROM operational_state WHERE namespace = ? AND key = ?"
    ).get(namespace, key) as StateRow | undefined);
    return row ? record(row) : null;
  }

  public list(namespace: string): readonly OperationalStateRecord[] {
    if (namespace.trim().length === 0) throw new Error("Operational namespace must not be empty");
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM operational_state WHERE namespace = ? ORDER BY key").all(namespace) as StateRow[]).map(record)
    );
  }

  public delete(namespace: string, key: string): boolean {
    this.validate(namespace, key);
    return this.database.writeTransaction((connection) =>
      connection.prepare("DELETE FROM operational_state WHERE namespace = ? AND key = ?").run(namespace, key).changes === 1
    );
  }

  private validate(namespace: string, key: string): void {
    if (namespace.trim().length === 0 || key.trim().length === 0) {
      throw new Error("Operational namespace and key are required");
    }
    if (key.length > 512) throw new Error("Operational state key is too long");
  }
}

export function createOperationalStateService(options: OperationalStateServiceOptions): OperationalStateService {
  return new OperationalStateService(options);
}

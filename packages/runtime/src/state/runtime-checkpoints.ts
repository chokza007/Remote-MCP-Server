import { randomUUID } from "node:crypto";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface RuntimeCheckpoint {
  readonly checkpointId: string;
  readonly namespace: string;
  readonly operation: string;
  readonly state: "active" | "completed";
  readonly data: unknown;
  readonly verification: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface SaveRuntimeCheckpointInput {
  readonly checkpointId?: string;
  readonly namespace: string;
  readonly operation: string;
  readonly state: unknown;
  readonly verification?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCheckpointServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
  readonly maxStateBytes?: number;
}

interface CheckpointRow {
  readonly id: string;
  readonly namespace: string;
  readonly state_json: string;
  readonly verification_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface StoredCheckpointState {
  readonly operation: string;
  readonly data: unknown;
}

function checkpoint(row: CheckpointRow): RuntimeCheckpoint {
  const value = JSON.parse(row.state_json) as StoredCheckpointState;
  return {
    checkpointId: row.id,
    namespace: row.namespace,
    operation: value.operation,
    state: row.completed_at === null ? "active" : "completed",
    data: value.data,
    verification: JSON.parse(row.verification_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function notFound(id: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "RUNTIME_CHECKPOINT_NOT_FOUND",
    message: "The runtime checkpoint does not exist in this namespace.",
    retryable: false,
    suggestedAction: "List runtime checkpoints in the current namespace before retrying.",
    target: id
  });
}

export class RuntimeCheckpointService {
  private readonly database: OperationalDatabase;
  private readonly now: () => Date;
  private readonly maxStateBytes: number;

  public constructor(options: RuntimeCheckpointServiceOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.maxStateBytes = options.maxStateBytes ?? 1024 * 1024;
  }

  public save(input: SaveRuntimeCheckpointInput): RuntimeCheckpoint {
    if (input.namespace.trim().length === 0 || input.operation.trim().length === 0) {
      throw new Error("Runtime checkpoint namespace and operation are required");
    }
    const checkpointId = input.checkpointId ?? randomUUID();
    const stateJson = JSON.stringify({ operation: input.operation, data: input.state } satisfies StoredCheckpointState);
    const verificationJson = JSON.stringify(input.verification ?? {});
    if (Buffer.byteLength(stateJson, "utf8") > this.maxStateBytes) {
      throw new Error(`Runtime checkpoint state is bounded to ${this.maxStateBytes} bytes`);
    }
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      const existing = connection.prepare("SELECT namespace FROM runtime_checkpoints WHERE id = ?").get(checkpointId) as
        { namespace: string } | undefined;
      if (existing && existing.namespace !== input.namespace) throw notFound(checkpointId);
      connection.prepare(
        `INSERT INTO runtime_checkpoints(id, namespace, state_json, verification_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json,
           verification_json = excluded.verification_json, updated_at = excluded.updated_at, completed_at = NULL`
      ).run(checkpointId, input.namespace, stateJson, verificationJson, now, now);
    });
    return this.load(checkpointId, input.namespace);
  }

  public load(checkpointId: string, namespace: string): RuntimeCheckpoint {
    const row = this.database.read((connection) => connection.prepare(
      "SELECT * FROM runtime_checkpoints WHERE id = ? AND namespace = ?"
    ).get(checkpointId, namespace) as CheckpointRow | undefined);
    if (!row) throw notFound(checkpointId);
    return checkpoint(row);
  }

  public list(namespace: string, includeCompleted = true): readonly RuntimeCheckpoint[] {
    if (namespace.trim().length === 0) throw new Error("Runtime checkpoint namespace must not be empty");
    return this.database.read((connection) =>
      ((includeCompleted
        ? connection.prepare("SELECT * FROM runtime_checkpoints WHERE namespace = ? ORDER BY updated_at, id").all(namespace)
        : connection.prepare(
          "SELECT * FROM runtime_checkpoints WHERE namespace = ? AND completed_at IS NULL ORDER BY updated_at, id"
        ).all(namespace)) as CheckpointRow[]).map(checkpoint)
    );
  }

  public complete(
    checkpointId: string,
    namespace: string,
    verification: Readonly<Record<string, unknown>> = {}
  ): RuntimeCheckpoint {
    const current = this.load(checkpointId, namespace);
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare(
        "UPDATE runtime_checkpoints SET verification_json = ?, updated_at = ?, completed_at = ? WHERE id = ? AND namespace = ?"
      ).run(JSON.stringify({ ...current.verification, ...verification }), now, now, checkpointId, namespace);
    });
    return this.load(checkpointId, namespace);
  }
}

export function createRuntimeCheckpointService(options: RuntimeCheckpointServiceOptions): RuntimeCheckpointService {
  return new RuntimeCheckpointService(options);
}

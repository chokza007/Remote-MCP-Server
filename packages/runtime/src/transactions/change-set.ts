import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { RecoveryStore } from "./recovery-store.js";

export type TransactionState =
  | "draft"
  | "previewing"
  | "previewed"
  | "committing"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "failed"
  | "needs_attention";

export type ChangeState =
  | "pending"
  | "prepared"
  | "applying"
  | "applied"
  | "verified"
  | "compensating"
  | "compensated"
  | "failed";

export interface ChangeSpec {
  readonly changeId: string;
  readonly kind: string;
  readonly target: string;
  readonly payload: unknown;
}

export interface PreparedChange {
  readonly preview: unknown;
  readonly recovery: unknown;
}

export interface ChangeVerification {
  readonly valid: boolean;
  readonly evidence?: unknown;
}

export interface ChangeContext {
  readonly transactionId: string;
  readonly recovery: RecoveryStore;
  assertFence(target: string): Promise<void>;
}

export interface ChangeAdapter {
  readonly kind: string;
  readonly atomic: boolean;
  prepare(change: ChangeSpec, context: ChangeContext): Promise<PreparedChange>;
  apply(change: ChangeSpec, prepared: PreparedChange, context: ChangeContext): Promise<unknown>;
  verify(change: ChangeSpec, prepared: PreparedChange, result: unknown, context: ChangeContext): Promise<ChangeVerification>;
  compensate(change: ChangeSpec, prepared: PreparedChange, result: unknown, context: ChangeContext): Promise<void>;
}

export interface TransactionChangeRecord extends ChangeSpec {
  readonly position: number;
  readonly atomic: boolean;
  readonly state: ChangeState;
  readonly prepared: PreparedChange | null;
  readonly result: unknown;
  readonly verification: ChangeVerification | null;
}

export interface TransactionRecord {
  readonly transactionId: string;
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly state: TransactionState;
  readonly previewEvidence: string | null;
  readonly lockLeaseId: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly changes: readonly TransactionChangeRecord[];
}

interface TransactionRow {
  readonly id: string;
  readonly owner_id: string;
  readonly workspace_id: string | null;
  readonly state: TransactionState;
  readonly preview_evidence: string | null;
  readonly lock_lease_id: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface ChangeRow {
  readonly sequence: number;
  readonly change_id: string;
  readonly kind: string;
  readonly target: string;
  readonly payload_json: string;
  readonly atomic: number;
  readonly state: ChangeState;
  readonly prepared_json: string | null;
  readonly result_json: string | null;
  readonly verification_json: string | null;
}

function parseNullable<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

export class ChangeSetRepository {
  public constructor(private readonly database: OperationalDatabase) {}

  public insert(
    transactionId: string,
    ownerId: string,
    workspaceId: string | undefined,
    changes: ReadonlyArray<ChangeSpec & { readonly atomic: boolean }>,
    now: string
  ): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO transactions(id, workspace_id, state, preview_json, created_at, updated_at, owner_id)
         VALUES (?, ?, 'draft', '{}', ?, ?, ?)`
      ).run(transactionId, workspaceId ?? null, now, now, ownerId);
      const insert = connection.prepare(
        `INSERT INTO transaction_changes(
          transaction_id, sequence, target_identity, change_json, state,
          change_id, kind, target, payload_json, atomic
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      );
      changes.forEach((change, position) => insert.run(
        transactionId,
        position,
        change.target,
        JSON.stringify(change),
        change.changeId,
        change.kind,
        change.target,
        JSON.stringify(change.payload),
        change.atomic ? 1 : 0
      ));
    });
  }

  public get(transactionId: string): TransactionRecord {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId) as TransactionRow | undefined
    );
    if (!row) throw new Error(`Unknown transaction: ${transactionId}`);
    const changes = this.database.read((connection) =>
      connection.prepare("SELECT * FROM transaction_changes WHERE transaction_id = ? ORDER BY sequence").all(transactionId) as ChangeRow[]
    ).map((change): TransactionChangeRecord => ({
      position: change.sequence,
      changeId: change.change_id,
      kind: change.kind,
      target: change.target,
      payload: JSON.parse(change.payload_json) as unknown,
      atomic: change.atomic === 1,
      state: change.state,
      prepared: parseNullable<PreparedChange>(change.prepared_json),
      result: parseNullable<unknown>(change.result_json),
      verification: parseNullable<ChangeVerification>(change.verification_json)
    }));
    return {
      transactionId: row.id,
      ownerId: row.owner_id,
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      state: row.state,
      previewEvidence: row.preview_evidence,
      lockLeaseId: row.lock_lease_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      changes
    };
  }

  public listRecoverable(ownerId?: string): readonly TransactionRecord[] {
    const ids = this.database.read((connection) =>
      (ownerId === undefined
        ? connection.prepare(
          "SELECT id FROM transactions WHERE state IN ('previewing','committing','rolling_back','failed') ORDER BY created_at, id"
        ).all()
        : connection.prepare(
          "SELECT id FROM transactions WHERE owner_id = ? AND state IN ('previewing','committing','rolling_back','failed') ORDER BY created_at, id"
        ).all(ownerId)) as Array<{ id: string }>
    );
    return ids.map((row) => this.get(row.id));
  }

  public setTransactionState(
    transactionId: string,
    state: TransactionState,
    now: string,
    values: { readonly previewEvidence?: string | null; readonly lockLeaseId?: string | null; readonly error?: string | null } = {}
  ): void {
    const terminal = ["committed", "rolled_back", "failed", "needs_attention"].includes(state);
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE transactions SET state = ?, updated_at = ?,
          preview_evidence = CASE WHEN ? = 0 THEN preview_evidence ELSE ? END,
          lock_lease_id = CASE WHEN ? = 0 THEN lock_lease_id ELSE ? END,
          error = CASE WHEN ? = 0 THEN error ELSE ? END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          committed_at = CASE WHEN ? = 'committed' THEN ? ELSE committed_at END,
          rolled_back_at = CASE WHEN ? = 'rolled_back' THEN ? ELSE rolled_back_at END
         WHERE id = ?`
      ).run(
        state,
        now,
        values.previewEvidence === undefined ? 0 : 1,
        values.previewEvidence ?? null,
        values.lockLeaseId === undefined ? 0 : 1,
        values.lockLeaseId ?? null,
        values.error === undefined ? 0 : 1,
        values.error ?? null,
        terminal ? 1 : 0,
        now,
        state,
        now,
        state,
        now,
        transactionId
      );
    });
  }

  public setChangeState(
    transactionId: string,
    position: number,
    state: ChangeState,
    values: { readonly prepared?: PreparedChange; readonly result?: unknown; readonly verification?: ChangeVerification } = {},
    now = new Date().toISOString()
  ): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE transaction_changes SET state = ?,
          prepared_json = CASE WHEN ? = 0 THEN prepared_json ELSE ? END,
          result_json = CASE WHEN ? = 0 THEN result_json ELSE ? END,
          verification_json = CASE WHEN ? = 0 THEN verification_json ELSE ? END
         WHERE transaction_id = ? AND sequence = ?`
      ).run(
        state,
        values.prepared === undefined ? 0 : 1,
        values.prepared === undefined ? null : JSON.stringify(values.prepared),
        values.result === undefined ? 0 : 1,
        values.result === undefined ? null : JSON.stringify(values.result),
        values.verification === undefined ? 0 : 1,
        values.verification === undefined ? null : JSON.stringify(values.verification),
        transactionId,
        position
      );
      if (values.prepared !== undefined) {
        const target = (connection.prepare(
          "SELECT target_identity FROM transaction_changes WHERE transaction_id = ? AND sequence = ?"
        ).get(transactionId, position) as { target_identity: string }).target_identity;
        connection.prepare(
          `INSERT OR REPLACE INTO recovery_points(id, transaction_id, target_identity, recovery_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(`${transactionId}:${position}`, transactionId, target, JSON.stringify(values.prepared.recovery), now);
      }
    });
  }

  public setPreview(transactionId: string, preview: unknown): void {
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE transactions SET preview_json = ? WHERE id = ?")
        .run(JSON.stringify(preview), transactionId);
    });
  }
}

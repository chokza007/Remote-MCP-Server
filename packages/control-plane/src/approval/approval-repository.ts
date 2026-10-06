import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { ActionContext } from "../policy/action-context.js";

export interface ApprovalRecord {
  readonly id: string;
  readonly actionName: string;
  readonly actionVersion: string;
  readonly payloadHash: string;
  readonly targetsJson: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly sessionId: string | null;
  readonly riskTier: number;
  readonly actionClass: string;
  readonly nonce: string;
  readonly previewJson: string;
  readonly recoveryJson: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decision: "pending" | "approved" | "denied";
  readonly decidedAt: string | null;
}

interface ApprovalRow {
  readonly id: string;
  readonly action_name: string;
  readonly action_version: string;
  readonly payload_hash: string;
  readonly targets_json: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly session_id: string | null;
  readonly risk_tier: number;
  readonly action_class: string;
  readonly nonce: string;
  readonly preview_json: string;
  readonly recovery_json: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decision: "pending" | "approved" | "denied";
  readonly decided_at: string | null;
}

export class ApprovalRepository {
  readonly #database: OperationalDatabase;

  public constructor(database: OperationalDatabase) {
    this.#database = database;
  }

  public insert(record: ApprovalRecord, context: ActionContext): void {
    this.#database.writeTransaction((connection) => {
      connection
        .prepare("INSERT OR IGNORE INTO principals(id, display_name, created_at) VALUES (?, ?, ?)")
        .run(record.principalId, record.principalId, record.createdAt);
      connection
        .prepare(
          `INSERT OR IGNORE INTO devices(id, label, linked_at)
           VALUES (?, 'Approval client device', ?)`
        )
        .run(context.identity.deviceId, record.createdAt);
      connection
        .prepare(
          `INSERT OR IGNORE INTO clients(id, principal_id, label, credential_state, created_at)
           VALUES (?, ?, ?, 'active', ?)`
        )
        .run(record.clientId, record.principalId, record.clientId, record.createdAt);
      if (record.sessionId !== null) {
        connection
          .prepare(
            `INSERT OR IGNORE INTO sessions(
               id, principal_id, client_id, device_id, connected_at, last_seen_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.sessionId,
            record.principalId,
            record.clientId,
            context.identity.deviceId,
            record.createdAt,
            record.createdAt
          );
      }
      connection
        .prepare(
          `INSERT INTO approvals(
             id, action_name, action_version, payload_hash, targets_json,
             principal_id, client_id, session_id, risk_tier, action_class,
             nonce, preview_json, recovery_json, created_at, expires_at, decision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.actionName,
          record.actionVersion,
          record.payloadHash,
          record.targetsJson,
          record.principalId,
          record.clientId,
          record.sessionId,
          record.riskTier,
          record.actionClass,
          record.nonce,
          record.previewJson,
          record.recoveryJson,
          record.createdAt,
          record.expiresAt,
          record.decision
        );
    });
  }

  public get(id: string): ApprovalRecord | undefined {
    const row = this.#database.read(
      (connection) =>
        connection.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined
    );
    return row ? this.map(row) : undefined;
  }

  public decide(id: string, decision: "approved" | "denied", actor: string, at: string): void {
    this.#database.writeTransaction((connection) => {
      const result = connection
        .prepare(
          `UPDATE approvals SET decision = ?, decided_at = ?
           WHERE id = ? AND decision = 'pending'`
        )
        .run(decision, at, id);
      if (result.changes !== 1) {
        throw new Error(`Approval is unknown or already decided: ${id}`);
      }
      connection
        .prepare(
          `INSERT INTO operational_state(namespace, key, value_json, updated_at)
           VALUES ('approval_decisions', ?, ?, ?)`
        )
        .run(id, JSON.stringify({ actor, decision }), at);
    });
  }

  public consume(id: string, at: string): void {
    this.#database.writeTransaction((connection) => {
      const used = connection
        .prepare("SELECT approval_id FROM approval_uses WHERE approval_id = ?")
        .get(id);
      if (used) {
        throw new Error(`Approval has already been used; replay denied: ${id}`);
      }
      connection
        .prepare("INSERT INTO approval_uses(approval_id, used_at, action_id) VALUES (?, ?, NULL)")
        .run(id, at);
    });
  }

  private map(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      actionName: row.action_name,
      actionVersion: row.action_version,
      payloadHash: row.payload_hash,
      targetsJson: row.targets_json,
      principalId: row.principal_id,
      clientId: row.client_id,
      sessionId: row.session_id,
      riskTier: row.risk_tier,
      actionClass: row.action_class,
      nonce: row.nonce,
      previewJson: row.preview_json,
      recoveryJson: row.recovery_json,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decision: row.decision,
      decidedAt: row.decided_at
    };
  }
}

import type { OperationalDatabase } from "@remote-mcp/persistence";

import {
  hashAuditEvent,
  type AuditEventId,
  type AuditEventMaterial,
  type StoredAuditEvent
} from "./audit-event.js";

interface AuditRow {
  readonly id: number;
  readonly correlation_id: string;
  readonly principal_id: string | null;
  readonly client_id: string | null;
  readonly session_id: string | null;
  readonly workspace_id: string | null;
  readonly grant_id: string | null;
  readonly approval_id: string | null;
  readonly job_id: string | null;
  readonly event_type: string;
  readonly tool_name: string | null;
  readonly targets_json: string;
  readonly result_json: string;
  readonly occurred_at: string;
  readonly previous_hash: string | null;
  readonly event_hash: string;
}

export interface AuditQueryFilter {
  readonly correlationId?: string;
  readonly principalId?: string;
  readonly eventType?: string;
  readonly afterId?: number | null;
  readonly limit?: number;
}

export class AuditRepository {
  readonly #database: OperationalDatabase;

  public constructor(database: OperationalDatabase) {
    this.#database = database;
  }

  public append(draft: Omit<AuditEventMaterial, "previousHash">): AuditEventId {
    return this.#database.writeTransaction((connection) => {
      const previous = connection
        .prepare("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")
        .get() as { event_hash: string } | undefined;
      const material: AuditEventMaterial = {
        ...draft,
        previousHash: previous?.event_hash ?? null
      };
      const eventHash = hashAuditEvent(material);
      const result = connection
        .prepare(
          `INSERT INTO audit_events(
             correlation_id, principal_id, client_id, session_id, workspace_id,
             grant_id, approval_id, job_id, event_type, tool_name, targets_json,
             result_json, occurred_at, previous_hash, event_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          material.correlationId,
          material.principalId,
          material.clientId,
          material.sessionId,
          material.workspaceId,
          material.grantId,
          material.approvalId,
          material.jobId,
          material.eventType,
          material.toolName,
          material.targetsJson,
          material.resultJson,
          material.occurredAt,
          material.previousHash,
          eventHash
        );
      return Number(result.lastInsertRowid) as AuditEventId;
    });
  }

  public query(filter: AuditQueryFilter = {}): readonly StoredAuditEvent[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filter.correlationId) {
      clauses.push("correlation_id = ?");
      parameters.push(filter.correlationId);
    }
    if (filter.principalId) {
      clauses.push("principal_id = ?");
      parameters.push(filter.principalId);
    }
    if (filter.eventType) {
      clauses.push("event_type = ?");
      parameters.push(filter.eventType);
    }
    if (filter.afterId !== undefined && filter.afterId !== null) {
      clauses.push("id > ?");
      parameters.push(filter.afterId);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100);
    parameters.push(limit + 1);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database.read(
      (connection) =>
        connection
          .prepare(`SELECT * FROM audit_events ${where} ORDER BY id LIMIT ?`)
          .all(...parameters) as AuditRow[]
    );
    return rows.map((row) => this.map(row));
  }

  public chainRows(range: { readonly afterId?: number; readonly throughId?: number } = {}): readonly StoredAuditEvent[] {
    const clauses: string[] = [];
    const parameters: number[] = [];
    if (range.afterId !== undefined) {
      clauses.push("id > ?");
      parameters.push(range.afterId);
    }
    if (range.throughId !== undefined) {
      clauses.push("id <= ?");
      parameters.push(range.throughId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database.read(
      (connection) =>
        connection
          .prepare(`SELECT * FROM audit_events ${where} ORDER BY id`)
          .all(...parameters) as AuditRow[]
    );
    return rows.map((row) => this.map(row));
  }

  public hashBefore(id: number): string | null {
    const row = this.#database.read(
      (connection) =>
        connection
          .prepare("SELECT event_hash FROM audit_events WHERE id <= ? ORDER BY id DESC LIMIT 1")
          .get(id) as { event_hash: string } | undefined
    );
    return row?.event_hash ?? null;
  }

  private map(row: AuditRow): StoredAuditEvent {
    return {
      id: row.id as AuditEventId,
      correlationId: row.correlation_id,
      principalId: row.principal_id,
      clientId: row.client_id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      grantId: row.grant_id,
      approvalId: row.approval_id,
      jobId: row.job_id,
      eventType: row.event_type,
      toolName: row.tool_name,
      targetsJson: row.targets_json,
      resultJson: row.result_json,
      occurredAt: row.occurred_at,
      previousHash: row.previous_hash,
      eventHash: row.event_hash
    };
  }
}

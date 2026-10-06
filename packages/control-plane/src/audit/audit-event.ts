import { createHash } from "node:crypto";

export type AuditEventId = number & { readonly __brand: "AuditEventId" };

export interface AuditEventInput {
  readonly correlationId: string;
  readonly principalId?: string;
  readonly clientId?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly grantId?: string;
  readonly approvalId?: string;
  readonly jobId?: string;
  readonly eventType: string;
  readonly toolName?: string;
  readonly targets: unknown;
  readonly result: unknown;
  readonly occurredAt?: string;
}

export interface AuditEventMaterial {
  readonly correlationId: string;
  readonly principalId: string | null;
  readonly clientId: string | null;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly grantId: string | null;
  readonly approvalId: string | null;
  readonly jobId: string | null;
  readonly eventType: string;
  readonly toolName: string | null;
  readonly targetsJson: string;
  readonly resultJson: string;
  readonly occurredAt: string;
  readonly previousHash: string | null;
}

export interface StoredAuditEvent extends AuditEventMaterial {
  readonly id: AuditEventId;
  readonly eventHash: string;
}

export function hashAuditEvent(material: AuditEventMaterial): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
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
        material.previousHash
      ]),
      "utf8"
    )
    .digest("hex");
}

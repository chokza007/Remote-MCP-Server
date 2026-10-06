import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { Redactor } from "../security/redactor.js";
import { hashAuditEvent, type AuditEventId, type AuditEventInput } from "./audit-event.js";
import { AuditRepository, type AuditQueryFilter } from "./audit-repository.js";

export interface AuditServiceOptions {
  readonly database: OperationalDatabase;
  readonly redactor: Redactor;
  readonly now?: () => Date;
}

export interface AuditPage {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: number | null;
}

export type AuditIntegrityResult =
  | { readonly valid: true; readonly checked: number }
  | { readonly valid: false; readonly brokenAt: number; readonly reason: string };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
}

export class AuditService {
  readonly #repository: AuditRepository;
  readonly #redactor: Redactor;
  readonly #now: () => Date;

  public constructor(options: AuditServiceOptions) {
    this.#repository = new AuditRepository(options.database);
    this.#redactor = options.redactor;
    this.#now = options.now ?? (() => new Date());
  }

  public record(event: AuditEventInput): AuditEventId {
    return this.#repository.append({
      correlationId: event.correlationId,
      principalId: event.principalId ?? null,
      clientId: event.clientId ?? null,
      sessionId: event.sessionId ?? null,
      workspaceId: event.workspaceId ?? null,
      grantId: event.grantId ?? null,
      approvalId: event.approvalId ?? null,
      jobId: event.jobId ?? null,
      eventType: event.eventType,
      toolName: event.toolName ?? null,
      targetsJson: canonicalJson(this.#redactor.redact(event.targets)),
      resultJson: canonicalJson(this.#redactor.redact(event.result)),
      occurredAt: event.occurredAt ?? this.#now().toISOString()
    });
  }

  public query(filter: AuditQueryFilter = {}): AuditPage {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 100);
    const rows = this.#repository.query({ ...filter, limit });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        correlationId: row.correlationId,
        principalId: row.principalId,
        clientId: row.clientId,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        grantId: row.grantId,
        approvalId: row.approvalId,
        jobId: row.jobId,
        eventType: row.eventType,
        toolName: row.toolName,
        targets: JSON.parse(row.targetsJson) as unknown,
        result: JSON.parse(row.resultJson) as unknown,
        occurredAt: row.occurredAt,
        previousHash: row.previousHash,
        eventHash: row.eventHash
      })),
      nextCursor: hasMore ? Number(pageRows.at(-1)?.id ?? 0) : null
    };
  }

  public verifyChain(
    range: { readonly afterId?: number; readonly throughId?: number } = {}
  ): AuditIntegrityResult {
    const rows = this.#repository.chainRows(range);
    let previousHash = range.afterId === undefined ? null : this.#repository.hashBefore(range.afterId);
    let checked = 0;
    for (const row of rows) {
      if (row.previousHash !== previousHash) {
        return { valid: false, brokenAt: row.id, reason: "previous_hash_mismatch" };
      }
      const calculated = hashAuditEvent({
        correlationId: row.correlationId,
        principalId: row.principalId,
        clientId: row.clientId,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        grantId: row.grantId,
        approvalId: row.approvalId,
        jobId: row.jobId,
        eventType: row.eventType,
        toolName: row.toolName,
        targetsJson: row.targetsJson,
        resultJson: row.resultJson,
        occurredAt: row.occurredAt,
        previousHash: row.previousHash
      });
      if (calculated !== row.eventHash) {
        return { valid: false, brokenAt: row.id, reason: "hash_mismatch" };
      }
      previousHash = row.eventHash;
      checked += 1;
    }
    return { valid: true, checked };
  }
}

export function createAuditService(options: AuditServiceOptions): AuditService {
  return new AuditService(options);
}

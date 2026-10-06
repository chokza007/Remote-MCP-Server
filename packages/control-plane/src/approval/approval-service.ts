import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { GrantActor } from "../auth/grant-types.js";
import type { ActionContext } from "../policy/action-context.js";
import { ApprovalRepository, type ApprovalRecord } from "./approval-repository.js";

export interface ApprovalServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface ApprovalRequestResult {
  readonly id: string;
  readonly payloadHash: string;
  readonly expiresAt: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function targetsJson(context: ActionContext): string {
  return canonicalJson(
    context.targets
      .map((target) => ({
        kind: target.kind,
        canonical: target.canonical,
        identityKey: target.identityKey
      }))
      .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
  );
}

export class ApprovalService {
  readonly #repository: ApprovalRepository;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  public constructor(options: ApprovalServiceOptions) {
    this.#repository = new ApprovalRepository(options.database);
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 300_000;
  }

  public request(context: ActionContext): ApprovalRequestResult {
    const createdAt = this.#now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      actionName: context.action.name,
      actionVersion: context.action.version,
      payloadHash: payloadHash(context.payload),
      targetsJson: targetsJson(context),
      principalId: context.identity.principalId,
      clientId: context.identity.clientId,
      sessionId: context.identity.sessionId ?? null,
      riskTier: context.action.riskTier,
      actionClass: context.action.actionClass,
      nonce: randomBytes(32).toString("base64url"),
      previewJson: canonicalJson(context.preview),
      recoveryJson: canonicalJson(context.recoveryPlan),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.#ttlMs).toISOString(),
      decision: "pending",
      decidedAt: null
    };
    this.#repository.insert(record, context);
    return { id: record.id, payloadHash: record.payloadHash, expiresAt: record.expiresAt };
  }

  public approveOnce(id: string, actor: GrantActor): void {
    this.#repository.decide(id, "approved", `${actor.kind}:${actor.id}`, this.#now().toISOString());
  }

  public deny(id: string, actor: GrantActor): void {
    this.#repository.decide(id, "denied", `${actor.kind}:${actor.id}`, this.#now().toISOString());
  }

  public consume(id: string, context: ActionContext): { readonly id: string } {
    const record = this.#repository.get(id);
    if (!record) {
      throw new Error(`Unknown approval: ${id}`);
    }
    if (record.decision !== "approved") {
      throw new Error(`Approval is not approved (${record.decision}): ${id}`);
    }
    if (Date.parse(record.expiresAt) <= this.#now().getTime()) {
      throw new Error(`Approval expired: ${id}`);
    }

    const sessionId = context.identity.sessionId ?? null;
    const bindingMatches =
      record.actionName === context.action.name &&
      record.actionVersion === context.action.version &&
      record.payloadHash === payloadHash(context.payload) &&
      record.targetsJson === targetsJson(context) &&
      record.principalId === context.identity.principalId &&
      record.clientId === context.identity.clientId &&
      record.sessionId === sessionId &&
      record.riskTier === context.action.riskTier &&
      record.actionClass === context.action.actionClass;
    if (!bindingMatches) {
      throw new Error(`Approval binding or payload mismatch: ${id}`);
    }

    this.#repository.consume(id, this.#now().toISOString());
    return { id };
  }
}

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  return new ApprovalService(options);
}

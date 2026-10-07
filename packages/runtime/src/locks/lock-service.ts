import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { canonicalizeTarget, RemoteMcpError, type CanonicalTarget, type TargetInput } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import { LockRepository, type LockRow } from "./lock-repository.js";

export interface LockServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
  readonly defaultLeaseMs?: number;
  readonly maxLeaseMs?: number;
}

export interface LockAcquireInput {
  readonly ownerId: string;
  readonly resources: readonly (string | TargetInput)[];
  readonly leaseMs?: number;
}

export interface LockedResource {
  readonly identityKey: string;
  readonly target: CanonicalTarget;
  readonly fencingToken: number;
}

export interface LockLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly resources: readonly LockedResource[];
}

function lockError(errorCode: string, message: string, target: string, retryable = false): RemoteMcpError {
  return new RemoteMcpError({
    errorCode,
    message,
    retryable,
    suggestedAction: retryable ? "Wait for the active lease to expire or ask its owner to release it." : "Refresh lock state before retrying.",
    target
  });
}

function asLease(rows: readonly LockRow[]): LockLease {
  const first = rows[0];
  if (!first) throw new Error("A lock lease must contain at least one resource");
  return {
    leaseId: first.leaseId,
    ownerId: first.ownerId,
    acquiredAt: first.acquiredAt,
    expiresAt: first.expiresAt,
    resources: rows.map((row) => ({ identityKey: row.resourceIdentity, target: row.target, fencingToken: row.fencingToken }))
  };
}

export class LockService {
  private readonly repository: LockRepository;
  private readonly now: () => Date;
  private readonly defaultLeaseMs: number;
  private readonly maxLeaseMs: number;

  public constructor(options: LockServiceOptions) {
    this.repository = new LockRepository(options.database);
    this.now = options.now ?? (() => new Date());
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000;
    this.maxLeaseMs = options.maxLeaseMs ?? 24 * 60 * 60 * 1_000;
  }

  public async acquire(input: LockAcquireInput): Promise<LockLease> {
    if (input.ownerId.trim().length === 0) throw new Error("Lock owner must not be empty");
    if (input.resources.length === 0) throw new Error("At least one lock resource is required");
    const leaseMs = this.validateLease(input.leaseMs ?? this.defaultLeaseMs);
    const targets = await Promise.all(input.resources.map((resource) => this.identity(resource)));
    const ordered = [...new Map(targets.map((target) => [target.identityKey, target])).values()]
      .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
    const acquiredAt = this.now();
    const leaseId = randomUUID();
    const rows = this.repository.acquire(
      ordered,
      leaseId,
      input.ownerId,
      acquiredAt.toISOString(),
      new Date(acquiredAt.getTime() + leaseMs).toISOString()
    );
    if (rows.some((row) => row.leaseId !== leaseId)) {
      const conflict = rows.find((row) => row.leaseId !== leaseId)!;
      throw lockError("LOCK_CONFLICT", `Resource is locked by ${conflict.ownerId} until ${conflict.expiresAt}.`, conflict.target.display, true);
    }
    return asLease(rows);
  }

  public async renew(leaseId: string, ownerId: string, leaseMs = this.defaultLeaseMs): Promise<LockLease> {
    this.validateLease(leaseMs);
    const rows = this.repository.byLease(leaseId);
    if (rows.length === 0) throw lockError("LOCK_NOT_FOUND", "The lock lease does not exist.", leaseId);
    if (rows.some((row) => row.ownerId !== ownerId)) throw lockError("LOCK_NOT_OWNED", "The lock lease belongs to another owner.", leaseId);
    const now = this.now();
    if (rows.some((row) => row.expiresAt <= now.toISOString())) {
      this.repository.release(leaseId);
      throw lockError("LOCK_EXPIRED", "The lock lease has expired.", leaseId);
    }
    return asLease(this.repository.renew(leaseId, new Date(now.getTime() + leaseMs).toISOString()));
  }

  public async release(leaseId: string, ownerId: string): Promise<{ readonly released: number }> {
    const rows = this.repository.byLease(leaseId);
    if (rows.length === 0) return { released: 0 };
    if (rows.some((row) => row.ownerId !== ownerId)) throw lockError("LOCK_NOT_OWNED", "The lock lease belongs to another owner.", leaseId);
    return { released: this.repository.release(leaseId) };
  }

  public async assertFence(resource: string | TargetInput, leaseId: string, fencingToken: number): Promise<void> {
    const target = await this.identity(resource);
    const row = this.repository.byResource(target.identityKey);
    if (
      row === null || row.leaseId !== leaseId || row.fencingToken !== fencingToken ||
      row.expiresAt <= this.now().toISOString()
    ) {
      throw lockError("LOCK_FENCE_STALE", "The fencing token is stale or no longer owns the resource.", target.display);
    }
  }

  public async reconcile(): Promise<{ readonly released: number; readonly leaseIds: readonly string[] }> {
    return this.repository.reconcile(this.now().toISOString());
  }

  public list(ownerId?: string): readonly LockLease[] {
    const byLease = new Map<string, LockRow[]>();
    for (const row of this.repository.list(ownerId)) {
      const rows = byLease.get(row.leaseId) ?? [];
      rows.push(row);
      byLease.set(row.leaseId, rows);
    }
    return [...byLease.values()].map(asLease);
  }

  public async identity(resource: string | TargetInput): Promise<CanonicalTarget> {
    return this.canonicalize(resource);
  }

  private validateLease(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > this.maxLeaseMs) {
      throw new Error(`Lock lease must be from 1 through ${this.maxLeaseMs} ms`);
    }
    return value;
  }

  private async canonicalize(resource: string | TargetInput): Promise<CanonicalTarget> {
    const input: TargetInput = typeof resource === "string"
      ? { kind: "path", value: resolve(resource), followSymlinks: true }
      : resource.kind === "path"
        ? { ...resource, value: resolve(resource.value), followSymlinks: resource.followSymlinks ?? true }
        : resource;
    try {
      return await canonicalizeTarget(input);
    } catch (error) {
      if (input.kind !== "path" || input.followSymlinks !== true) throw error;
      return canonicalizeTarget({ ...input, followSymlinks: false });
    }
  }
}

export function createLockService(options: LockServiceOptions): LockService {
  return new LockService(options);
}

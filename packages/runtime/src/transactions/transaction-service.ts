import { createHash, randomUUID } from "node:crypto";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { LockLease, LockService } from "../locks/lock-service.js";
import {
  ChangeSetRepository,
  type ChangeAdapter,
  type ChangeContext,
  type ChangeSpec,
  type PreparedChange,
  type TransactionRecord
} from "./change-set.js";
import { createRecoveryStore, type FileRecoveryPoint, type RecoveryStore, type StagedFile } from "./recovery-store.js";

export type TransactionBoundaryPhase = "after_prepare" | "after_apply" | "after_verify";

export interface TransactionBoundary {
  readonly phase: TransactionBoundaryPhase;
  readonly transactionId: string;
  readonly changeId: string;
}

export class TransactionInterruption extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TransactionInterruption";
  }
}

export interface TransactionServiceOptions {
  readonly database: OperationalDatabase;
  readonly locks: LockService;
  readonly recoveryRoot: string;
  readonly adapters?: readonly ChangeAdapter[];
  readonly now?: () => Date;
  readonly lockLeaseMs?: number;
  readonly faultInjector?: (boundary: TransactionBoundary) => void | Promise<void>;
}

export interface BeginTransactionInput {
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly changes: readonly ChangeSpec[];
}

export interface TransactionPreview {
  readonly transactionId: string;
  readonly state: "previewed";
  readonly evidence: string;
  readonly changes: ReadonlyArray<{ readonly changeId: string; readonly kind: string; readonly atomic: boolean; readonly preview: unknown }>;
}

export interface CommitTransactionInput {
  readonly transactionId: string;
  readonly ownerId: string;
  readonly previewEvidence?: string;
}

function transactionError(errorCode: string, message: string, target: string, retryable = false, cause?: unknown): RemoteMcpError {
  return new RemoteMcpError({
    errorCode,
    message,
    retryable,
    suggestedAction: "Inspect transaction status and recovery evidence before retrying or rolling back.",
    target,
    cause
  });
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function evidence(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function asFilePrepared(value: PreparedChange): { readonly recovery: FileRecoveryPoint; readonly staged: StagedFile } {
  if (typeof value.recovery !== "object" || value.recovery === null || typeof value.preview !== "object" || value.preview === null) {
    throw transactionError("TRANSACTION_RECOVERY_FAILED", "File preparation record is invalid.", "file.replace");
  }
  const staged = (value as PreparedChange & { staged?: StagedFile }).staged;
  if (!staged) throw transactionError("TRANSACTION_RECOVERY_FAILED", "Staged file reference is missing.", "file.replace");
  return { recovery: value.recovery as FileRecoveryPoint, staged };
}

function createFileReplaceAdapter(): ChangeAdapter {
  return {
    kind: "file.replace",
    atomic: true,
    prepare: async (change, context) => {
      const payload = change.payload as { content?: unknown; encoding?: unknown };
      if (typeof payload?.content !== "string" || ![undefined, "utf8", "base64"].includes(payload.encoding as string | undefined)) {
        throw transactionError("TRANSACTION_INVALID_CHANGE", "file.replace requires string content and utf8 or base64 encoding.", change.target);
      }
      const content = Buffer.from(payload.content, payload.encoding === "base64" ? "base64" : "utf8");
      const recovery = await context.recovery.snapshotFile(context.transactionId, change.changeId, change.target);
      const staged = await context.recovery.stageFile(context.transactionId, change.changeId, content);
      return {
        preview: {
          operation: recovery.existed ? "replace" : "create",
          target: recovery.target,
          beforeSha256: recovery.originalSha256 ?? null,
          afterSha256: staged.sha256,
          sizeBytes: staged.sizeBytes
        },
        recovery,
        staged
      } as PreparedChange & { readonly staged: StagedFile };
    },
    apply: async (change, prepared, context) => {
      const file = asFilePrepared(prepared);
      const current = await context.recovery.currentHash(change.target);
      const expected = file.recovery.existed ? file.recovery.originalSha256! : null;
      if (current !== expected) {
        throw transactionError("TRANSACTION_TARGET_CHANGED", "The target changed after preview; refusing to overwrite it.", change.target, true);
      }
      await context.assertFence(change.target);
      await context.recovery.install(file.staged, change.target);
      return { sha256: file.staged.sha256, sizeBytes: file.staged.sizeBytes };
    },
    verify: async (change, prepared, _result, context) => {
      const file = asFilePrepared(prepared);
      const actualSha256 = await context.recovery.currentHash(change.target);
      return { valid: actualSha256 === file.staged.sha256, evidence: { actualSha256, expectedSha256: file.staged.sha256 } };
    },
    compensate: async (change, prepared, _result, context) => {
      const file = asFilePrepared(prepared);
      await context.assertFence(change.target);
      const current = await context.recovery.currentHash(change.target);
      const original = file.recovery.existed ? file.recovery.originalSha256! : null;
      if (current === original) return;
      if (current !== file.staged.sha256) {
        throw transactionError("TRANSACTION_TARGET_CHANGED", "The target changed after commit; refusing to overwrite it during rollback.", change.target);
      }
      await context.recovery.restore(prepared.recovery);
    }
  };
}

export class TransactionService {
  private readonly repository: ChangeSetRepository;
  private readonly locks: LockService;
  private readonly recovery: RecoveryStore;
  private readonly adapters = new Map<string, ChangeAdapter>();
  private readonly now: () => Date;
  private readonly lockLeaseMs: number;
  private readonly faultInjector: (boundary: TransactionBoundary) => void | Promise<void>;

  public constructor(options: TransactionServiceOptions) {
    this.repository = new ChangeSetRepository(options.database);
    this.locks = options.locks;
    this.recovery = createRecoveryStore({ root: options.recoveryRoot });
    this.now = options.now ?? (() => new Date());
    this.lockLeaseMs = options.lockLeaseMs ?? 5 * 60_000;
    this.faultInjector = options.faultInjector ?? (() => undefined);
    for (const adapter of [createFileReplaceAdapter(), ...(options.adapters ?? [])]) {
      if (this.adapters.has(adapter.kind)) throw new Error(`Duplicate change adapter: ${adapter.kind}`);
      this.adapters.set(adapter.kind, adapter);
    }
  }

  public async begin(input: BeginTransactionInput): Promise<TransactionRecord> {
    if (input.ownerId.trim().length === 0) throw new Error("Transaction owner must not be empty");
    if (input.changes.length === 0) throw new Error("Transaction requires at least one change");
    const ids = new Set<string>();
    const targets = new Set<string>();
    const changes: Array<ChangeSpec & { readonly atomic: boolean }> = [];
    for (const change of input.changes) {
      if (change.changeId.trim().length === 0 || ids.has(change.changeId)) throw new Error(`Invalid or duplicate change ID: ${change.changeId}`);
      ids.add(change.changeId);
      const target = await this.locks.identity(change.target);
      if (targets.has(target.identityKey)) {
        throw transactionError("TRANSACTION_INVALID_CHANGE", "A transaction cannot contain multiple changes for the same canonical target.", target.display);
      }
      targets.add(target.identityKey);
      const adapter = this.adapter(change.kind);
      changes.push({ ...change, target: target.canonical, atomic: adapter.atomic });
    }
    const transactionId = randomUUID();
    const now = this.now().toISOString();
    this.repository.insert(transactionId, input.ownerId, input.workspaceId, changes, now);
    return this.repository.get(transactionId);
  }

  public async preview(transactionId: string, ownerId: string): Promise<TransactionPreview> {
    let transaction = this.owned(transactionId, ownerId);
    if (transaction.state === "previewed") return this.previewResult(transaction);
    if (transaction.state !== "draft") {
      throw transactionError("TRANSACTION_STATE_INVALID", `Cannot preview a transaction in ${transaction.state}.`, transactionId);
    }
    this.repository.setTransactionState(transactionId, "previewing", this.now().toISOString());
    try {
      for (const change of transaction.changes) {
        const prepared = await this.adapter(change.kind).prepare(change, this.context(transactionId));
        this.repository.setChangeState(transactionId, change.position, "prepared", { prepared }, this.now().toISOString());
        await this.faultInjector({ phase: "after_prepare", transactionId, changeId: change.changeId });
      }
      transaction = this.repository.get(transactionId);
      const visible = transaction.changes.map((change) => ({
        changeId: change.changeId,
        kind: change.kind,
        atomic: change.atomic,
        preview: change.prepared!.preview
      }));
      const previewEvidence = evidence(visible);
      this.repository.setPreview(transactionId, visible);
      this.repository.setTransactionState(transactionId, "previewed", this.now().toISOString(), { previewEvidence });
      return { transactionId, state: "previewed", evidence: previewEvidence, changes: visible };
    } catch (error) {
      if (error instanceof TransactionInterruption) throw error;
      this.repository.setTransactionState(transactionId, "failed", this.now().toISOString(), { error: this.errorText(error) });
      throw error;
    }
  }

  public async commit(input: CommitTransactionInput): Promise<TransactionRecord> {
    let transaction = this.owned(input.transactionId, input.ownerId);
    if (transaction.state !== "previewed") {
      throw transactionError("TRANSACTION_STATE_INVALID", `Cannot commit a transaction in ${transaction.state}.`, input.transactionId);
    }
    if (
      transaction.changes.some((change) => !change.atomic) &&
      (input.previewEvidence === undefined || input.previewEvidence !== transaction.previewEvidence)
    ) {
      throw transactionError(
        "TRANSACTION_PREVIEW_REQUIRED",
        "A matching explicit preview evidence hash is required for non-atomic changes.",
        input.transactionId
      );
    }

    const lease = await this.acquireLease(transaction);
    this.repository.setTransactionState(input.transactionId, "committing", this.now().toISOString(), { lockLeaseId: lease.leaseId, error: null });
    try {
      transaction = this.repository.get(input.transactionId);
      for (const change of transaction.changes) {
        const prepared = change.prepared;
        if (!prepared) throw transactionError("TRANSACTION_RECOVERY_FAILED", "Prepared change data is missing.", change.changeId);
        const context = this.context(input.transactionId, lease);
        this.repository.setChangeState(input.transactionId, change.position, "applying");
        await context.assertFence(change.target);
        const result = await this.adapter(change.kind).apply(change, prepared, context);
        this.repository.setChangeState(input.transactionId, change.position, "applied", { result });
        await this.faultInjector({ phase: "after_apply", transactionId: input.transactionId, changeId: change.changeId });
        const verification = await this.adapter(change.kind).verify(change, prepared, result, context);
        if (!verification.valid) throw transactionError("TRANSACTION_VERIFICATION_FAILED", "Change verification failed.", change.target);
        this.repository.setChangeState(input.transactionId, change.position, "verified", { verification });
        await this.faultInjector({ phase: "after_verify", transactionId: input.transactionId, changeId: change.changeId });
      }
      this.repository.setTransactionState(input.transactionId, "committed", this.now().toISOString());
      await this.locks.release(lease.leaseId, this.lockOwner(input.transactionId));
      return this.repository.get(input.transactionId);
    } catch (error) {
      if (error instanceof TransactionInterruption) throw error;
      await this.compensate(input.transactionId, input.ownerId, lease, error);
      throw error;
    }
  }

  public async rollback(transactionId: string, ownerId: string): Promise<TransactionRecord> {
    const transaction = this.owned(transactionId, ownerId);
    if (transaction.state === "rolled_back") return transaction;
    if (transaction.state === "draft") {
      this.repository.setTransactionState(transactionId, "rolled_back", this.now().toISOString());
      return this.repository.get(transactionId);
    }
    const lease = await this.acquireLease(transaction);
    await this.compensate(transactionId, ownerId, lease);
    return this.repository.get(transactionId);
  }

  public status(transactionId: string, ownerId: string): TransactionRecord {
    return this.owned(transactionId, ownerId);
  }

  public async reconcile(ownerId?: string): Promise<{ readonly recovered: readonly string[]; readonly needsAttention: readonly string[] }> {
    const recovered: string[] = [];
    const needsAttention: string[] = [];
    for (const transaction of this.repository.listRecoverable(ownerId)) {
      try {
        const lease = await this.acquireLease(transaction);
        await this.compensate(transaction.transactionId, transaction.ownerId, lease);
        recovered.push(transaction.transactionId);
      } catch {
        this.repository.setTransactionState(transaction.transactionId, "needs_attention", this.now().toISOString());
        needsAttention.push(transaction.transactionId);
      }
    }
    return { recovered, needsAttention };
  }

  private previewResult(transaction: TransactionRecord): TransactionPreview {
    return {
      transactionId: transaction.transactionId,
      state: "previewed",
      evidence: transaction.previewEvidence!,
      changes: transaction.changes.map((change) => ({
        changeId: change.changeId,
        kind: change.kind,
        atomic: change.atomic,
        preview: change.prepared!.preview
      }))
    };
  }

  private adapter(kind: string): ChangeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw transactionError("CAPABILITY_UNAVAILABLE", `No change adapter is registered for ${kind}.`, kind);
    return adapter;
  }

  private owned(transactionId: string, ownerId: string): TransactionRecord {
    let transaction: TransactionRecord;
    try {
      transaction = this.repository.get(transactionId);
    } catch (cause) {
      throw transactionError("TRANSACTION_NOT_FOUND", "The transaction does not exist.", transactionId, false, cause);
    }
    if (transaction.ownerId !== ownerId) {
      throw transactionError("TRANSACTION_NOT_FOUND", "The transaction does not exist.", transactionId);
    }
    return transaction;
  }

  private async acquireLease(transaction: TransactionRecord): Promise<LockLease> {
    const lockOwner = this.lockOwner(transaction.transactionId);
    if (transaction.lockLeaseId) {
      const existing = this.locks.list(lockOwner).find((lease) => lease.leaseId === transaction.lockLeaseId);
      if (existing) return existing;
    }
    await this.locks.reconcile();
    const lease = await this.locks.acquire({
      ownerId: lockOwner,
      resources: transaction.changes.map((change) => change.target),
      leaseMs: this.lockLeaseMs
    });
    this.repository.setTransactionState(transaction.transactionId, transaction.state, this.now().toISOString(), { lockLeaseId: lease.leaseId });
    return lease;
  }

  private context(transactionId: string, lease?: LockLease): ChangeContext {
    return {
      transactionId,
      recovery: this.recovery,
      assertFence: async (target) => {
        if (!lease) throw transactionError("LOCK_FENCE_STALE", "No active transaction lease is available.", target);
        const identity = await this.locks.identity(target);
        const resource = lease.resources.find((candidate) => candidate.identityKey === identity.identityKey);
        if (!resource) throw transactionError("LOCK_FENCE_STALE", "The transaction lease does not cover this target.", target);
        await this.locks.assertFence(target, lease.leaseId, resource.fencingToken);
      }
    };
  }

  private async compensate(transactionId: string, ownerId: string, lease: LockLease, cause?: unknown): Promise<void> {
    this.owned(transactionId, ownerId);
    this.repository.setTransactionState(transactionId, "rolling_back", this.now().toISOString(), {
      ...(cause === undefined ? {} : { error: this.errorText(cause) }),
      lockLeaseId: lease.leaseId
    });
    const changes = [...this.repository.get(transactionId).changes].reverse();
    try {
      for (const change of changes) {
        if (!change.prepared || !["prepared", "applying", "applied", "verified", "failed"].includes(change.state)) continue;
        this.repository.setChangeState(transactionId, change.position, "compensating");
        await this.context(transactionId, lease).assertFence(change.target);
        await this.adapter(change.kind).compensate(change, change.prepared, change.result, this.context(transactionId, lease));
        this.repository.setChangeState(transactionId, change.position, "compensated");
      }
      this.repository.setTransactionState(transactionId, "rolled_back", this.now().toISOString(), {
        ...(cause === undefined ? {} : { error: this.errorText(cause) })
      });
    } catch (rollbackError) {
      this.repository.setTransactionState(transactionId, "needs_attention", this.now().toISOString(), { error: this.errorText(rollbackError) });
      throw transactionError("TRANSACTION_ROLLBACK_FAILED", "Transaction compensation failed.", transactionId, false, rollbackError);
    } finally {
      await this.locks.release(lease.leaseId, this.lockOwner(transactionId)).catch(() => undefined);
    }
  }

  private lockOwner(transactionId: string): string {
    return `transaction:${transactionId}`;
  }

  private errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
  }
}

export function createTransactionService(options: TransactionServiceOptions): TransactionService {
  return new TransactionService(options);
}

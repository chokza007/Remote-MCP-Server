import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createLockService,
  createTransactionService,
  TransactionInterruption,
  type ChangeAdapter,
  type TransactionService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("transactional changes and recovery", () => {
  let root: string;
  let database: OperationalDatabase;
  let service: TransactionService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-transactions-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    service = createTransactionService({
      database,
      locks: createLockService({ database }),
      recoveryRoot: join(root, "recovery")
    });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("previews with zero target mutation, atomically replaces, verifies, and rolls back", async () => {
    const target = join(root, "target.txt");
    await writeFile(target, "before", "utf8");
    const transaction = await service.begin({
      ownerId: "owner-a",
      changes: [{ changeId: "replace", kind: "file.replace", target, payload: { content: "after", encoding: "utf8" } }]
    });
    const preview = await service.preview(transaction.transactionId, "owner-a");
    expect(await readFile(target, "utf8")).toBe("before");
    expect(preview).toMatchObject({ state: "previewed", evidence: expect.any(String) });

    await service.commit({ transactionId: transaction.transactionId, ownerId: "owner-a", previewEvidence: preview.evidence });
    expect(await readFile(target, "utf8")).toBe("after");
    expect((await readdir(root)).some((name) => name.includes("remote-mcp-tmp"))).toBe(false);
    expect(service.status(transaction.transactionId, "owner-a")).toMatchObject({ state: "committed" });

    await service.rollback(transaction.transactionId, "owner-a");
    expect(await readFile(target, "utf8")).toBe("before");
    expect(service.status(transaction.transactionId, "owner-a")).toMatchObject({ state: "rolled_back" });
  });

  test.each(["after_prepare", "after_apply", "after_verify"] as const)(
    "recovers after interruption at %s using persisted recovery points",
    async (phase) => {
    const target = join(root, `crash-${phase}.txt`);
    await writeFile(target, "original", "utf8");
    const interrupted = createTransactionService({
      database,
      locks: createLockService({ database }),
      recoveryRoot: join(root, "recovery"),
      faultInjector: (boundary) => {
        if (boundary.phase === phase) throw new TransactionInterruption("simulated termination");
      }
    });
    const transaction = await interrupted.begin({
      ownerId: "owner-a",
      changes: [{ changeId: "replace", kind: "file.replace", target, payload: { content: "partial" } }]
    });
    if (phase === "after_prepare") {
      await expect(interrupted.preview(transaction.transactionId, "owner-a")).rejects.toBeInstanceOf(TransactionInterruption);
      expect(await readFile(target, "utf8")).toBe("original");
    } else {
      const preview = await interrupted.preview(transaction.transactionId, "owner-a");
      await expect(interrupted.commit({
        transactionId: transaction.transactionId,
        ownerId: "owner-a",
        previewEvidence: preview.evidence
      })).rejects.toBeInstanceOf(TransactionInterruption);
      expect(await readFile(target, "utf8")).toBe("partial");
    }

    const restarted = createTransactionService({
      database,
      locks: createLockService({ database }),
      recoveryRoot: join(root, "recovery")
    });
    expect((await restarted.reconcile()).recovered).toContain(transaction.transactionId);
    expect(await readFile(target, "utf8")).toBe("original");
    expect(restarted.status(transaction.transactionId, "owner-a")).toMatchObject({ state: "rolled_back" });
  });

  test("compensates partial multi-resource application in reverse order", async () => {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await writeFile(first, "first-before", "utf8");
    await writeFile(second, "second-before", "utf8");
    const failing: ChangeAdapter = {
      kind: "fixture.fail",
      atomic: true,
      prepare: async (change, context) => ({
        preview: { operation: "fixture fail" },
        recovery: await context.recovery.snapshotFile(context.transactionId, change.changeId, change.target)
      }),
      apply: async (change) => {
        await writeFile(change.target, "second-partial", "utf8");
        throw new Error("fixture apply failed");
      },
      verify: async () => ({ valid: false }),
      compensate: async (_change, prepared, _result, context) => {
        await context.recovery.restore(prepared.recovery);
      }
    };
    const transactional = createTransactionService({
      database,
      locks: createLockService({ database }),
      recoveryRoot: join(root, "recovery"),
      adapters: [failing]
    });
    const transaction = await transactional.begin({
      ownerId: "owner-a",
      changes: [
        { changeId: "first", kind: "file.replace", target: first, payload: { content: "first-after" } },
        { changeId: "second", kind: "fixture.fail", target: second, payload: {} }
      ]
    });
    const preview = await transactional.preview(transaction.transactionId, "owner-a");
    await expect(transactional.commit({
      transactionId: transaction.transactionId,
      ownerId: "owner-a",
      previewEvidence: preview.evidence
    })).rejects.toThrow(/fixture apply failed/i);
    expect(await readFile(first, "utf8")).toBe("first-before");
    expect(await readFile(second, "utf8")).toBe("second-before");
    expect(transactional.status(transaction.transactionId, "owner-a")).toMatchObject({ state: "rolled_back" });
  });

  test("requires matching explicit preview evidence for a non-atomic adapter", async () => {
    const target = join(root, "non-atomic.txt");
    const adapter: ChangeAdapter = {
      kind: "fixture.non_atomic",
      atomic: false,
      prepare: async () => ({ preview: { warning: "external side effect" }, recovery: null }),
      apply: async () => ({ changed: true }),
      verify: async () => ({ valid: true }),
      compensate: async () => undefined
    };
    const transactional = createTransactionService({
      database,
      locks: createLockService({ database }),
      recoveryRoot: join(root, "recovery"),
      adapters: [adapter]
    });
    const transaction = await transactional.begin({
      ownerId: "owner-a",
      changes: [{ changeId: "external", kind: adapter.kind, target, payload: {} }]
    });
    const preview = await transactional.preview(transaction.transactionId, "owner-a");
    await expect(transactional.commit({ transactionId: transaction.transactionId, ownerId: "owner-a" }))
      .rejects.toMatchObject({ errorCode: "TRANSACTION_PREVIEW_REQUIRED" });
    await expect(transactional.commit({
      transactionId: transaction.transactionId,
      ownerId: "owner-a",
      previewEvidence: "wrong"
    })).rejects.toMatchObject({ errorCode: "TRANSACTION_PREVIEW_REQUIRED" });
    await expect(transactional.commit({
      transactionId: transaction.transactionId,
      ownerId: "owner-a",
      previewEvidence: preview.evidence
    })).resolves.toMatchObject({ state: "committed" });
  });
});

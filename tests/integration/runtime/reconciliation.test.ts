import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createJobReconciler,
  createJobRepository,
  createJobRunner,
  createJobService,
  type JobRepository,
  type JobService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

const identity = {
  principalId: "principal-reconcile",
  clientId: "client-reconcile",
  sessionId: "session-reconcile",
  grantId: "grant-reconcile"
};

describe("job restart reconciliation", () => {
  let database: OperationalDatabase;
  let service: JobService;
  let repository: JobRepository;

  beforeEach(() => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    service = createJobService({ database });
    repository = createJobRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  function submit(retry = false): string {
    return service.submit({
      kind: "fixture",
      ...identity,
      ...(retry ? { retryPolicy: { maxAttempts: 2 } } : {}),
      steps: [{ stepId: "one", kind: "fixture", payload: {}, dependsOn: [], idempotent: retry }]
    }).jobId;
  }

  test("marks stale running jobs orphaned instead of falsely successful", async () => {
    const jobId = submit();
    repository.markRunningFixture(jobId, {
      heartbeatAt: "2026-10-06T00:00:00.000Z",
      processIdentity: null
    });
    const reconciler = createJobReconciler({
      database,
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      staleAfterMs: 60_000,
      inspectProcess: async () => false
    });

    expect(await reconciler.reconcile()).toEqual({ reattached: 0, requeued: 0, orphaned: 1 });
    expect(service.get(jobId)).toMatchObject({ state: "orphaned", verification: null });
  });

  test("reattaches only when process identity and command fingerprint still match", async () => {
    const jobId = submit();
    repository.markRunningFixture(jobId, {
      heartbeatAt: "2026-10-06T00:00:00.000Z",
      processIdentity: { pid: 123, createdAt: "2026-10-06T00:00:00.000Z", commandFingerprint: "sha256:abc" }
    });
    const reconciler = createJobReconciler({
      database,
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      staleAfterMs: 60_000,
      inspectProcess: async (identity) => identity.commandFingerprint === "sha256:abc"
    });

    expect(await reconciler.reconcile()).toEqual({ reattached: 1, requeued: 0, orphaned: 0 });
    expect(service.get(jobId).state).toBe("running");
    expect(service.events(jobId, 0, 100).items.at(-1)?.type).toBe("reattached");
  });

  test("requeues only safe idempotent jobs within retry policy", async () => {
    const jobId = submit(true);
    repository.markRunningFixture(jobId, {
      heartbeatAt: "2026-10-06T00:00:00.000Z",
      processIdentity: null
    });
    const reconciler = createJobReconciler({
      database,
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      staleAfterMs: 60_000,
      inspectProcess: async () => false
    });

    expect(await reconciler.reconcile()).toEqual({ reattached: 0, requeued: 1, orphaned: 0 });
    expect(service.get(jobId).state).toBe("queued");
    expect(service.events(jobId, 0, 100).items.at(-1)?.type).toBe("requeued_after_restart");
  });

  test("preserves completed steps across a forced worker restart", async () => {
    const effects: string[] = [];
    let jobId = "";
    let pauseAfterFirst = true;
    const runner = createJobRunner({
      database,
      authorizeStep: async () => ({ allowed: true })
    });
    runner.register("fixture", async (step) => {
      effects.push(step.stepId);
      if (step.stepId === "first" && pauseAfterFirst) {
        pauseAfterFirst = false;
        service.pause(jobId);
      }
      return {
        result: { stepId: step.stepId },
        verification: { verified: true, evidence: step.stepId }
      };
    });
    jobId = service.submit({
      kind: "restart-fixture",
      ...identity,
      retryPolicy: { maxAttempts: 2 },
      steps: [
        { stepId: "first", kind: "fixture", payload: {}, dependsOn: [], idempotent: true },
        { stepId: "second", kind: "fixture", payload: {}, dependsOn: ["first"], idempotent: true }
      ]
    }).jobId;

    await runner.runNext();
    expect(effects).toEqual(["first"]);
    repository.markRunningFixture(jobId, {
      heartbeatAt: "2026-10-06T00:00:00.000Z",
      processIdentity: null
    });
    const reconciler = createJobReconciler({
      database,
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      staleAfterMs: 60_000,
      inspectProcess: async () => false
    });

    await reconciler.reconcile();
    await runner.runNext();
    expect(effects).toEqual(["first", "second"]);
    expect(service.get(jobId)).toMatchObject({
      state: "succeeded",
      verification: { verified: true, steps: 2, evidence: ["first", "second"] }
    });
  });
});

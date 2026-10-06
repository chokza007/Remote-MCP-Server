import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createJobRunner,
  createJobService,
  type JobRunner,
  type JobService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

const identity = {
  principalId: "principal-jobs",
  clientId: "client-jobs",
  sessionId: "session-jobs",
  grantId: "grant-jobs"
};

describe("durable jobs", () => {
  let database: OperationalDatabase;
  let service: JobService;
  let runner: JobRunner;

  beforeEach(() => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    service = createJobService({ database });
    runner = createJobRunner({ database, authorizeStep: async () => ({ allowed: true }) });
  });

  afterEach(() => {
    database.close();
  });

  test("returns a job ID immediately, honors dependencies, and stores ordered events and logs", async () => {
    const order: string[] = [];
    runner.register("fixture", async (step, context) => {
      order.push(step.stepId);
      context.log("stdout", `start:${step.stepId}`);
      context.log("stderr", `end:${step.stepId}`);
      return {
        result: { stepId: step.stepId },
        verification: { verified: true, evidence: `verified:${step.stepId}` }
      };
    });
    const submitted = service.submit({
      kind: "workflow",
      ...identity,
      idempotencyKey: "fixture-idempotency",
      retryPolicy: { maxAttempts: 2 },
      steps: [
        { stepId: "prepare", kind: "fixture", payload: {}, dependsOn: [], idempotent: true },
        { stepId: "finish", kind: "fixture", payload: {}, dependsOn: ["prepare"], idempotent: true }
      ]
    });
    expect(submitted.jobId).toEqual(expect.any(String));
    expect(service.get(submitted.jobId).state).toBe("queued");
    expect(service.submit({
      kind: "workflow",
      ...identity,
      idempotencyKey: "fixture-idempotency",
      retryPolicy: { maxAttempts: 2 },
      steps: [{ stepId: "different", kind: "fixture", payload: {}, dependsOn: [], idempotent: true }]
    })).toEqual({ jobId: submitted.jobId, deduplicated: true });

    expect(await runner.runNext()).toBe(submitted.jobId);
    expect(order).toEqual(["prepare", "finish"]);
    expect(service.get(submitted.jobId)).toMatchObject({
      state: "succeeded",
      verification: { verified: true, steps: 2 }
    });
    const events = service.events(submitted.jobId, 0, 100);
    expect(events.items.map((event) => event.sequence)).toEqual(
      events.items.map((_event, index) => index)
    );
    expect(events.items.map((event) => event.type)).toEqual(
      expect.arrayContaining(["queued", "running", "step_started", "step_succeeded", "succeeded"])
    );
    const logs = service.logs(submitted.jobId, 0, 100);
    expect(logs.items.map((entry) => `${entry.stream}:${entry.content}`)).toEqual([
      "stdout:start:prepare",
      "stderr:end:prepare",
      "stdout:start:finish",
      "stderr:end:finish"
    ]);
  });

  test("validates dependency graphs before persistence", () => {
    expect(() =>
      service.submit({
        kind: "workflow",
        ...identity,
        steps: [
          { stepId: "a", kind: "fixture", payload: {}, dependsOn: ["b"], idempotent: true },
          { stepId: "b", kind: "fixture", payload: {}, dependsOn: ["a"], idempotent: true }
        ]
      })
    ).toThrow(/cycle/i);
    expect(service.list()).toEqual([]);
  });

  test("continues independently of the submitting client and survives a service restart", async () => {
    runner.register("fixture", async (_step, context) => {
      context.heartbeat();
      return { result: { ok: true }, verification: { verified: true, evidence: "fixture" } };
    });
    const { jobId } = service.submit({
      kind: "detached",
      ...identity,
      steps: [{ stepId: "only", kind: "fixture", payload: {}, dependsOn: [], idempotent: true }]
    });
    service = createJobService({ database });

    await runner.runNext();
    expect(service.get(jobId).state).toBe("succeeded");
  });

  test("cancels a running job cooperatively", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    runner.register("slow", async (_step, context) => {
      started();
      for (;;) {
        context.throwIfCancelled();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const { jobId } = service.submit({
      kind: "cancel",
      ...identity,
      steps: [{ stepId: "slow", kind: "slow", payload: {}, dependsOn: [], idempotent: true }]
    });
    const running = runner.runNext();
    await didStart;
    service.cancel(jobId);
    await running;
    expect(service.get(jobId).state).toBe("cancelled");
  });

  test("supports queued pause/resume and safe failed retry", async () => {
    let attempts = 0;
    runner.register("flaky", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture failure");
      return { result: { attempts }, verification: { verified: true, evidence: "retry verified" } };
    });
    const { jobId } = service.submit({
      kind: "retry",
      ...identity,
      retryPolicy: { maxAttempts: 2 },
      steps: [{ stepId: "flaky", kind: "flaky", payload: {}, dependsOn: [], idempotent: true }]
    });
    service.pause(jobId);
    expect(service.get(jobId).state).toBe("paused");
    service.resume(jobId);
    await runner.runNext();
    expect(service.get(jobId).state).toBe("failed");
    service.retry(jobId);
    await runner.runNext();
    expect(service.get(jobId).state).toBe("succeeded");
  });

  test("rechecks authorization between steps and blocks the next step after revoke", async () => {
    let checks = 0;
    runner = createJobRunner({
      database,
      authorizeStep: async () => {
        checks += 1;
        return checks === 1 ? { allowed: true } : { allowed: false, reason: "grant_revoked" };
      }
    });
    const executed: string[] = [];
    runner.register("fixture", async (step) => {
      executed.push(step.stepId);
      return { result: {}, verification: { verified: true, evidence: step.stepId } };
    });
    const { jobId } = service.submit({
      kind: "revoke",
      ...identity,
      steps: [
        { stepId: "first", kind: "fixture", payload: {}, dependsOn: [], idempotent: true },
        { stepId: "second", kind: "fixture", payload: {}, dependsOn: ["first"], idempotent: true }
      ]
    });

    await runner.runNext();
    expect(executed).toEqual(["first"]);
    expect(service.get(jobId).state).toBe("cancelled");
    expect(service.events(jobId, 0, 100).items.at(-1)).toMatchObject({
      type: "authorization_revoked"
    });
  });

  test("never reports success without verification evidence", async () => {
    runner.register("unverified", async () => ({ result: { wrote: true } }));
    const { jobId } = service.submit({
      kind: "unverified",
      ...identity,
      steps: [{ stepId: "only", kind: "unverified", payload: {}, dependsOn: [], idempotent: true }]
    });

    await runner.runNext();
    expect(service.get(jobId)).toMatchObject({ state: "needs_attention", verification: null });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createJobRunner, createJobService } from "@remote-mcp/runtime";

describe("unattended durable workflow", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup())));

  test("continues after process-style restart and rechecks authorization before every step", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-unattended-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, "operational.db");
    let database = openDatabase({ filename });
    migrateDatabase(database);
    const jobs = createJobService({ database });
    const { jobId } = jobs.submit({
      kind: "acceptance", principalId: "principal", clientId: "client", sessionId: "session", grantId: "grant",
      steps: [
        { stepId: "first", kind: "fixture", payload: {}, dependsOn: [], idempotent: true },
        { stepId: "second", kind: "fixture", payload: {}, dependsOn: ["first"], idempotent: true }
      ]
    });
    database.close();
    database = openDatabase({ filename });
    migrateDatabase(database);
    cleanups.push(() => database.close());
    let checks = 0;
    const runner = createJobRunner({ database, authorizeStep: () => ({ allowed: ++checks === 1, reason: "grant_revoked" }) });
    runner.register("fixture", async (step, context) => {
      context.log("stdout", `completed:${step.stepId}`);
      return { result: { step: step.stepId }, verification: { verified: true, evidence: step.stepId } };
    });
    await runner.runNext();
    const restartedJobs = createJobService({ database });
    expect(restartedJobs.get(jobId).state).toBe("cancelled");
    expect(restartedJobs.logs(jobId, 0, 100).items.map((item) => item.content)).toEqual(["completed:first"]);
    expect(restartedJobs.events(jobId, 0, 100).items.at(-1)).toMatchObject({ type: "authorization_revoked" });
  });
});

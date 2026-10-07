import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";
import { createJobReconciler, createJobRepository, createJobService } from "@remote-mcp/runtime";

describe("worker crash recovery", () => {
  let database: OperationalDatabase;
  beforeEach(() => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
  });
  afterEach(() => database.close());

  test("never replays a non-idempotent stale job after a worker crash", async () => {
    const jobs = createJobService({ database });
    const jobId = jobs.submit({
      kind: "destructive-fixture",
      principalId: "principal",
      clientId: "client",
      retryPolicy: { maxAttempts: 99 },
      steps: [{ stepId: "delete", kind: "fixture", payload: {}, dependsOn: [], idempotent: false }]
    }).jobId;
    createJobRepository(database).markRunningFixture(jobId, {
      heartbeatAt: "2026-10-01T00:00:00.000Z",
      processIdentity: null
    });

    const result = await createJobReconciler({
      database,
      staleAfterMs: 1_000,
      now: () => new Date("2026-10-07T00:00:00.000Z"),
      inspectProcess: () => false
    }).reconcile();

    expect(result).toEqual({ reattached: 0, requeued: 0, orphaned: 1 });
    expect(jobs.get(jobId).state).toBe("orphaned");
  });
});

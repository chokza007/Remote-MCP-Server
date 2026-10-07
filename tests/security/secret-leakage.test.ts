import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createAuditService, createRedactor } from "@remote-mcp/control-plane";
import { HealthService, createJobRepository, createJobService, JobLogStore } from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

const canary = "REMOTE_MCP_CANARY_SECRET_8f2a79c14b";

describe("secret canaries across persisted and diagnostic sinks", () => {
  let database: OperationalDatabase;

  beforeEach(() => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  test("redacts arbitrary canary values from audit, job logs, and health reports", async () => {
    const redactor = createRedactor();
    redactor.registerEphemeral(canary);
    const audit = createAuditService({ database, redactor });
    audit.record({
      correlationId: "secret-canary",
      eventType: "fixture",
      targets: [`C:\\safe\\${canary}.txt`],
      result: { message: `operation included ${canary}` }
    });

    const jobs = createJobService({ database });
    const jobId = jobs.submit({
      kind: "fixture",
      principalId: "principal",
      clientId: "client",
      steps: [{ stepId: "one", kind: "fixture", payload: {}, dependsOn: [], idempotent: true }]
    }).jobId;
    const logs = new JobLogStore(createJobRepository(database), {
      redact: (value) => String(redactor.redact(value))
    });
    logs.append(jobId, "stderr", `failed near ${canary}`);

    const health = new HealthService({
      database,
      registry: {
        probeAll: async () => [{
          id: "fixture",
          required: false,
          status: "degraded",
          detail: `diagnostic ${canary}`
        }]
      },
      redact: (value) => redactor.redact(value)
    });

    expect(JSON.stringify(audit.query())).not.toContain(canary);
    expect(JSON.stringify(logs.page(jobId))).not.toContain(canary);
    expect(JSON.stringify(await health.report())).not.toContain(canary);
  });
});

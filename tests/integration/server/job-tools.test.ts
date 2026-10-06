import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createJobService } from "@remote-mcp/runtime";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("job MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("binds submitted durable jobs to the authenticated identity and current grant", async () => {
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const jobs = createJobService({ database });
    const handle = await createHttpServer({
      database,
      jobs,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x28),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x28)
      },
      host: "127.0.0.1",
      port: 0
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "jobs-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "jobs-principal",
            "x-remote-mcp-client": "jobs-client"
          }
        }
      })
    );
    const enrollment = structured(
      await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    const grant = handle.grantPending(String(enrollment.requestId), "fixture-owner");

    const submitted = structured(
      await client.callTool({
        name: "job_submit",
        arguments: {
          kind: "fixture-workflow",
          idempotencyKey: "mcp-job-fixture",
          retryPolicy: { maxAttempts: 2 },
          steps: [
            {
              stepId: "only",
              kind: "fixture",
              payload: { value: 1 },
              dependsOn: [],
              idempotent: true
            }
          ]
        }
      })
    );
    expect(submitted).toMatchObject({ jobId: expect.any(String), deduplicated: false });
    const jobId = String(submitted.jobId);
    expect(jobs.get(jobId)).toMatchObject({
      principalId: "jobs-principal",
      clientId: "jobs-client",
      sessionId: expect.any(String),
      grantId: grant.id,
      state: "queued"
    });
    expect(structured(await client.callTool({ name: "job_get", arguments: { jobId } }))).toMatchObject({
      job: { jobId, state: "queued" }
    });
    expect(structured(await client.callTool({ name: "job_list", arguments: {} }))).toMatchObject({
      jobs: [expect.objectContaining({ jobId })]
    });
    expect(structured(await client.callTool({ name: "job_events", arguments: { jobId } }))).toMatchObject({
      items: [expect.objectContaining({ type: "queued" })]
    });
    expect(structured(await client.callTool({ name: "job_logs", arguments: { jobId } }))).toMatchObject({
      items: []
    });

    expect(structured(await client.callTool({ name: "job_pause", arguments: { jobId } }))).toMatchObject({
      job: { state: "paused" }
    });
    expect(structured(await client.callTool({ name: "job_resume", arguments: { jobId } }))).toMatchObject({
      job: { state: "queued" }
    });
    expect(structured(await client.callTool({ name: "job_cancel", arguments: { jobId } }))).toMatchObject({
      job: { state: "cancelled" }
    });

    const otherClient = new Client({ name: "jobs-client-two", version: "1.0.0" });
    cleanups.push(() => otherClient.close());
    await otherClient.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "jobs-principal-two",
            "x-remote-mcp-client": "jobs-client-two"
          }
        }
      })
    );
    const otherEnrollment = structured(
      await otherClient.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    handle.grantPending(String(otherEnrollment.requestId), "fixture-owner");
    const otherSubmission = structured(
      await otherClient.callTool({
        name: "job_submit",
        arguments: {
          kind: "fixture-workflow",
          idempotencyKey: "mcp-job-fixture",
          steps: [{
            stepId: "only",
            kind: "fixture",
            payload: {},
            dependsOn: [],
            idempotent: true
          }]
        }
      })
    );
    expect(otherSubmission.jobId).not.toBe(jobId);
    expect(jobs.get(String(otherSubmission.jobId))).toMatchObject({
      principalId: "jobs-principal-two",
      clientId: "jobs-client-two"
    });
  });
});

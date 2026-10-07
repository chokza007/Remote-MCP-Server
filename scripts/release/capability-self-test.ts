import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

import { createHttpServer } from "../../apps/server/src/http-server.js";

const database = openDatabase({ filename: ":memory:" });
migrateDatabase(database);
const handle = await createHttpServer({ database, host: "127.0.0.1", port: 0 });
const client = new Client({ name: "release-self-test", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(handle.url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${handle.localDevelopmentToken}`,
        "x-remote-mcp-principal": "release-self-test",
        "x-remote-mcp-client": "release-self-test"
      }
    }
  }));
  const request = await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } });
  const requestId = String((request.structuredContent as Record<string, unknown>).requestId);
  handle.grantPending(requestId, "release-verifier");
  const run = await client.callTool({
    name: "capability_self_test",
    arguments: { selection: ["core.database", "core.gateway", "core.jobs", "system.powershell"] }
  });
  const jobId = String((run.structuredContent as Record<string, unknown>).capabilityRunId);
  const status = await client.callTool({ name: "job_get", arguments: { jobId } });
  const job = (status.structuredContent as { job?: { state?: string; verification?: unknown } }).job;
  if (job?.state !== "succeeded" || job.verification === null) {
    throw new Error(`Required capability self-test did not succeed: ${JSON.stringify(job)}`);
  }
  process.stdout.write(JSON.stringify({ result: "PASS", jobId, state: job.state }) + "\n");
} finally {
  await client.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
  database.close();
}

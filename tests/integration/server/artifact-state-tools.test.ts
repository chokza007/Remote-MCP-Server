import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("artifact, operational state, and project checkpoint MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("keeps resources owner/workspace scoped and project checkpoint bodies project-owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-artifact-state-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "result.txt");
    const checkpointPath = join(root, "WORK_CHECKPOINT.md");
    const originalCanary = "SERVER_PROJECT_CHECKPOINT_CANARY_ORIGINAL_92b7";
    const updatedCanary = "SERVER_PROJECT_CHECKPOINT_CANARY_UPDATED_18d4";
    await writeFile(source, "result", "utf8");
    await writeFile(checkpointPath, originalCanary, "utf8");
    const database = openDatabase({ filename: join(root, "operational.db") });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x46),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x46)
      },
      host: "127.0.0.1",
      port: 0,
      artifactStoreRoot: join(root, "artifact-store"),
      recoveryRoot: join(root, "recovery")
    });
    cleanups.push(() => handle.close());

    async function connectedClient(principal: string, clientName: string): Promise<Client> {
      const client = new Client({ name: clientName, version: "1.0.0" });
      cleanups.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(handle.url, {
        requestInit: { headers: {
          authorization: `Bearer ${handle.localDevelopmentToken}`,
          "x-remote-mcp-principal": principal,
          "x-remote-mcp-client": clientName
        } }
      }));
      const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
      handle.grantPending(String(request.requestId), "fixture-owner");
      return client;
    }

    const client = await connectedClient("artifact-principal", "artifact-client");
    const registered = structured(await client.callTool({
      name: "artifact_register",
      arguments: { workspaceId: "workspace-a", path: source, kind: "result", storage: "managed" }
    }));
    expect(registered).toMatchObject({ artifact: { storage: "managed", validationState: "valid" } });
    expect(structured(await client.callTool({ name: "artifact_list", arguments: { workspaceId: "workspace-b" } })))
      .toMatchObject({ artifacts: [] });

    await client.callTool({
      name: "operational_state_set",
      arguments: { workspaceId: "workspace-a", key: "active-job", value: { jobId: "job-123", offset: 7 } }
    });
    expect(structured(await client.callTool({
      name: "operational_state_get", arguments: { workspaceId: "workspace-a", key: "active-job" }
    }))).toMatchObject({ record: { value: { jobId: "job-123", offset: 7 } } });
    const saved = structured(await client.callTool({
      name: "runtime_checkpoint_save",
      arguments: { workspaceId: "workspace-a", operation: "fixture.resume", state: { cursor: 9 } }
    }));
    expect(saved).toMatchObject({ checkpoint: { state: "active", data: { cursor: 9 } } });

    expect(structured(await client.callTool({
      name: "project_checkpoint_read", arguments: { root, path: checkpointPath }
    }))).toMatchObject({ checkpoint: { content: originalCanary } });
    const updated = structured(await client.callTool({
      name: "project_checkpoint_update",
      arguments: { workspaceId: "workspace-a", root, path: checkpointPath, content: updatedCanary }
    }));
    expect(updated).toMatchObject({ checkpoint: { artifact: { storage: "reference" } } });
    expect(await readFile(checkpointPath, "utf8")).toBe(updatedCanary);

    const other = await connectedClient("other-principal", "other-client");
    expect(structured(await other.callTool({ name: "artifact_list", arguments: { workspaceId: "workspace-a" } })))
      .toMatchObject({ artifacts: [] });
    expect(structured(await other.callTool({
      name: "operational_state_get", arguments: { workspaceId: "workspace-a", key: "active-job" }
    }))).toMatchObject({ record: null });

    const serialized = database.read((connection) => {
      const tables = (connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>).map((row) => row.name);
      return tables.flatMap((name) => connection.prepare(`SELECT * FROM \"${name.replaceAll('"', '""')}\"`).all())
        .map((row) => JSON.stringify(row)).join("\n");
    });
    expect(serialized).not.toContain(originalCanary);
    expect(serialized).not.toContain(updatedCanary);
  }, 30_000);
});

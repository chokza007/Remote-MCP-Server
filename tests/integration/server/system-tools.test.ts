import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("system MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("reports system capability and inspects an exact process", async () => {
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x64),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x64)
      },
      host: "127.0.0.1",
      port: 0
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "system-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "system-principal",
            "x-remote-mcp-client": "system-client"
          }
        }
      })
    );
    const enrollment = structured(
      await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    handle.grantPending(String(enrollment.requestId), "fixture-owner");

    expect(
      structured(await client.callTool({ name: "system_snapshot", arguments: {} }))
    ).toMatchObject({ platform: "win32", arch: process.arch });
    expect(
      structured(
        await client.callTool({ name: "process_inspect", arguments: { pid: process.pid } })
      )
    ).toMatchObject({ identity: { pid: process.pid }, name: expect.stringMatching(/node/i) });
  });
});

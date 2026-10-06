import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSearchService } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("search MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("starts, observes, and pages a bounded durable search", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-search-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "match.txt"), "MCP search needle", "utf8");
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x39),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x39)
      },
      host: "127.0.0.1",
      port: 0,
      search: createSearchService({ database, allowedRoots: [root] })
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "search-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "search-principal",
            "x-remote-mcp-client": "search-client"
          }
        }
      })
    );
    const enrollment = structured(
      await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    handle.grantPending(String(enrollment.requestId), "fixture-owner");

    const started = structured(
      await client.callTool({
        name: "search_start",
        arguments: {
          roots: [root],
          content: "needle",
          maxFiles: 10,
          maxResults: 10,
          maxBytes: 100000
        }
      })
    );
    const searchId = String(started.searchId);
    let status: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      status = structured(
        await client.callTool({ name: "search_status", arguments: { searchId } })
      );
      if (status.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status).toMatchObject({ state: "completed", matchedResults: 1 });
    expect(
      structured(
        await client.callTool({
          name: "search_page",
          arguments: { searchId, cursor: 0, limit: 10 }
        })
      )
    ).toMatchObject({ items: [expect.objectContaining({ path: join(root, "match.txt") })] });
  });
});

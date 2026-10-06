import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTerminalService } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("terminal MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("creates, writes, reads, resizes, and closes an interactive terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-terminal-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const terminal = createTerminalService({ database, allowedShells: ["node"] });
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x73),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x73)
      },
      host: "127.0.0.1",
      port: 0,
      terminal
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "terminal-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "terminal-principal",
            "x-remote-mcp-client": "terminal-client"
          }
        }
      })
    );
    const enrollment = structured(
      await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    handle.grantPending(String(enrollment.requestId), "fixture-owner");

    const created = structured(
      await client.callTool({
        name: "terminal_create",
        arguments: { shell: "node", cwd: root, cols: 80, rows: 24 }
      })
    );
    const terminalId = String(created.terminalId);
    await client.callTool({
      name: "terminal_send",
      arguments: { terminalId, data: 'console.log("MCP_TERMINAL_OK")\r' }
    });
    let output = "";
    let offset = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = structured(
        await client.callTool({
          name: "terminal_read",
          arguments: { terminalId, offset, limit: 65536 }
        })
      );
      output += String(page.data ?? "");
      offset = Number(page.nextOffset ?? offset);
      if (output.includes("MCP_TERMINAL_OK")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(output).toContain("MCP_TERMINAL_OK");
    expect(
      structured(
        await client.callTool({
          name: "terminal_resize",
          arguments: { terminalId, cols: 120, rows: 40 }
        })
      )
    ).toMatchObject({ cols: 120, rows: 40 });
    expect(
      structured(await client.callTool({ name: "terminal_close", arguments: { terminalId } }))
    ).toMatchObject({ state: "closed" });
  });
});

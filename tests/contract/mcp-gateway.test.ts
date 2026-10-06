import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  migrateDatabase,
  openDatabase,
  type OperationalDatabase
} from "@remote-mcp/persistence";
import { createHttpServer, type HttpServerHandle } from "../../apps/server/src/http-server.js";

const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0xa5),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0xa5)
};

describe("MCP gateway contract", () => {
  let database: OperationalDatabase | undefined;
  let handle: HttpServerHandle | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await handle?.close();
    database?.close();
  });

  async function connect(): Promise<Client> {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    handle = await createHttpServer({ database, protector, host: "127.0.0.1", port: 0 });
    client = new Client({ name: "contract-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "principal-contract",
            "x-remote-mcp-client": "client-contract"
          }
        }
      })
    );
    return client;
  }

  test("publishes the versioned core tool surface through the official SDK", async () => {
    const connected = await connect();
    const tools = await connected.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "authorization_status",
        "clear_emergency_stop",
        "emergency_stop",
        "health_report",
        "list_trusted_clients",
        "request_full_access",
        "revoke_full_access",
        "server_info"
      ])
    );
    expect(handle?.url.hostname).toBe("127.0.0.1");
    for (const tool of tools.tools) {
      expect(tool._meta).toMatchObject({
        "remote-mcp/schemaVersion": 1,
        "remote-mcp/toolVersion": "1.0.0"
      });
    }
  });

  test("returns stable structured envelopes for public discovery tools", async () => {
    const connected = await connect();

    const info = await connected.callTool({ name: "server_info", arguments: {} });
    const health = await connected.callTool({ name: "health_report", arguments: {} });

    expect(info.structuredContent).toMatchObject({
      schemaVersion: 1,
      name: "remote-mcp-server",
      deviceId: expect.any(String)
    });
    expect(health.structuredContent).toMatchObject({
      schemaVersion: 1,
      status: "ready",
      database: "ok"
    });
  });

  test("returns a structured authorization error for a protected tool", async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: "list_trusted_clients", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { error_code: "AUTHORIZATION_REQUIRED", target: "list_trusted_clients" }
    });
  });
});

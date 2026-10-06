import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  migrateDatabase,
  openDatabase,
  type OperationalDatabase
} from "@remote-mcp/persistence";
import { createHttpServer, type HttpServerHandle } from "../../../apps/server/src/http-server.js";

const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x5a),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x5a)
};

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("MCP session authorization", () => {
  let database: OperationalDatabase | undefined;
  let handle: HttpServerHandle | undefined;
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await handle?.close();
    database?.close();
  });

  async function start(): Promise<HttpServerHandle> {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    handle = await createHttpServer({ database, protector, host: "127.0.0.1", port: 0 });
    return handle;
  }

  async function connect(principal: string, clientId: string): Promise<Client> {
    if (!handle) throw new Error("server not started");
    const client = new Client({ name: clientId, version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": principal,
            "x-remote-mcp-client": clientId
          }
        }
      })
    );
    return client;
  }

  test("keeps enrollment restricted until local owner grants it, then recognizes a new session", async () => {
    const server = await start();
    const first = await connect("principal-one", "client-one");

    expect(structured(await first.callTool({ name: "authorization_status", arguments: {} }))).toMatchObject({
      schemaVersion: 1,
      state: "restricted",
      reason: "unknown_client"
    });

    const requested = structured(
      await first.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    expect(requested).toMatchObject({ schemaVersion: 1, status: "pending", requestId: expect.any(String) });

    const grant = server.grantPending(String(requested.requestId), "test-owner");
    expect(grant).toMatchObject({ mode: "full_access", expiresAt: null });

    await first.close();
    clients.splice(clients.indexOf(first), 1);
    const reconnected = await connect("principal-one", "client-one");
    expect(structured(await reconnected.callTool({ name: "authorization_status", arguments: {} }))).toMatchObject({
      state: "granted",
      mode: "full_access",
      source: "persistent_grant"
    });
  });

  test("rejects a client that cannot prove possession of the local development token", async () => {
    const server = await start();
    const untrusted = new Client({ name: "untrusted", version: "1.0.0" });
    clients.push(untrusted);

    await expect(
      untrusted.connect(
        new StreamableHTTPClientTransport(server.url, {
          requestInit: {
            headers: {
              authorization: "Bearer wrong-token",
              "x-remote-mcp-principal": "spoofed-principal",
              "x-remote-mcp-client": "spoofed-client"
            }
          }
        })
      )
    ).rejects.toThrow(/401|unauthorized/i);
  });

  test("isolates sessions and grants by stable principal and client identity", async () => {
    const server = await start();
    const first = await connect("principal-one", "client-one");
    const request = structured(
      await first.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    server.grantPending(String(request.requestId), "test-owner");

    const second = await connect("principal-one", "client-two");
    expect(structured(await second.callTool({ name: "authorization_status", arguments: {} }))).toMatchObject({
      state: "restricted",
      reason: "unknown_client"
    });
  });

  test("lists and revokes trusted clients immediately under a Full Access grant", async () => {
    const server = await start();
    const connected = await connect("principal-revoke", "client-revoke");
    const request = structured(
      await connected.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    const grant = server.grantPending(String(request.requestId), "test-owner");

    expect(
      structured(await connected.callTool({ name: "list_trusted_clients", arguments: {} }))
    ).toMatchObject({ clients: [expect.objectContaining({ id: grant.id, revokedAt: null })] });

    expect(
      structured(
        await connected.callTool({
          name: "revoke_full_access",
          arguments: { grantId: grant.id, reason: "test revoke" }
        })
      )
    ).toMatchObject({ status: "revoked", grantId: grant.id });
    expect(structured(await connected.callTool({ name: "authorization_status", arguments: {} }))).toMatchObject({
      state: "restricted",
      reason: "revoked"
    });
  });

  test("supports emergency stop and an explicit recovery path", async () => {
    const server = await start();
    const connected = await connect("principal-stop", "client-stop");
    const request = structured(
      await connected.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    server.grantPending(String(request.requestId), "test-owner");

    expect(
      structured(
        await connected.callTool({ name: "emergency_stop", arguments: { reason: "operator stop" } })
      )
    ).toMatchObject({ active: true });
    expect(server.clearEmergencyStop("test-owner")).toMatchObject({ active: false });
  });

  test("rejects request bodies above the configured limit", async () => {
    const server = await start();
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oversized: "x".repeat(1_100_000) })
    });

    expect(response.status).toBe(413);
  });
});

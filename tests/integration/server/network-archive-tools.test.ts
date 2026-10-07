import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpService, createUrlPolicy } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("network and archive MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("executes through persistent authorization and audits targets without response bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-network-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const canary = "NETWORK_AUDIT_BODY_CANARY";
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-length": Buffer.byteLength(canary) }).end(canary);
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => fixture.close(() => resolve())));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Expected fixture address");
    const fixtureUrl = `http://127.0.0.1:${address.port}/payload`;

    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x38),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x38)
      },
      host: "127.0.0.1",
      port: 0,
      http: createHttpService({ urlPolicy: createUrlPolicy({ allowPrivateNetwork: true }) })
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "network-archive-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(handle.url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${handle.localDevelopmentToken}`,
          "x-remote-mcp-principal": "network-archive-principal",
          "x-remote-mcp-client": "network-archive-client"
        }
      }
    }));
    const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
    handle.grantPending(String(request.requestId), "fixture-owner");

    const fetched = structured(await client.callTool({ name: "http_request", arguments: { url: fixtureUrl } }));
    expect(fetched).toMatchObject({ status: 200, body: canary, finalUrl: fixtureUrl });

    const archive = join(root, "fixture.zip");
    const destination = join(root, "output");
    await writeFile(archive, zipSync({ "nested/file.txt": Buffer.from("archive payload") }));
    expect(structured(await client.callTool({ name: "archive_list", arguments: { archive } }))).toMatchObject({
      entries: [expect.objectContaining({ path: "nested/file.txt" })]
    });
    expect(structured(await client.callTool({ name: "archive_extract", arguments: { archive, destination } }))).toMatchObject({
      changed: true,
      entries: 1
    });
    expect(await readFile(join(destination, "nested", "file.txt"), "utf8")).toBe("archive payload");

    const audited = database.read((connection) => connection.prepare(
      "SELECT targets_json, result_json FROM audit_events WHERE tool_name = 'http_request' AND event_type = 'tool.completed' ORDER BY id DESC LIMIT 1"
    ).get() as { targets_json: string; result_json: string });
    expect(audited.targets_json).toContain(fixtureUrl);
    expect(audited.result_json).toContain("[OMITTED");
    expect(audited.result_json).not.toContain(canary);
  });
});

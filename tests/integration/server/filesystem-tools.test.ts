import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFilesystemAdapter } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";
import { createHttpServer, type HttpServerHandle } from "../../../apps/server/src/http-server.js";

const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x2d),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x2d)
};

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("filesystem MCP tools", () => {
  let root: string;
  let outside: string;
  let database: OperationalDatabase;
  let handle: HttpServerHandle;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-fs-tools-"));
    outside = await mkdtemp(join(tmpdir(), "remote-mcp-fs-outside-"));
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    handle = await createHttpServer({
      database,
      protector,
      host: "127.0.0.1",
      port: 0,
      filesystem: createFilesystemAdapter({ allowedRoots: [root], recycleDirectory: join(root, ".recycle") })
    });
    client = new Client({ name: "filesystem-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(handle.url, {
        requestInit: {
          headers: {
            authorization: `Bearer ${handle.localDevelopmentToken}`,
            "x-remote-mcp-principal": "filesystem-principal",
            "x-remote-mcp-client": "filesystem-client"
          }
        }
      })
    );
    const request = structured(
      await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
    );
    handle.grantPending(String(request.requestId), "fixture-owner");
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
    database.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("round-trips fixture file operations without writing outside the allowed root", async () => {
    const target = join(root, "created.txt");
    const written = await client.callTool({
      name: "filesystem_write",
      arguments: { path: target, data: "created through MCP", overwrite: false }
    });
    expect(written.isError).not.toBe(true);
    expect(await readFile(target, "utf8")).toBe("created through MCP");

    expect(
      structured(
        await client.callTool({
          name: "filesystem_read_range",
          arguments: { path: target, offset: 8, length: 7 }
        })
      )
    ).toMatchObject({ data: "through", bytesRead: 7 });

    const forbidden = join(outside, "forbidden.txt");
    const denied = await client.callTool({
      name: "filesystem_write",
      arguments: { path: forbidden, data: "must not exist" }
    });
    expect(denied.isError).toBe(true);
    await expect(readFile(forbidden)).rejects.toThrow();
  });

  test("discovers project guidance as references through MCP", async () => {
    await writeFile(join(root, "README.md"), "project-owned", "utf8");
    const result = structured(
      await client.callTool({ name: "project_discover_guidance", arguments: { root } })
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      references: [expect.objectContaining({ relativePath: "README.md" })]
    });
    expect(JSON.stringify(result)).not.toContain("project-owned");
  });
});

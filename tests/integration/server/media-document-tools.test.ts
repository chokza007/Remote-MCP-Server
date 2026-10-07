import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

const execFileAsync = promisify(execFile);

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("media and document MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("executes read-only adapters through a persistent full-access grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-media-doc-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const media = join(root, "probe fixture.mp4");
    const document = join(root, "เอกสาร.md");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "color=size=64x64:rate=10:duration=0.5", "-c:v", "libx264", media
    ]);
    await writeFile(document, "# MCP document\n", "utf8");

    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x51),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x51)
      },
      host: "127.0.0.1",
      port: 0,
      documentHelperRoot: resolve("helpers/python"),
      pythonExecutable: "python"
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "media-document-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(handle.url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${handle.localDevelopmentToken}`,
          "x-remote-mcp-principal": "media-document-principal",
          "x-remote-mcp-client": "media-document-client"
        }
      }
    }));
    const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
    handle.grantPending(String(request.requestId), "fixture-owner");

    const mediaResult = structured(await client.callTool({ name: "media_probe", arguments: { path: media } }));
    expect(mediaResult).toMatchObject({ probe: { durationSeconds: expect.any(Number), streams: expect.any(Array) } });
    const documentResult = structured(await client.callTool({ name: "document_inspect", arguments: { path: document } }));
    expect(documentResult).toMatchObject({ kind: "markdown", valid: true });

    const audits = database.read((connection) => connection.prepare(
      "SELECT tool_name, targets_json FROM audit_events WHERE event_type = 'tool.completed' AND tool_name IN ('media_probe', 'document_inspect') ORDER BY tool_name"
    ).all() as Array<{ tool_name: string; targets_json: string }>);
    expect(audits).toHaveLength(2);
    expect(audits.find((entry) => entry.tool_name === "media_probe")?.targets_json).toContain("probe fixture.mp4");
    expect(audits.find((entry) => entry.tool_name === "document_inspect")?.targets_json).toContain("เอกสาร.md");
  }, 30_000);
});

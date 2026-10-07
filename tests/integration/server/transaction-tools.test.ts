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

describe("lock and transaction MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("previews, commits, and rolls back an owner-scoped file replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-transaction-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "transaction target.txt");
    await writeFile(target, "before", "utf8");
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x27),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x27)
      },
      host: "127.0.0.1",
      port: 0,
      recoveryRoot: join(root, "recovery")
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "transaction-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(handle.url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${handle.localDevelopmentToken}`,
          "x-remote-mcp-principal": "transaction-principal",
          "x-remote-mcp-client": "transaction-client"
        }
      }
    }));
    const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
    handle.grantPending(String(request.requestId), "fixture-owner");

    const begun = structured(await client.callTool({
      name: "transaction_begin",
      arguments: {
        changes: [{ changeId: "replace", kind: "file.replace", target, payload: { content: "after" } }]
      }
    }));
    const transactionId = String((begun.transaction as { transactionId: string }).transactionId);
    const preview = structured(await client.callTool({ name: "transaction_preview", arguments: { transactionId } }));
    expect(await readFile(target, "utf8")).toBe("before");
    await client.callTool({
      name: "transaction_commit",
      arguments: { transactionId, previewEvidence: preview.evidence }
    });
    expect(await readFile(target, "utf8")).toBe("after");
    await client.callTool({ name: "transaction_rollback", arguments: { transactionId } });
    expect(await readFile(target, "utf8")).toBe("before");
  }, 30_000);
});

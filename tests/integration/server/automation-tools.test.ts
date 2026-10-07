import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("watch, schedule, and notification MCP tools", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("binds persistent automation resources to the authenticated client", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-automation-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "watched.txt");
    await writeFile(target, "initial", "utf8");
    const database = openDatabase({ filename: join(root, "operational.db") });
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
      schedulerPollMs: 60_000,
      recoveryRoot: join(root, "recovery")
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "automation-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(handle.url, {
      requestInit: {
        headers: {
          authorization: `Bearer ${handle.localDevelopmentToken}`,
          "x-remote-mcp-principal": "automation-principal",
          "x-remote-mcp-client": "automation-client"
        }
      }
    }));
    const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
    handle.grantPending(String(request.requestId), "fixture-owner");

    const watched = structured(await client.callTool({
      name: "watch_create",
      arguments: { kind: "file", target, intervalMs: 60_000 }
    }));
    expect(watched).toMatchObject({ watch: { kind: "file", target, state: "active" } });
    expect(structured(await client.callTool({ name: "watch_list", arguments: {} }))).toMatchObject({
      watches: [expect.objectContaining({ watchId: expect.any(String), target })]
    });

    const scheduled = structured(await client.callTool({
      name: "schedule_create",
      arguments: {
        timezone: "Asia/Bangkok",
        rule: { kind: "at", at: "2099-01-01T00:00:00.000Z" },
        action: { tool: "health", arguments: {} },
        misfirePolicy: "run_once",
        overlapPolicy: "skip"
      }
    }));
    expect(scheduled).toMatchObject({ schedule: { timezone: "Asia/Bangkok", state: "active" } });
    expect(structured(await client.callTool({ name: "schedule_list", arguments: {} }))).toMatchObject({
      schedules: [expect.objectContaining({ scheduleId: expect.any(String) })]
    });

    const sent = structured(await client.callTool({
      name: "notification_send",
      arguments: { kind: "mcp", payload: { message: "ready" } }
    }));
    const notificationId = String((sent.notification as { notificationId: string }).notificationId);
    expect(sent).toMatchObject({ notification: { notificationId, state: "delivered" } });
    expect(structured(await client.callTool({ name: "notification_inbox", arguments: {} }))).toMatchObject({
      notifications: [expect.objectContaining({ notificationId, state: "delivered" })]
    });
    expect(structured(await client.callTool({ name: "event_stream", arguments: {} }))).toMatchObject({
      items: [expect.objectContaining({ type: "notification", payload: { message: "ready" } })]
    });
  }, 30_000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createEventBus,
  createLocalNotifier,
  createMcpNotifier,
  createNotificationService,
  type NotificationService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("durable notifications", () => {
  let root: string;
  let database: OperationalDatabase;
  let nowMs: number;
  let notifications: NotificationService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-notifications-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T00:00:00.000Z");
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("retries failed delivery, persists inbox state, scopes owners, and acknowledges after restart", async () => {
    let attempts = 0;
    const local = createLocalNotifier({
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
      }
    });
    notifications = createNotificationService({
      database, now: () => new Date(nowMs), retryBaseMs: 1_000, notifiers: { local }
    });
    const sent = await notifications.send({ ownerId: "owner-a", kind: "local", payload: { message: "done" } });
    expect(sent).toMatchObject({ state: "pending", attempts: 1 });
    expect(notifications.inbox("owner-b")).toHaveLength(0);
    nowMs += 1_001;
    expect((await notifications.retryDue()).delivered).toBe(1);
    expect(notifications.inbox("owner-a")[0]).toMatchObject({ state: "delivered", attempts: 2 });

    const restarted = createNotificationService({ database, now: () => new Date(nowMs), notifiers: { local } });
    expect(restarted.acknowledge(sent.notificationId, "owner-a")).toMatchObject({ state: "acknowledged" });
    expect(() => restarted.acknowledge(sent.notificationId, "owner-b")).toThrow(/not exist/i);
  });

  test("delivers MCP notifications into the ordered durable event stream", async () => {
    const events = createEventBus({ database, now: () => new Date(nowMs) });
    const mcp = createMcpNotifier({ eventBus: events });
    notifications = createNotificationService({ database, now: () => new Date(nowMs), notifiers: { mcp } });
    const sent = await notifications.send({ ownerId: "owner-a", kind: "mcp", payload: { message: "attention" } });
    expect(sent.state).toBe("delivered");
    expect(events.events("owner-a").items).toEqual([
      expect.objectContaining({ type: "notification", sourceId: sent.notificationId, payload: { message: "attention" } })
    ]);
  });
});

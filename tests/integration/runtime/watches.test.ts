import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createEventBus, createWatchService, type WatchService } from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("persistent watches and event stream", () => {
  let root: string;
  let database: OperationalDatabase;
  let watches: WatchService;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-watches-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T00:00:00.000Z");
    watches = createWatchService({ database, now: () => new Date(nowMs), random: () => 0.5 });
  });

  afterEach(async () => {
    await watches.stop();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("detects file changes, suppresses unchanged polls, orders events, cancels, and restores after restart", async () => {
    const target = join(root, "watched.txt");
    await writeFile(target, "one", "utf8");
    const watch = await watches.create({ ownerId: "owner-a", kind: "file", target });
    await watches.pollOnce(watch.watchId);
    expect(watches.events(watch.watchId, "owner-a").items).toHaveLength(0);

    await writeFile(target, "two", "utf8");
    nowMs += 1_000;
    await watches.pollOnce(watch.watchId);
    await watches.pollOnce(watch.watchId);
    const firstPage = watches.events(watch.watchId, "owner-a");
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({ sequence: 0, type: "file_changed" });

    await watches.stop();
    watches = createWatchService({ database, now: () => new Date(nowMs), random: () => 0.5 });
    await writeFile(target, "three", "utf8");
    nowMs += 1_000;
    await watches.pollOnce(watch.watchId);
    expect(watches.events(watch.watchId, "owner-a").items.map((event) => event.sequence)).toEqual([0, 1]);
    await watches.cancel(watch.watchId, "owner-a");
    await writeFile(target, "four", "utf8");
    await watches.pollOnce();
    expect(watches.events(watch.watchId, "owner-a").items).toHaveLength(2);
  });

  test("uses native file notifications while retaining polling fallback", async () => {
    const target = join(root, "native.txt");
    await writeFile(target, "before", "utf8");
    const watch = await watches.create({ ownerId: "owner-a", kind: "file", target });
    await watches.pollOnce(watch.watchId);
    await watches.start();
    await writeFile(target, "native change", "utf8");
    await expect.poll(() => watches.events(watch.watchId, "owner-a").items.length, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  test("detects log append, truncation, and rotation without duplicate unchanged events", async () => {
    const target = join(root, "application.log");
    await writeFile(target, "existing\n", "utf8");
    const watch = await watches.create({ ownerId: "owner-a", kind: "log", target });
    await watches.pollOnce(watch.watchId);
    await appendFile(target, "next line\n", "utf8");
    await watches.pollOnce(watch.watchId);
    await watches.pollOnce(watch.watchId);
    await writeFile(target, "short\n", "utf8");
    await watches.pollOnce(watch.watchId);
    await rename(target, `${target}.1`);
    await writeFile(target, "rotated\n", "utf8");
    await watches.pollOnce(watch.watchId);

    const events = watches.events(watch.watchId, "owner-a").items;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["log_appended", "log_truncated", "log_rotated"]));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  });

  test("applies URL change silence plus deterministic exponential backoff and event deduplication", async () => {
    let body = "one";
    let fail = false;
    watches = createWatchService({
      database,
      now: () => new Date(nowMs),
      random: () => 0.5,
      urlProbe: async () => {
        if (fail) throw new Error("offline");
        return { status: 200, body };
      }
    });
    const watch = await watches.create({ ownerId: "owner-a", kind: "url", target: "https://example.test/status", intervalMs: 1_000 });
    await watches.pollOnce(watch.watchId);
    await watches.pollOnce(watch.watchId);
    expect(watches.events(watch.watchId, "owner-a").items).toHaveLength(0);
    body = "two";
    nowMs += 1_000;
    await watches.pollOnce(watch.watchId);
    expect(watches.events(watch.watchId, "owner-a").items).toHaveLength(1);
    fail = true;
    nowMs += 1_000;
    await watches.pollOnce(watch.watchId);
    const status = watches.list("owner-a")[0]!;
    expect(status.consecutiveFailures).toBe(1);
    expect(Date.parse(status.nextPollAt!)).toBeGreaterThan(nowMs);

    const eventBus = createEventBus({ database, now: () => new Date(nowMs) });
    const event = { namespace: "owner-a", type: "dedupe", sourceType: "test", sourceId: "one", payload: { ok: true }, dedupeKey: "same" };
    expect(eventBus.publish(event).deduplicated).toBe(false);
    expect(eventBus.publish(event).deduplicated).toBe(true);
    expect(eventBus.events("owner-a").items.filter((item) => item.type === "dedupe")).toHaveLength(1);
  });

  test("pauses autonomous work immediately when its persistent grant is revoked", async () => {
    const target = join(root, "revoked.txt");
    await writeFile(target, "value", "utf8");
    watches = createWatchService({ database, now: () => new Date(nowMs), authorize: async () => false });
    const watch = await watches.create({ ownerId: "owner-a", kind: "file", target, grantId: "revoked-grant" });
    await watches.pollOnce(watch.watchId);
    expect(watches.list("owner-a")[0]).toMatchObject({ state: "paused" });
    expect(watches.events(watch.watchId, "owner-a").items).toEqual([
      expect.objectContaining({ type: "watch_authorization_revoked" })
    ]);
  });
});

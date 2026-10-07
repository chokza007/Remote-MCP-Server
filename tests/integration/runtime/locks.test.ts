import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createLockService, type LockService } from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("leased resource locks", () => {
  let root: string;
  let database: OperationalDatabase;
  let locks: LockService;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-locks-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T00:00:00.000Z");
    locks = createLockService({ database, now: () => new Date(nowMs), defaultLeaseMs: 1_000 });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("canonical path aliases contend for one lock and stale fencing tokens cannot write", async () => {
    const directory = join(root, "files");
    await mkdir(directory);
    const target = join(directory, "resource.txt");
    await writeFile(target, "value", "utf8");
    const alias = join(directory, "nested", "..", "resource.txt");

    const first = await locks.acquire({ ownerId: "owner-a", resources: [target] });
    await expect(locks.acquire({ ownerId: "owner-b", resources: [alias] })).rejects.toMatchObject({ errorCode: "LOCK_CONFLICT" });

    nowMs += 1_001;
    expect((await locks.reconcile()).released).toBe(1);
    const second = await locks.acquire({ ownerId: "owner-b", resources: [alias] });
    expect(second.resources[0]!.fencingToken).toBeGreaterThan(first.resources[0]!.fencingToken);
    await expect(locks.assertFence(target, first.leaseId, first.resources[0]!.fencingToken)).rejects.toMatchObject({ errorCode: "LOCK_FENCE_STALE" });
    await expect(locks.assertFence(alias, second.leaseId, second.resources[0]!.fencingToken)).resolves.toBeUndefined();
  });

  test("renews only for the owning principal and recovers expired leases after restart", async () => {
    const lease = await locks.acquire({ ownerId: "owner-a", resources: [join(root, "one.txt")] });
    await expect(locks.renew(lease.leaseId, "owner-b", 5_000)).rejects.toMatchObject({ errorCode: "LOCK_NOT_OWNED" });
    nowMs += 500;
    const renewed = await locks.renew(lease.leaseId, "owner-a", 5_000);
    expect(Date.parse(renewed.expiresAt)).toBe(nowMs + 5_000);

    nowMs += 5_001;
    const restarted = createLockService({ database, now: () => new Date(nowMs), defaultLeaseMs: 1_000 });
    expect((await restarted.reconcile()).released).toBe(1);
    await expect(restarted.acquire({ ownerId: "owner-b", resources: [join(root, "one.txt")] })).resolves.toMatchObject({ ownerId: "owner-b" });
  });

  test("sorts multi-resource acquisition to avoid deadlock and releases atomically", async () => {
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    const first = await locks.acquire({ ownerId: "owner-a", resources: [b, a] });
    expect(first.resources.map((resource) => resource.identityKey)).toEqual(
      [...first.resources.map((resource) => resource.identityKey)].sort()
    );
    await expect(locks.acquire({ ownerId: "owner-b", resources: [a, b] })).rejects.toMatchObject({ errorCode: "LOCK_CONFLICT" });
    await locks.release(first.leaseId, "owner-a");
    await expect(locks.acquire({ ownerId: "owner-b", resources: [a, b] })).resolves.toMatchObject({ resources: expect.any(Array) });
  });
});

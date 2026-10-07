import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createScheduleRunner, createScheduleService, nextOccurrence, type ScheduleService } from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("persistent timezone-aware scheduler", () => {
  let root: string;
  let database: OperationalDatabase;
  let schedules: ScheduleService;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-schedules-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T01:00:00.000Z");
    schedules = createScheduleService({ database, now: () => new Date(nowMs) });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("calculates daily Bangkok wall-clock runs and persists pause/resume/update state", () => {
    const schedule = schedules.create({
      ownerId: "owner-a",
      timezone: "Asia/Bangkok",
      rule: { kind: "daily", time: "09:00" },
      action: { tool: "fixture", arguments: {} },
      grantId: "grant-a",
      misfirePolicy: "run_once",
      overlapPolicy: "skip"
    });
    expect(schedule.nextRunAt).toBe("2026-10-07T02:00:00.000Z");
    expect(schedules.pause(schedule.scheduleId, "owner-a").state).toBe("paused");
    expect(schedules.resume(schedule.scheduleId, "owner-a").nextRunAt).toBe("2026-10-07T02:00:00.000Z");
    expect(schedules.update(schedule.scheduleId, "owner-a", { rule: { kind: "daily", time: "10:30" } }).nextRunAt)
      .toBe("2026-10-07T03:30:00.000Z");
    expect(createScheduleService({ database, now: () => new Date(nowMs) }).list("owner-a")).toHaveLength(1);
  });

  test("handles DST gaps and fall-back ambiguity without double-running a daily schedule", () => {
    expect(nextOccurrence(
      { kind: "daily", time: "02:30" },
      "America/New_York",
      new Date("2026-03-08T06:00:00.000Z")
    )?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    const first = nextOccurrence(
      { kind: "daily", time: "01:30" },
      "America/New_York",
      new Date("2026-11-01T04:00:00.000Z")
    )!;
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextOccurrence({ kind: "daily", time: "01:30" }, "America/New_York", first)?.toISOString())
      .toBe("2026-11-02T06:30:00.000Z");
  });

  test("marks a one-time schedule completed when its timestamp is already in the past", () => {
    const schedule = schedules.create({
      ownerId: "owner-a",
      timezone: "UTC",
      rule: { kind: "at", at: "2026-10-07T00:59:59.000Z" },
      action: { tool: "fixture", arguments: {} },
      grantId: "grant-a",
      misfirePolicy: "run_once",
      overlapPolicy: "skip"
    });
    expect(schedule).toMatchObject({ state: "completed", nextRunAt: null });
  });

  test("runs one misfire after restart, avoids duplicates/overlap, and records authorization revocation", async () => {
    const dispatched: string[] = [];
    const allowed = schedules.create({
      ownerId: "owner-a",
      timezone: "Asia/Bangkok",
      rule: { kind: "interval", everyMs: 60_000, startAt: "2026-10-07T00:00:00.000Z" },
      action: { tool: "fixture", arguments: { value: 1 } },
      grantId: "grant-allowed",
      misfirePolicy: "run_once",
      overlapPolicy: "skip"
    });
    const revoked = schedules.create({
      ownerId: "owner-a",
      timezone: "UTC",
      rule: { kind: "at", at: "2026-10-07T01:01:00.000Z" },
      action: { tool: "fixture", arguments: { value: 2 } },
      grantId: "grant-revoked",
      misfirePolicy: "run_once",
      overlapPolicy: "skip"
    });
    nowMs = Date.parse("2026-10-07T01:05:00.000Z");
    const runner = createScheduleRunner({
      database,
      now: () => new Date(nowMs),
      authorize: async (schedule) => schedule.grantId !== "grant-revoked",
      dispatch: async (schedule) => { dispatched.push(schedule.scheduleId); return { ok: true }; }
    });
    const first = await runner.runDue();
    expect(first.started).toBe(1);
    expect(first.authorizationRevoked).toBe(1);
    expect(dispatched).toEqual([allowed.scheduleId]);
    expect(await createScheduleRunner({
      database,
      now: () => new Date(nowMs),
      authorize: async () => true,
      dispatch: async (schedule) => { dispatched.push(schedule.scheduleId); return {}; }
    }).runDue()).toMatchObject({ started: 0 });
    expect(schedules.runs(allowed.scheduleId, "owner-a")).toHaveLength(1);
    expect(schedules.runs(revoked.scheduleId, "owner-a")[0]).toMatchObject({ state: "authorization_revoked" });
  });

  test("honors skip and catch-up misfire policies without duplicate scheduled instants", async () => {
    const skipped = schedules.create({
      ownerId: "owner-a", timezone: "UTC",
      rule: { kind: "interval", everyMs: 60_000, startAt: "2026-10-07T00:00:00.000Z" },
      action: { tool: "skip", arguments: {} }, grantId: "grant", misfirePolicy: "skip", overlapPolicy: "skip"
    });
    const catchup = schedules.create({
      ownerId: "owner-a", timezone: "UTC",
      rule: { kind: "interval", everyMs: 60_000, startAt: "2026-10-07T01:00:00.000Z" },
      action: { tool: "catchup", arguments: {} }, grantId: "grant", misfirePolicy: "catch_up", overlapPolicy: "allow"
    });
    nowMs = Date.parse("2026-10-07T01:03:30.000Z");
    const dispatched: string[] = [];
    const runner = createScheduleRunner({
      database, now: () => new Date(nowMs), authorize: async () => true,
      dispatch: async (_schedule, scheduledFor) => { dispatched.push(scheduledFor); return {}; }, maxCatchUpRuns: 10
    });
    await runner.runDue();
    expect(schedules.runs(skipped.scheduleId, "owner-a")).toHaveLength(0);
    expect(schedules.runs(catchup.scheduleId, "owner-a").length).toBeGreaterThanOrEqual(3);
    expect(new Set(dispatched).size).toBe(dispatched.length);
  });
});

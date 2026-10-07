import { randomUUID } from "node:crypto";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export type MisfirePolicy = "skip" | "run_once" | "catch_up";
export type OverlapPolicy = "skip" | "allow";
export type ScheduleState = "active" | "paused" | "completed" | "deleted";
export type ScheduleRule =
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "interval"; readonly everyMs: number; readonly startAt?: string }
  | { readonly kind: "daily"; readonly time: string };

export interface ScheduleAction {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ScheduleRecord {
  readonly scheduleId: string;
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly grantId: string;
  readonly timezone: string;
  readonly rule: ScheduleRule;
  readonly action: ScheduleAction;
  readonly state: ScheduleState;
  readonly misfirePolicy: MisfirePolicy;
  readonly overlapPolicy: OverlapPolicy;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleRun {
  readonly scheduleId: string;
  readonly runId: string;
  readonly scheduledFor: string;
  readonly state: "running" | "succeeded" | "failed" | "authorization_revoked" | "skipped_overlap";
  readonly result: unknown;
  readonly error: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface CreateScheduleInput {
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly grantId: string;
  readonly timezone: string;
  readonly rule: ScheduleRule;
  readonly action: ScheduleAction;
  readonly misfirePolicy: MisfirePolicy;
  readonly overlapPolicy: OverlapPolicy;
}

export interface UpdateScheduleInput {
  readonly timezone?: string;
  readonly rule?: ScheduleRule;
  readonly action?: ScheduleAction;
  readonly grantId?: string;
  readonly misfirePolicy?: MisfirePolicy;
  readonly overlapPolicy?: OverlapPolicy;
}

export interface ScheduleServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
}

interface ScheduleRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly grant_id: string;
  readonly timezone: string;
  readonly rule_json: string;
  readonly action_json: string;
  readonly state: ScheduleState;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner_id: string;
  readonly misfire_policy: MisfirePolicy;
  readonly overlap_policy: OverlapPolicy;
}

interface RunRow {
  readonly schedule_id: string;
  readonly run_id: string;
  readonly scheduled_for: string;
  readonly state: ScheduleRun["state"];
  readonly result_json: string | null;
  readonly error: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

function schedule(row: ScheduleRow): ScheduleRecord {
  return {
    scheduleId: row.id,
    ownerId: row.owner_id,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    grantId: row.grant_id,
    timezone: row.timezone,
    rule: JSON.parse(row.rule_json) as ScheduleRule,
    action: JSON.parse(row.action_json) as ScheduleAction,
    state: row.state,
    misfirePolicy: row.misfire_policy,
    overlapPolicy: row.overlap_policy,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function run(row: RunRow): ScheduleRun {
  return {
    scheduleId: row.schedule_id,
    runId: row.run_id,
    scheduledFor: row.scheduled_for,
    state: row.state,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function scheduleError(message: string, target: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "SCHEDULE_NOT_FOUND",
    message,
    retryable: false,
    suggestedAction: "Refresh the owned schedule list before retrying.",
    target
  });
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

interface DateParts { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number }

function parts(date: Date, timezone: string): DateParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}

function addDays(value: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: value.hour, minute: value.minute };
}

function nextDaily(time: string, timezone: string, after: Date): Date {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) throw new Error("Daily time must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Daily time is invalid");
  const local = parts(after, timezone);
  for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
    const date = addDays(local, dayOffset);
    if (dayOffset === 0 && local.hour * 60 + local.minute >= hour * 60 + minute) continue;
    const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
    const exact: Date[] = [];
    let shifted: Date | null = null;
    for (let deltaMinutes = -16 * 60; deltaMinutes <= 16 * 60; deltaMinutes += 1) {
      const candidate = new Date(naive + deltaMinutes * 60_000);
      if (candidate <= after) continue;
      const candidateParts = parts(candidate, timezone);
      if (candidateParts.year !== date.year || candidateParts.month !== date.month || candidateParts.day !== date.day) continue;
      const candidateMinute = candidateParts.hour * 60 + candidateParts.minute;
      const requestedMinute = hour * 60 + minute;
      if (candidateMinute === requestedMinute) exact.push(candidate);
      else if (candidateMinute > requestedMinute && shifted === null) shifted = candidate;
    }
    if (exact.length > 0) return exact.sort((left, right) => left.getTime() - right.getTime())[0]!;
    if (shifted) return shifted;
  }
  throw new Error("Unable to calculate next daily occurrence");
}

export function nextOccurrence(rule: ScheduleRule, timezone: string, after: Date): Date | null {
  validateTimezone(timezone);
  if (rule.kind === "at") {
    const at = new Date(rule.at);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid at schedule timestamp");
    return at > after ? at : null;
  }
  if (rule.kind === "interval") {
    if (!Number.isSafeInteger(rule.everyMs) || rule.everyMs < 1_000 || rule.everyMs > 365 * 24 * 60 * 60_000) {
      throw new Error("Schedule interval must be from 1000 ms through 365 days");
    }
    const start = rule.startAt === undefined ? after.getTime() : new Date(rule.startAt).getTime();
    if (!Number.isFinite(start)) throw new Error("Invalid interval startAt");
    if (start > after.getTime()) return new Date(start);
    const steps = Math.floor((after.getTime() - start) / rule.everyMs) + 1;
    return new Date(start + steps * rule.everyMs);
  }
  return nextDaily(rule.time, timezone, after);
}

export class ScheduleRepository {
  public constructor(private readonly database: OperationalDatabase) {}

  public get(scheduleId: string): ScheduleRecord {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined
    );
    if (!row) throw scheduleError("The schedule does not exist.", scheduleId);
    return schedule(row);
  }

  public list(ownerId: string): readonly ScheduleRecord[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM schedules WHERE owner_id = ? AND state != 'deleted' ORDER BY created_at, id").all(ownerId) as ScheduleRow[]).map(schedule)
    );
  }

  public due(now: string): readonly ScheduleRecord[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM schedules WHERE state = 'active' AND next_run_at <= ? ORDER BY next_run_at, id").all(now) as ScheduleRow[]).map(schedule)
    );
  }

  public runs(scheduleId: string): readonly ScheduleRun[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_for, run_id").all(scheduleId) as RunRow[]).map(run)
    );
  }

  public claimRuns(
    scheduleId: string,
    occurrences: readonly string[],
    nextRunAt: string | null,
    now: string,
    overlapPolicy: OverlapPolicy
  ): readonly ScheduleRun[] {
    return this.database.writeTransaction((connection) => {
      const current = connection.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId) as ScheduleRow | undefined;
      if (!current || current.state !== "active" || current.next_run_at === null || current.next_run_at > now) return [];
      const running = (connection.prepare(
        "SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ? AND state = 'running'"
      ).get(scheduleId) as { count: number }).count;
      const insert = connection.prepare(
        `INSERT OR IGNORE INTO schedule_runs(
          schedule_id, run_id, scheduled_for, state, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const claimed: ScheduleRun[] = [];
      for (const scheduledFor of occurrences) {
        const state: ScheduleRun["state"] = overlapPolicy === "skip" && running > 0 ? "skipped_overlap" : "running";
        const runId = randomUUID();
        const completedAt = state === "running" ? null : now;
        if (insert.run(scheduleId, runId, scheduledFor, state, now, completedAt).changes === 1) {
          claimed.push({ scheduleId, runId, scheduledFor, state, result: null, error: null, startedAt: now, completedAt });
        }
      }
      connection.prepare(
        "UPDATE schedules SET next_run_at = ?, last_run_at = ?, state = ?, updated_at = ? WHERE id = ?"
      ).run(nextRunAt, occurrences.at(-1) ?? current.last_run_at, nextRunAt === null ? "completed" : "active", now, scheduleId);
      return claimed;
    });
  }

  public completeRun(runId: string, state: ScheduleRun["state"], now: string, result?: unknown, error?: string): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        "UPDATE schedule_runs SET state = ?, result_json = ?, error = ?, completed_at = ? WHERE run_id = ?"
      ).run(state, result === undefined ? null : JSON.stringify(result), error ?? null, now, runId);
    });
  }
}

export class ScheduleService {
  private readonly database: OperationalDatabase;
  private readonly repository: ScheduleRepository;
  private readonly now: () => Date;

  public constructor(options: ScheduleServiceOptions) {
    this.database = options.database;
    this.repository = new ScheduleRepository(options.database);
    this.now = options.now ?? (() => new Date());
  }

  public create(input: CreateScheduleInput): ScheduleRecord {
    this.validate(input);
    const scheduleId = randomUUID();
    const now = this.now();
    const next = nextOccurrence(input.rule, input.timezone, now);
    const timestamp = now.toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO schedules(
          id, workspace_id, grant_id, timezone, rule_json, action_json, state, next_run_at,
          created_at, updated_at, owner_id, misfire_policy, overlap_policy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        scheduleId, input.workspaceId ?? null, input.grantId, input.timezone,
        JSON.stringify(input.rule), JSON.stringify(input.action), next === null ? "completed" : "active", next?.toISOString() ?? null,
        timestamp, timestamp, input.ownerId, input.misfirePolicy, input.overlapPolicy
      );
    });
    return this.repository.get(scheduleId);
  }

  public list(ownerId: string): readonly ScheduleRecord[] {
    return this.repository.list(ownerId);
  }

  public update(scheduleId: string, ownerId: string, patch: UpdateScheduleInput): ScheduleRecord {
    const current = this.owned(scheduleId, ownerId);
    const updated = {
      timezone: patch.timezone ?? current.timezone,
      rule: patch.rule ?? current.rule,
      action: patch.action ?? current.action,
      grantId: patch.grantId ?? current.grantId,
      misfirePolicy: patch.misfirePolicy ?? current.misfirePolicy,
      overlapPolicy: patch.overlapPolicy ?? current.overlapPolicy
    };
    this.validate({ ...updated, ownerId });
    const now = this.now();
    const next = current.state === "active" ? nextOccurrence(updated.rule, updated.timezone, now) : null;
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE schedules SET timezone = ?, rule_json = ?, action_json = ?, grant_id = ?,
          misfire_policy = ?, overlap_policy = ?, next_run_at = ?, updated_at = ? WHERE id = ?`
      ).run(
        updated.timezone, JSON.stringify(updated.rule), JSON.stringify(updated.action), updated.grantId,
        updated.misfirePolicy, updated.overlapPolicy, next?.toISOString() ?? null, now.toISOString(), scheduleId
      );
    });
    return this.repository.get(scheduleId);
  }

  public pause(scheduleId: string, ownerId: string): ScheduleRecord {
    this.owned(scheduleId, ownerId);
    this.setState(scheduleId, "paused", null);
    return this.repository.get(scheduleId);
  }

  public resume(scheduleId: string, ownerId: string): ScheduleRecord {
    const current = this.owned(scheduleId, ownerId);
    const next = nextOccurrence(current.rule, current.timezone, this.now());
    this.setState(scheduleId, next ? "active" : "completed", next?.toISOString() ?? null);
    return this.repository.get(scheduleId);
  }

  public delete(scheduleId: string, ownerId: string): ScheduleRecord {
    this.owned(scheduleId, ownerId);
    this.setState(scheduleId, "deleted", null);
    return this.repository.get(scheduleId);
  }

  public runs(scheduleId: string, ownerId: string): readonly ScheduleRun[] {
    this.owned(scheduleId, ownerId);
    return this.repository.runs(scheduleId);
  }

  private owned(scheduleId: string, ownerId: string): ScheduleRecord {
    const value = this.repository.get(scheduleId);
    if (value.ownerId !== ownerId) throw scheduleError("The schedule does not exist.", scheduleId);
    return value;
  }

  private setState(scheduleId: string, state: ScheduleState, nextRunAt: string | null): void {
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE schedules SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .run(state, nextRunAt, this.now().toISOString(), scheduleId);
    });
  }

  private validate(input: Omit<CreateScheduleInput, "workspaceId">): void {
    if (input.ownerId.trim().length === 0 || input.grantId.trim().length === 0 || input.action.tool.trim().length === 0) {
      throw new Error("Schedule owner, grant, and action tool are required");
    }
    validateTimezone(input.timezone);
    nextOccurrence(input.rule, input.timezone, new Date(0));
  }
}

export function createScheduleService(options: ScheduleServiceOptions): ScheduleService {
  return new ScheduleService(options);
}

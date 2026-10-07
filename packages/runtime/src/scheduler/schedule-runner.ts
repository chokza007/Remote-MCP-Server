import type { OperationalDatabase } from "@remote-mcp/persistence";

import {
  nextOccurrence,
  ScheduleRepository,
  type ScheduleRecord,
  type ScheduleRun
} from "./schedule-service.js";

export interface ScheduleRunnerOptions {
  readonly database: OperationalDatabase;
  readonly authorize: (schedule: ScheduleRecord) => boolean | Promise<boolean>;
  readonly dispatch: (schedule: ScheduleRecord, scheduledFor: string) => unknown | Promise<unknown>;
  readonly now?: () => Date;
  readonly maxCatchUpRuns?: number;
  readonly misfireGraceMs?: number;
}

export interface ScheduleRunSummary {
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly authorizationRevoked: number;
  readonly skipped: number;
}

export class ScheduleRunner {
  private readonly repository: ScheduleRepository;
  private readonly authorize: ScheduleRunnerOptions["authorize"];
  private readonly dispatch: ScheduleRunnerOptions["dispatch"];
  private readonly now: () => Date;
  private readonly maxCatchUpRuns: number;
  private readonly misfireGraceMs: number;

  public constructor(options: ScheduleRunnerOptions) {
    this.repository = new ScheduleRepository(options.database);
    this.authorize = options.authorize;
    this.dispatch = options.dispatch;
    this.now = options.now ?? (() => new Date());
    this.maxCatchUpRuns = options.maxCatchUpRuns ?? 100;
    this.misfireGraceMs = options.misfireGraceMs ?? 1_000;
  }

  public async runDue(): Promise<ScheduleRunSummary> {
    const summary = { started: 0, succeeded: 0, failed: 0, authorizationRevoked: 0, skipped: 0 };
    const now = this.now();
    for (const schedule of this.repository.due(now.toISOString())) {
      const plan = this.plan(schedule, now);
      if (plan.occurrences.length === 0) {
        this.repository.claimRuns(schedule.scheduleId, [], plan.nextRunAt, now.toISOString(), schedule.overlapPolicy);
        continue;
      }
      const claimed = this.repository.claimRuns(
        schedule.scheduleId,
        plan.occurrences,
        plan.nextRunAt,
        now.toISOString(),
        schedule.overlapPolicy
      );
      for (const run of claimed) {
        if (run.state === "skipped_overlap") {
          summary.skipped += 1;
          continue;
        }
        await this.execute(schedule, run, summary);
      }
    }
    return summary;
  }

  private plan(schedule: ScheduleRecord, now: Date): { readonly occurrences: readonly string[]; readonly nextRunAt: string | null } {
    const first = new Date(schedule.nextRunAt!);
    const late = now.getTime() - first.getTime() > this.misfireGraceMs;
    if (late && schedule.misfirePolicy === "skip") {
      return { occurrences: [], nextRunAt: nextOccurrence(schedule.rule, schedule.timezone, now)?.toISOString() ?? null };
    }
    if (schedule.misfirePolicy !== "catch_up") {
      return {
        occurrences: [first.toISOString()],
        nextRunAt: nextOccurrence(schedule.rule, schedule.timezone, now)?.toISOString() ?? null
      };
    }
    const occurrences: string[] = [];
    let cursor: Date | null = first;
    while (cursor && cursor <= now && occurrences.length < this.maxCatchUpRuns) {
      occurrences.push(cursor.toISOString());
      cursor = nextOccurrence(schedule.rule, schedule.timezone, cursor);
    }
    if (cursor && cursor <= now) cursor = nextOccurrence(schedule.rule, schedule.timezone, now);
    return { occurrences, nextRunAt: cursor?.toISOString() ?? null };
  }

  private async execute(schedule: ScheduleRecord, run: ScheduleRun, summary: { started: number; succeeded: number; failed: number; authorizationRevoked: number; skipped: number }): Promise<void> {
    if (!await this.authorize(schedule)) {
      this.repository.completeRun(run.runId, "authorization_revoked", this.now().toISOString(), undefined, "Persistent grant is not valid");
      summary.authorizationRevoked += 1;
      return;
    }
    summary.started += 1;
    try {
      const result = await this.dispatch(schedule, run.scheduledFor);
      this.repository.completeRun(run.runId, "succeeded", this.now().toISOString(), result);
      summary.succeeded += 1;
    } catch (error) {
      this.repository.completeRun(
        run.runId,
        "failed",
        this.now().toISOString(),
        undefined,
        (error instanceof Error ? error.message : String(error)).slice(0, 2_048)
      );
      summary.failed += 1;
    }
  }
}

export function createScheduleRunner(options: ScheduleRunnerOptions): ScheduleRunner {
  return new ScheduleRunner(options);
}

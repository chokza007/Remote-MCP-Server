import { randomUUID } from "node:crypto";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import { JobRepository } from "./job-repository.js";
import type {
  JobEvent,
  JobLogEntry,
  JobPage,
  JobRecord,
  JobStepSpec,
  JobSubmission
} from "./job-types.js";

export interface JobServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
}

function validateGraph(steps: readonly JobStepSpec[]): void {
  if (steps.length === 0) throw new Error("Job requires at least one step");
  const byId = new Map<string, JobStepSpec>();
  for (const step of steps) {
    if (step.stepId.trim().length === 0) throw new Error("Job step ID must not be empty");
    if (byId.has(step.stepId)) throw new Error(`Duplicate job step ID: ${step.stepId}`);
    byId.set(step.stepId, step);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${step.stepId}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Job dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.stepId);
}

function validatePage(cursor: number, limit: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Cursor must be non-negative");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Page limit must be from 1 through 1000");
  }
}

export class JobService {
  readonly #repository: JobRepository;
  readonly #now: () => Date;

  public constructor(options: JobServiceOptions) {
    this.#repository = new JobRepository(options.database);
    this.#now = options.now ?? (() => new Date());
  }

  public submit(submission: JobSubmission): { readonly jobId: string; readonly deduplicated: boolean } {
    if (submission.idempotencyKey !== undefined) {
      const existing = this.#repository.findByIdempotencyKey(submission);
      if (existing !== null) return { jobId: existing, deduplicated: true };
    }
    validateGraph(submission.steps);
    if ((submission.retryPolicy?.maxAttempts ?? 1) < 1) throw new Error("Retry maxAttempts must be positive");
    const jobId = randomUUID();
    this.#repository.insert(jobId, submission, this.#now().toISOString());
    return { jobId, deduplicated: false };
  }

  public get(jobId: string): JobRecord {
    return this.#repository.get(jobId);
  }

  public list(): readonly JobRecord[] {
    return this.#repository.list();
  }

  public events(jobId: string, cursor = 0, limit = 100): JobPage<JobEvent> {
    validatePage(cursor, limit);
    return this.#repository.events(jobId, cursor, limit);
  }

  public logs(jobId: string, cursor = 0, limit = 100): JobPage<JobLogEntry> {
    validatePage(cursor, limit);
    return this.#repository.logs(jobId, cursor, limit);
  }

  public cancel(jobId: string): void {
    const current = this.get(jobId);
    if (["succeeded", "failed", "cancelled", "orphaned", "needs_attention"].includes(current.state)) return;
    const now = this.#now().toISOString();
    const state = current.state === "running" ? "cancelling" : "cancelled";
    this.#repository.setState(jobId, state, now);
    this.#repository.appendEvent(jobId, state === "cancelling" ? "cancellation_requested" : "cancelled", {}, now);
  }

  public pause(jobId: string): void {
    const current = this.get(jobId);
    if (!["queued", "running"].includes(current.state)) throw new Error(`Job cannot pause from ${current.state}`);
    const now = this.#now().toISOString();
    this.#repository.setState(jobId, "paused", now);
    this.#repository.appendEvent(jobId, "paused", {}, now);
  }

  public resume(jobId: string): void {
    const current = this.get(jobId);
    if (current.state !== "paused") throw new Error(`Job cannot resume from ${current.state}`);
    const now = this.#now().toISOString();
    this.#repository.setState(jobId, "queued", now);
    this.#repository.appendEvent(jobId, "resumed", {}, now);
  }

  public retry(jobId: string): void {
    const current = this.get(jobId);
    if (!["failed", "orphaned", "needs_attention", "cancelled"].includes(current.state)) {
      throw new Error(`Job cannot retry from ${current.state}`);
    }
    const maxAttempts = current.retryPolicy?.maxAttempts ?? 1;
    if (this.#repository.runningAttempts(jobId) >= maxAttempts) throw new Error("Job retry policy exhausted");
    if (current.steps.some((step) => !step.idempotent)) throw new Error("Unsafe non-idempotent job cannot retry");
    this.#repository.resetForRetry(jobId, this.#now().toISOString());
  }
}

export function createJobService(options: JobServiceOptions): JobService {
  return new JobService(options);
}

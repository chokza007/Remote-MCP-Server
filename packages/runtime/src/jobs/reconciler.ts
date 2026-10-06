import type { OperationalDatabase } from "@remote-mcp/persistence";

import { JobRepository } from "./job-repository.js";
import type { ProcessAttachment } from "./job-types.js";

export interface JobReconcilerOptions {
  readonly database: OperationalDatabase;
  readonly staleAfterMs: number;
  readonly inspectProcess: (identity: ProcessAttachment) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

export interface ReconcileResult {
  readonly reattached: number;
  readonly requeued: number;
  readonly orphaned: number;
}

export class JobReconciler {
  readonly #repository: JobRepository;
  readonly #staleAfterMs: number;
  readonly #inspectProcess: JobReconcilerOptions["inspectProcess"];
  readonly #now: () => Date;

  public constructor(options: JobReconcilerOptions) {
    this.#repository = new JobRepository(options.database);
    this.#staleAfterMs = options.staleAfterMs;
    this.#inspectProcess = options.inspectProcess;
    this.#now = options.now ?? (() => new Date());
  }

  public async reconcile(): Promise<ReconcileResult> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - this.#staleAfterMs).toISOString();
    const result = { reattached: 0, requeued: 0, orphaned: 0 };
    for (const job of this.#repository.staleRunning(cutoff)) {
      if (job.processIdentity && await this.#inspectProcess(job.processIdentity)) {
        const timestamp = now.toISOString();
        this.#repository.heartbeat(job.jobId, timestamp);
        this.#repository.appendEvent(job.jobId, "reattached", { processIdentity: job.processIdentity }, timestamp);
        result.reattached += 1;
        continue;
      }
      const maxAttempts = job.retryPolicy?.maxAttempts ?? 1;
      const canRetry =
        this.#repository.runningAttempts(job.jobId) < maxAttempts &&
        job.steps.every((step) => step.idempotent);
      if (canRetry) {
        this.#repository.resetForRetry(job.jobId, now.toISOString(), "requeued_after_restart");
        result.requeued += 1;
      } else {
        const timestamp = now.toISOString();
        this.#repository.setState(job.jobId, "orphaned", timestamp, null);
        this.#repository.appendEvent(job.jobId, "orphaned", {}, timestamp);
        result.orphaned += 1;
      }
    }
    return result;
  }
}

export function createJobReconciler(options: JobReconcilerOptions): JobReconciler {
  return new JobReconciler(options);
}

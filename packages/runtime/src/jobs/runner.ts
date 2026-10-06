import type { OperationalDatabase } from "@remote-mcp/persistence";

import { JobLogStore } from "./log-store.js";
import { JobRepository } from "./job-repository.js";
import type {
  JobHandler,
  JobHandlerContext,
  JobRecord,
  JobStepResult,
  JobStepSpec,
  StepAuthorization
} from "./job-types.js";

export interface JobRunnerOptions {
  readonly database: OperationalDatabase;
  readonly authorizeStep: (
    job: JobRecord,
    step: JobStepSpec
  ) => StepAuthorization | Promise<StepAuthorization>;
  readonly now?: () => Date;
  readonly redactLog?: (value: string) => string;
}

class JobCancelledError extends Error {
  public constructor() {
    super("Job cancellation requested");
    this.name = "JobCancelledError";
  }
}

export class JobRunner {
  readonly #repository: JobRepository;
  readonly #logs: JobLogStore;
  readonly #authorizeStep: JobRunnerOptions["authorizeStep"];
  readonly #now: () => Date;
  readonly #handlers = new Map<string, JobHandler>();

  public constructor(options: JobRunnerOptions) {
    this.#repository = new JobRepository(options.database);
    this.#now = options.now ?? (() => new Date());
    this.#authorizeStep = options.authorizeStep;
    this.#logs = new JobLogStore(this.#repository, {
      ...(options.redactLog === undefined ? {} : { redact: options.redactLog }),
      now: this.#now
    });
  }

  public register(kind: string, handler: JobHandler): void {
    if (this.#handlers.has(kind)) throw new Error(`Job handler already registered: ${kind}`);
    this.#handlers.set(kind, handler);
  }

  public async runNext(): Promise<string | null> {
    const now = this.#now().toISOString();
    const job = this.#repository.claimNext(now);
    if (!job) return null;
    await this.run(job.jobId);
    return job.jobId;
  }

  private async run(jobId: string): Promise<void> {
    const verifications = this.#repository.steps(jobId)
      .filter((step) => step.state === "succeeded" && step.result?.verification?.verified)
      .map((step) => step.result!.verification!.evidence);
    try {
      for (;;) {
        const current = this.#repository.get(jobId);
        if (current.state === "cancelling") throw new JobCancelledError();
        if (current.state === "paused") return;
        const steps = this.#repository.steps(jobId);
        const succeeded = new Set(steps.filter((step) => step.state === "succeeded").map((step) => step.spec.stepId));
        const next = steps.find(
          (step) => step.state !== "succeeded" && step.spec.dependsOn.every((dependency) => succeeded.has(dependency))
        );
        if (!next) {
          if (steps.every((step) => step.state === "succeeded")) {
            const verification = { verified: true, steps: steps.length, evidence: verifications };
            const completedAt = this.#now().toISOString();
            this.#repository.setState(jobId, "succeeded", completedAt, verification);
            this.#repository.appendEvent(jobId, "succeeded", verification, completedAt);
          } else {
            throw new Error("Job dependency graph cannot make progress");
          }
          return;
        }

        const authorization = await this.#authorizeStep(current, next.spec);
        if (!authorization.allowed) {
          const stoppedAt = this.#now().toISOString();
          this.#repository.setState(jobId, "cancelled", stoppedAt, null);
          this.#repository.appendEvent(
            jobId,
            "authorization_revoked",
            { reason: authorization.reason, stepId: next.spec.stepId },
            stoppedAt
          );
          return;
        }

        const handler = this.#handlers.get(next.spec.kind);
        if (!handler) throw new Error(`No job handler registered for kind: ${next.spec.kind}`);
        const startedAt = this.#now().toISOString();
        this.#repository.updateStep(jobId, next.number, "running", startedAt);
        this.#repository.heartbeat(jobId, startedAt);
        this.#repository.appendEvent(jobId, "step_started", { stepId: next.spec.stepId }, startedAt);
        const context = this.context(jobId);
        const result = await handler(next.spec, context);
        context.throwIfCancelled();
        const finishedAt = this.#now().toISOString();
        this.#repository.updateStep(jobId, next.number, "succeeded", finishedAt, result);
        if (!result.verification?.verified) {
          this.#repository.setState(jobId, "needs_attention", finishedAt, null);
          this.#repository.appendEvent(
            jobId,
            "verification_missing",
            { stepId: next.spec.stepId },
            finishedAt
          );
          return;
        }
        verifications.push(result.verification.evidence);
        this.#repository.appendEvent(
          jobId,
          "step_succeeded",
          { stepId: next.spec.stepId, verification: result.verification },
          finishedAt
        );
        this.#repository.heartbeat(jobId, finishedAt);
        if (this.#repository.get(jobId).state === "paused") return;
      }
    } catch (error) {
      const failedAt = this.#now().toISOString();
      if (error instanceof JobCancelledError) {
        this.#repository.setState(jobId, "cancelled", failedAt, null);
        this.#repository.appendEvent(jobId, "cancelled", {}, failedAt);
      } else {
        this.#repository.setState(jobId, "failed", failedAt, null);
        this.#repository.appendEvent(
          jobId,
          "failed",
          { message: error instanceof Error ? error.message : String(error) },
          failedAt
        );
      }
    }
  }

  private context(jobId: string): JobHandlerContext {
    return {
      log: (stream, content) => {
        this.#logs.append(jobId, stream, content);
        this.#repository.heartbeat(jobId, this.#now().toISOString());
      },
      heartbeat: () => this.#repository.heartbeat(jobId, this.#now().toISOString()),
      throwIfCancelled: () => {
        if (["cancelling", "cancelled"].includes(this.#repository.get(jobId).state)) {
          throw new JobCancelledError();
        }
      },
      recordProcessIdentity: (identity) =>
        this.#repository.setProcessIdentity(jobId, identity, this.#now().toISOString())
    };
  }
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  return new JobRunner(options);
}

export type JobState =
  | "queued"
  | "waiting_approval"
  | "running"
  | "paused"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "orphaned"
  | "needs_attention";

export interface JobStepSpec {
  readonly stepId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly dependsOn: readonly string[];
  readonly idempotent: boolean;
}

export interface JobRetryPolicy {
  readonly maxAttempts: number;
}

export interface JobSubmission {
  readonly kind: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly grantId?: string;
  readonly idempotencyKey?: string;
  readonly retryPolicy?: JobRetryPolicy;
  readonly steps: readonly JobStepSpec[];
}

export interface ProcessAttachment {
  readonly pid: number;
  readonly createdAt: string;
  readonly commandFingerprint: string;
}

export interface JobRecord extends JobSubmission {
  readonly jobId: string;
  readonly state: JobState;
  readonly heartbeatAt: string | null;
  readonly processIdentity: ProcessAttachment | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly verification: Record<string, unknown> | null;
}

export interface JobEvent {
  readonly sequence: number;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface JobLogEntry {
  readonly sequence: number;
  readonly stream: "stdout" | "stderr" | "system";
  readonly content: string;
  readonly occurredAt: string;
}

export interface JobPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: number | null;
}

export interface StepVerification {
  readonly verified: true;
  readonly evidence: unknown;
}

export interface JobStepResult {
  readonly result: unknown;
  readonly verification?: StepVerification;
}

export interface JobHandlerContext {
  log(stream: JobLogEntry["stream"], content: string): void;
  heartbeat(): void;
  throwIfCancelled(): void;
  recordProcessIdentity(identity: ProcessAttachment): void;
}

export type JobHandler = (
  step: JobStepSpec,
  context: JobHandlerContext
) => JobStepResult | Promise<JobStepResult>;

export type StepAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

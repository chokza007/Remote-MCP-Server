import type { OperationalDatabase } from "@remote-mcp/persistence";

import type {
  JobEvent,
  JobLogEntry,
  JobPage,
  JobRecord,
  JobStepResult,
  JobState,
  JobStepSpec,
  JobSubmission,
  ProcessAttachment
} from "./job-types.js";

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly state: JobState;
  readonly principal_id: string;
  readonly client_id: string;
  readonly session_id: string | null;
  readonly workspace_id: string | null;
  readonly grant_id: string | null;
  readonly specification_json: string;
  readonly idempotency_key: string | null;
  readonly retry_policy_json: string;
  readonly process_identity_json: string | null;
  readonly heartbeat_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly verification_json: string | null;
}

function asRecord(row: JobRow): JobRecord {
  const specification = JSON.parse(row.specification_json) as { readonly steps: readonly JobStepSpec[] };
  return {
    jobId: row.id,
    kind: row.kind,
    state: row.state,
    principalId: row.principal_id,
    clientId: row.client_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    retryPolicy: JSON.parse(row.retry_policy_json) as { maxAttempts: number },
    steps: specification.steps,
    heartbeatAt: row.heartbeat_at,
    processIdentity: row.process_identity_json === null
      ? null
      : JSON.parse(row.process_identity_json) as ProcessAttachment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    verification: row.verification_json === null
      ? null
      : JSON.parse(row.verification_json) as Record<string, unknown>
  };
}

export class JobRepository {
  readonly #database: OperationalDatabase;

  public constructor(database: OperationalDatabase) {
    this.#database = database;
  }

  public findByIdempotencyKey(submission: JobSubmission): string | null {
    if (submission.idempotencyKey === undefined) return null;
    const row = this.#database.read((connection) =>
      connection.prepare(
        `SELECT id FROM jobs
         WHERE principal_id = ? AND client_id = ? AND workspace_id IS ? AND idempotency_key = ?`
      ).get(
        submission.principalId,
        submission.clientId,
        submission.workspaceId ?? null,
        submission.idempotencyKey
      ) as { id: string } | undefined
    );
    return row?.id ?? null;
  }

  public insert(jobId: string, submission: JobSubmission, now: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO jobs(
          id, kind, state, principal_id, client_id, session_id, workspace_id, grant_id,
          specification_json, idempotency_key, retry_policy_json, heartbeat_at,
          created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        jobId,
        submission.kind,
        submission.principalId,
        submission.clientId,
        submission.sessionId ?? null,
        submission.workspaceId ?? null,
        submission.grantId ?? null,
        JSON.stringify({ steps: submission.steps }),
        submission.idempotencyKey ?? null,
        JSON.stringify(submission.retryPolicy ?? { maxAttempts: 1 }),
        now,
        now
      );
      const insertStep = connection.prepare(
        `INSERT INTO job_steps(job_id, step_number, state, specification_json)
         VALUES (?, ?, 'queued', ?)`
      );
      submission.steps.forEach((step, index) => insertStep.run(jobId, index, JSON.stringify(step)));
      connection.prepare(
        `INSERT INTO job_events(job_id, sequence, event_type, payload_json, occurred_at)
         VALUES (?, 0, 'queued', '{}', ?)`
      ).run(jobId, now);
    });
  }

  public get(jobId: string): JobRecord {
    const row = this.#database.read((connection) =>
      connection.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined
    );
    if (!row) throw new Error(`Unknown job: ${jobId}`);
    return asRecord(row);
  }

  public list(): readonly JobRecord[] {
    return this.#database.read((connection) =>
      (connection.prepare("SELECT * FROM jobs ORDER BY created_at, id").all() as JobRow[]).map(asRecord)
    );
  }

  public claimNext(now: string): JobRecord | null {
    return this.#database.writeTransaction((connection) => {
      const row = connection.prepare(
        "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at, id LIMIT 1"
      ).get() as JobRow | undefined;
      if (!row) return null;
      connection.prepare(
        "UPDATE jobs SET state = 'running', heartbeat_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'"
      ).run(now, now, row.id);
      this.appendEventWithConnection(connection, row.id, "running", {}, now);
      return this.get(row.id);
    });
  }

  public steps(jobId: string): ReadonlyArray<{
    readonly number: number;
    readonly state: string;
    readonly spec: JobStepSpec;
    readonly result: JobStepResult | null;
  }> {
    return this.#database.read((connection) =>
      (connection.prepare(
        "SELECT step_number, state, specification_json, result_json FROM job_steps WHERE job_id = ? ORDER BY step_number"
      ).all(jobId) as Array<{
        step_number: number;
        state: string;
        specification_json: string;
        result_json: string | null;
      }>).map((row) => ({
        number: row.step_number,
        state: row.state,
        spec: JSON.parse(row.specification_json) as JobStepSpec,
        result: row.result_json === null ? null : JSON.parse(row.result_json) as JobStepResult
      }))
    );
  }

  public updateStep(jobId: string, number: number, state: string, now: string, result?: unknown): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE job_steps SET state = ?,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('succeeded','failed','cancelled') THEN ? ELSE completed_at END,
          result_json = CASE WHEN ? IS NULL THEN result_json ELSE ? END
         WHERE job_id = ? AND step_number = ?`
      ).run(
        state,
        state,
        now,
        state,
        now,
        result === undefined ? null : 1,
        result === undefined ? null : JSON.stringify(result),
        jobId,
        number
      );
    });
  }

  public setState(
    jobId: string,
    state: JobState,
    now: string,
    verification?: Record<string, unknown> | null
  ): void {
    const terminal = ["succeeded", "failed", "cancelled", "orphaned", "needs_attention"].includes(state);
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE jobs SET state = ?, updated_at = ?,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END,
          verification_json = CASE WHEN ? = 0 THEN verification_json ELSE ? END
         WHERE id = ?`
      ).run(
        state,
        now,
        terminal ? 1 : 0,
        now,
        verification === undefined ? 0 : 1,
        verification == null ? null : JSON.stringify(verification),
        jobId
      );
    });
  }

  public heartbeat(jobId: string, now: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare("UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, jobId);
    });
  }

  public setProcessIdentity(jobId: string, identity: ProcessAttachment, now: string): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare("UPDATE jobs SET process_identity_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(identity), now, jobId);
    });
  }

  public appendEvent(jobId: string, type: string, payload: unknown, now: string): void {
    this.#database.writeTransaction((connection) => {
      this.appendEventWithConnection(connection, jobId, type, payload, now);
    });
  }

  public appendLog(jobId: string, stream: JobLogEntry["stream"], content: string, now: string): void {
    this.#database.writeTransaction((connection) => {
      const next = (connection.prepare(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_logs WHERE job_id = ?"
      ).get(jobId) as { sequence: number }).sequence;
      connection.prepare(
        "INSERT INTO job_logs(job_id, sequence, stream, content_redacted, occurred_at) VALUES (?, ?, ?, ?, ?)"
      ).run(jobId, next, stream, content, now);
    });
  }

  public events(jobId: string, cursor: number, limit: number): JobPage<JobEvent> {
    this.get(jobId);
    const rows = this.#database.read((connection) =>
      connection.prepare(
        `SELECT sequence, event_type, payload_json, occurred_at FROM job_events
         WHERE job_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?`
      ).all(jobId, cursor, limit + 1) as Array<{
        sequence: number; event_type: string; payload_json: string; occurred_at: string;
      }>
    );
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => ({
        sequence: row.sequence,
        type: row.event_type,
        payload: JSON.parse(row.payload_json) as unknown,
        occurredAt: row.occurred_at
      })),
      nextCursor: hasMore ? (visible.at(-1)?.sequence ?? cursor) + 1 : null
    };
  }

  public logs(jobId: string, cursor: number, limit: number): JobPage<JobLogEntry> {
    this.get(jobId);
    const rows = this.#database.read((connection) =>
      connection.prepare(
        `SELECT sequence, stream, content_redacted, occurred_at FROM job_logs
         WHERE job_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?`
      ).all(jobId, cursor, limit + 1) as Array<{
        sequence: number; stream: JobLogEntry["stream"]; content_redacted: string; occurred_at: string;
      }>
    );
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map((row) => ({
        sequence: row.sequence,
        stream: row.stream,
        content: row.content_redacted,
        occurredAt: row.occurred_at
      })),
      nextCursor: hasMore ? (visible.at(-1)?.sequence ?? cursor) + 1 : null
    };
  }

  public resetForRetry(jobId: string, now: string, eventType = "retry_queued"): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE job_steps SET state = 'queued', started_at = NULL, completed_at = NULL, result_json = NULL
         WHERE job_id = ? AND state <> 'succeeded'`
      ).run(jobId);
      connection.prepare(
        `UPDATE jobs SET state = 'queued', heartbeat_at = NULL, process_identity_json = NULL,
          completed_at = NULL, verification_json = NULL, updated_at = ? WHERE id = ?`
      ).run(now, jobId);
      this.appendEventWithConnection(connection, jobId, eventType, {}, now);
    });
  }

  public runningAttempts(jobId: string): number {
    return this.#database.read((connection) =>
      (connection.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND event_type = 'running'"
      ).get(jobId) as { count: number }).count
    );
  }

  public staleRunning(cutoff: string): readonly JobRecord[] {
    return this.#database.read((connection) =>
      (connection.prepare(
        "SELECT * FROM jobs WHERE state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?) ORDER BY created_at"
      ).all(cutoff) as JobRow[]).map(asRecord)
    );
  }

  public markRunningFixture(
    jobId: string,
    input: { readonly heartbeatAt: string; readonly processIdentity: ProcessAttachment | null }
  ): void {
    this.#database.writeTransaction((connection) => {
      const runningEvents = (connection.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND event_type = 'running'"
      ).get(jobId) as { count: number }).count;
      connection.prepare(
        "UPDATE jobs SET state = 'running', heartbeat_at = ?, process_identity_json = ?, updated_at = ? WHERE id = ?"
      ).run(
        input.heartbeatAt,
        input.processIdentity === null ? null : JSON.stringify(input.processIdentity),
        input.heartbeatAt,
        jobId
      );
      if (runningEvents === 0) {
        this.appendEventWithConnection(connection, jobId, "running", { fixture: true }, input.heartbeatAt);
      }
    });
  }

  private appendEventWithConnection(
    connection: Parameters<OperationalDatabase["read"]>[0] extends (connection: infer C) => unknown ? C : never,
    jobId: string,
    type: string,
    payload: unknown,
    now: string
  ): void {
    const next = (connection.prepare(
      "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM job_events WHERE job_id = ?"
    ).get(jobId) as { sequence: number }).sequence;
    connection.prepare(
      "INSERT INTO job_events(job_id, sequence, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)"
    ).run(jobId, next, type, JSON.stringify(payload), now);
  }
}

export function createJobRepository(database: OperationalDatabase): JobRepository {
  return new JobRepository(database);
}

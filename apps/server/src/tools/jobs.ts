import { z } from "zod";

import type { GrantService } from "@remote-mcp/control-plane";
import type { JobService, JobStepSpec } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface JobToolDependencies {
  readonly jobs: JobService;
  readonly grants: GrantService;
}

const jobIdSchema = { jobId: z.string().uuid() };
const pageSchema = {
  ...jobIdSchema,
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1_000).optional()
};

function ownedJob(dependencies: JobToolDependencies, context: ToolExecutionContext, jobId: string) {
  const job = dependencies.jobs.get(jobId);
  if (
    job.principalId !== context.identity.principalId ||
    job.clientId !== context.identity.clientId
  ) {
    throw new Error(`Unknown job: ${jobId}`);
  }
  return job;
}

export function registerJobTools(
  registry: ToolRegistry,
  dependencies: JobToolDependencies
): void {
  registry.register(
    coreDescriptor("job_submit", "Submit durable job", "Queues a restart-safe background job and returns immediately.", 1),
    (args, context) => {
      const resolution = dependencies.grants.resolve(context.identity);
      if (resolution.state !== "granted") {
        throw new Error(`Current persistent grant is unavailable: ${resolution.reason}`);
      }
      return {
        schemaVersion: 1,
        ...dependencies.jobs.submit({
          kind: String(args.kind),
          principalId: context.identity.principalId,
          clientId: context.identity.clientId,
          ...(context.identity.sessionId === undefined
            ? {}
            : { sessionId: context.identity.sessionId }),
          grantId: resolution.grant.id,
          ...(args.workspaceId === undefined ? {} : { workspaceId: String(args.workspaceId) }),
          ...(args.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: String(args.idempotencyKey) }),
          ...(args.retryPolicy === undefined
            ? {}
            : { retryPolicy: args.retryPolicy as { maxAttempts: number } }),
          steps: args.steps as JobStepSpec[]
        })
      };
    },
    {
      inputSchema: {
        kind: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
        idempotencyKey: z.string().min(1).optional(),
        retryPolicy: z.object({ maxAttempts: z.number().int().min(1).max(100) }).optional(),
        steps: z.array(z.object({
          stepId: z.string().min(1),
          kind: z.string().min(1),
          payload: z.unknown(),
          dependsOn: z.array(z.string().min(1)),
          idempotent: z.boolean()
        })).min(1)
      }
    }
  );

  registry.register(
    coreDescriptor("job_get", "Get durable job", "Reads current durable job state and verification.", 0),
    (args, context) => ({ schemaVersion: 1, job: ownedJob(dependencies, context, String(args.jobId)) }),
    { inputSchema: jobIdSchema }
  );

  registry.register(
    coreDescriptor("job_list", "List durable jobs", "Lists durable jobs owned by this client.", 0),
    (_args, context) => ({
      schemaVersion: 1,
      jobs: dependencies.jobs.list().filter((job) =>
        job.principalId === context.identity.principalId &&
        job.clientId === context.identity.clientId
      )
    })
  );

  registry.register(
    coreDescriptor("job_events", "Read job events", "Reads an ordered page of durable job events.", 0),
    (args, context) => {
      const jobId = String(args.jobId);
      ownedJob(dependencies, context, jobId);
      return {
        schemaVersion: 1,
        ...dependencies.jobs.events(jobId, Number(args.cursor ?? 0), Number(args.limit ?? 100))
      };
    },
    { inputSchema: pageSchema }
  );

  registry.register(
    coreDescriptor("job_logs", "Read job logs", "Reads an ordered redacted page of durable job logs.", 0),
    (args, context) => {
      const jobId = String(args.jobId);
      ownedJob(dependencies, context, jobId);
      return {
        schemaVersion: 1,
        ...dependencies.jobs.logs(jobId, Number(args.cursor ?? 0), Number(args.limit ?? 100))
      };
    },
    { inputSchema: pageSchema }
  );

  for (const operation of ["cancel", "pause", "resume", "retry"] as const) {
    registry.register(
      coreDescriptor(`job_${operation}`, `${operation} durable job`, `${operation}s an owned durable job.`, 2),
      (args, context) => {
        const jobId = String(args.jobId);
        ownedJob(dependencies, context, jobId);
        dependencies.jobs[operation](jobId);
        return { schemaVersion: 1, job: dependencies.jobs.get(jobId) };
      },
      { inputSchema: jobIdSchema }
    );
  }
}

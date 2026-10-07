import { z } from "zod";

import type { GrantService } from "@remote-mcp/control-plane";
import type { ScheduleRule, ScheduleService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface ScheduleToolDependencies {
  readonly schedules: ScheduleService;
  readonly grants: GrantService;
  readonly runDue: () => Promise<unknown>;
}

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

const scheduleId = z.string().uuid();
const rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.iso.datetime() }),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().min(1_000), startAt: z.iso.datetime().optional() }),
  z.object({ kind: z.literal("daily"), time: z.string().regex(/^\d{2}:\d{2}$/u) })
]);
const action = z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.unknown()) });

export function registerScheduleTools(registry: ToolRegistry, dependencies: ScheduleToolDependencies): void {
  registry.register(
    coreDescriptor("schedule_create", "Create schedule", "Creates a persistent timezone-aware action schedule bound to the current grant.", 1),
    (args, context) => {
      const grant = dependencies.grants.resolve(context.identity);
      if (grant.state !== "granted") throw new Error(`Persistent grant unavailable: ${grant.reason}`);
      return { schemaVersion: 1, schedule: dependencies.schedules.create({
        ownerId: owner(context),
        grantId: grant.grant.id,
        timezone: String(args.timezone),
        rule: args.rule as ScheduleRule,
        action: args.action as { tool: string; arguments: Record<string, unknown> },
        misfirePolicy: args.misfirePolicy as "skip" | "run_once" | "catch_up",
        overlapPolicy: args.overlapPolicy as "skip" | "allow",
        ...(args.workspaceId === undefined ? {} : { workspaceId: String(args.workspaceId) })
      }) };
    },
    {
      inputSchema: {
        timezone: z.string().min(1), rule, action,
        misfirePolicy: z.enum(["skip", "run_once", "catch_up"]),
        overlapPolicy: z.enum(["skip", "allow"]),
        workspaceId: z.string().min(1).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("schedule_list", "List schedules", "Lists active and paused schedules owned by this client.", 0),
    (_args, context) => ({ schemaVersion: 1, schedules: dependencies.schedules.list(owner(context)) })
  );

  registry.register(
    coreDescriptor("schedule_update", "Update schedule", "Updates an owned schedule and recalculates its next wall-clock occurrence.", 1),
    (args, context) => ({ schemaVersion: 1, schedule: dependencies.schedules.update(
      String(args.scheduleId),
      owner(context),
      {
        ...(args.timezone === undefined ? {} : { timezone: String(args.timezone) }),
        ...(args.rule === undefined ? {} : { rule: args.rule as ScheduleRule }),
        ...(args.action === undefined ? {} : { action: args.action as { tool: string; arguments: Record<string, unknown> } }),
        ...(args.misfirePolicy === undefined ? {} : { misfirePolicy: args.misfirePolicy as "skip" | "run_once" | "catch_up" }),
        ...(args.overlapPolicy === undefined ? {} : { overlapPolicy: args.overlapPolicy as "skip" | "allow" })
      }
    ) }),
    {
      inputSchema: {
        scheduleId,
        timezone: z.string().min(1).optional(),
        rule: rule.optional(), action: action.optional(),
        misfirePolicy: z.enum(["skip", "run_once", "catch_up"]).optional(),
        overlapPolicy: z.enum(["skip", "allow"]).optional()
      }
    }
  );

  for (const operation of ["pause", "resume", "delete"] as const) {
    registry.register(
      coreDescriptor(`schedule_${operation}`, `${operation} schedule`, `${operation}s an owned schedule.`, 1),
      (args, context) => ({
        schemaVersion: 1,
        schedule: dependencies.schedules[operation](String(args.scheduleId), owner(context))
      }),
      { inputSchema: { scheduleId } }
    );
  }

  registry.register(
    coreDescriptor("schedule_runs", "List schedule runs", "Lists durable run history for an owned schedule.", 0),
    (args, context) => ({
      schemaVersion: 1,
      runs: dependencies.schedules.runs(String(args.scheduleId), owner(context))
    }),
    { inputSchema: { scheduleId } }
  );

  registry.register(
    coreDescriptor("schedule_run_due", "Run due schedules", "Runs due schedules after rechecking their persistent grants.", 1),
    async () => ({ schemaVersion: 1, result: await dependencies.runDue() })
  );
}

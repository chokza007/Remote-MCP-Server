import { z } from "zod";

import type { GrantService } from "@remote-mcp/control-plane";
import type { EventBus, WatchKind, WatchService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

export function registerWatchTools(registry: ToolRegistry, watches: WatchService, grants: GrantService, events: EventBus): void {
  registry.register(
    coreDescriptor("watch_create", "Create persistent watch", "Creates a restart-safe file, directory, process, port, job, log, or URL watch.", 1),
    async (args, context) => {
      const grant = grants.resolve(context.identity);
      if (grant.state !== "granted") throw new Error(`Persistent grant unavailable: ${grant.reason}`);
      return { schemaVersion: 1, watch: await watches.create({
        ownerId: owner(context),
        kind: args.kind as WatchKind,
        target: String(args.target),
        grantId: grant.grant.id,
        ...(args.workspaceId === undefined ? {} : { workspaceId: String(args.workspaceId) }),
        ...(args.intervalMs === undefined ? {} : { intervalMs: Number(args.intervalMs) }),
        ...(args.specification === undefined ? {} : { specification: args.specification as Record<string, unknown> })
      }) };
    },
    {
      inputSchema: {
        kind: z.enum(["file", "directory", "process", "port", "job", "log", "url"]),
        target: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
        intervalMs: z.number().int().min(100).max(86_400_000).optional(),
        specification: z.record(z.string(), z.unknown()).optional()
      },
      openWorld: true
    }
  );

  registry.register(
    coreDescriptor("watch_list", "List persistent watches", "Lists watches owned by this client.", 0),
    (_args, context) => ({ schemaVersion: 1, watches: watches.list(owner(context)) })
  );

  for (const operation of ["pause", "resume", "cancel"] as const) {
    registry.register(
      coreDescriptor(`watch_${operation}`, `${operation} watch`, `${operation}s an owned persistent watch.`, 1),
      async (args, context) => ({
        schemaVersion: 1,
        watch: await watches[operation](String(args.watchId), owner(context))
      }),
      { inputSchema: { watchId: z.string().uuid() } }
    );
  }

  registry.register(
    coreDescriptor("watch_events", "Read watch events", "Reads an ordered cursor page of durable watch events.", 0),
    (args, context) => ({
      schemaVersion: 1,
      ...watches.events(String(args.watchId), owner(context), Number(args.cursor ?? 0), Number(args.limit ?? 100))
    }),
    {
      inputSchema: {
        watchId: z.string().uuid(),
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1_000).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("event_stream", "Read operational events", "Reads an ordered cursor page of durable events owned by this client.", 0),
    (args, context) => ({
      schemaVersion: 1,
      ...events.events(owner(context), Number(args.cursor ?? 0), Number(args.limit ?? 100))
    }),
    {
      inputSchema: {
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1_000).optional()
      }
    }
  );
}

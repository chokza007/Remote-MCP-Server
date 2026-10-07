import { z } from "zod";

import type { LockService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

export function registerLockTools(registry: ToolRegistry, locks: LockService): void {
  registry.register(
    coreDescriptor("lock_acquire", "Acquire resource locks", "Atomically acquires canonically ordered leased resources with fencing tokens.", 1),
    async (args, context) => ({ schemaVersion: 1, lease: await locks.acquire({
      ownerId: owner(context),
      resources: args.resources as string[],
      ...(args.leaseMs === undefined ? {} : { leaseMs: Number(args.leaseMs) })
    }) }),
    {
      inputSchema: {
        resources: z.array(z.string().min(1)).min(1).max(10_000),
        leaseMs: z.number().int().positive().max(86_400_000).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("lock_renew", "Renew resource locks", "Renews an owned resource lease without changing fencing tokens.", 1),
    async (args, context) => ({
      schemaVersion: 1,
      lease: await locks.renew(String(args.leaseId), owner(context), Number(args.leaseMs ?? 30_000))
    }),
    { inputSchema: { leaseId: z.string().uuid(), leaseMs: z.number().int().positive().max(86_400_000).optional() } }
  );

  registry.register(
    coreDescriptor("lock_release", "Release resource locks", "Releases every resource in an owned lease atomically.", 1),
    async (args, context) => ({ schemaVersion: 1, ...(await locks.release(String(args.leaseId), owner(context))) }),
    { inputSchema: { leaseId: z.string().uuid() } }
  );

  registry.register(
    coreDescriptor("lock_list", "List resource locks", "Lists active resource leases owned by this client.", 0),
    (_args, context) => ({ schemaVersion: 1, leases: locks.list(owner(context)) })
  );

  registry.register(
    coreDescriptor("lock_reconcile", "Reconcile expired locks", "Releases only resource leases whose persisted expiration has passed.", 1),
    async () => ({ schemaVersion: 1, ...(await locks.reconcile()) })
  );
}

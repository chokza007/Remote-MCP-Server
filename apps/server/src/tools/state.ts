import { z } from "zod";

import type { OperationalStateService, RuntimeCheckpointService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function namespace(context: ToolExecutionContext, workspaceId: string): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}\u0000${workspaceId}`;
}

const workspaceId = z.string().min(1).max(512);
const checkpointId = z.string().uuid();
const stateKey = z.string().min(1).max(512);

export function registerStateTools(
  registry: ToolRegistry,
  state: OperationalStateService,
  checkpoints: RuntimeCheckpointService
): void {
  registry.register(
    coreDescriptor("operational_state_set", "Set operational state", "Stores namespaced runtime state; project knowledge remains in project files.", 1),
    (args, context) => ({ schemaVersion: 1, record: state.set({
      namespace: namespace(context, String(args.workspaceId)), key: String(args.key), value: args.value
    }) }),
    {
      inputSchema: { workspaceId, key: stateKey, value: z.unknown() },
      auditResult: (output) => {
        const value = output.record as { namespace?: unknown; key?: unknown; updatedAt?: unknown } | null | undefined;
        return { schemaVersion: 1, record: value == null ? null : {
          namespace: value.namespace, key: value.key, updatedAt: value.updatedAt
        } };
      }
    }
  );
  registry.register(
    coreDescriptor("operational_state_get", "Get operational state", "Reads one namespaced runtime state record.", 0),
    (args, context) => ({ schemaVersion: 1, record: state.get(
      namespace(context, String(args.workspaceId)), String(args.key)
    ) }),
    {
      inputSchema: { workspaceId, key: stateKey },
      auditResult: (output) => {
        const value = output.record as { namespace?: unknown; key?: unknown; updatedAt?: unknown } | null | undefined;
        return { schemaVersion: 1, record: value == null ? null : {
          namespace: value.namespace, key: value.key, updatedAt: value.updatedAt
        } };
      }
    }
  );
  registry.register(
    coreDescriptor("operational_state_list", "List operational state", "Lists namespaced runtime state records.", 0),
    (args, context) => ({ schemaVersion: 1, records: state.list(namespace(context, String(args.workspaceId))) }),
    {
      inputSchema: { workspaceId },
      auditResult: (output) => ({ schemaVersion: 1, count: Array.isArray(output.records) ? output.records.length : 0 })
    }
  );
  registry.register(
    coreDescriptor("operational_state_delete", "Delete operational state", "Deletes one namespaced runtime state record.", 1),
    (args, context) => ({ schemaVersion: 1, deleted: state.delete(
      namespace(context, String(args.workspaceId)), String(args.key)
    ) }),
    { inputSchema: { workspaceId, key: stateKey } }
  );

  registry.register(
    coreDescriptor("runtime_checkpoint_save", "Save runtime checkpoint", "Persists resumable execution state, not project status or project memory.", 1),
    (args, context) => ({ schemaVersion: 1, checkpoint: checkpoints.save({
      namespace: namespace(context, String(args.workspaceId)),
      operation: String(args.operation),
      state: args.state,
      ...(args.checkpointId === undefined ? {} : { checkpointId: String(args.checkpointId) }),
      ...(args.verification === undefined ? {} : { verification: args.verification as Record<string, unknown> })
    }) }),
    {
      inputSchema: {
        workspaceId,
        checkpointId: checkpointId.optional(),
        operation: z.string().min(1).max(256),
        state: z.unknown(),
        verification: z.record(z.string(), z.unknown()).optional()
      },
      auditResult: (output) => {
        const value = output.checkpoint as { checkpointId?: unknown; operation?: unknown; state?: unknown } | undefined;
        return { schemaVersion: 1, checkpoint: { checkpointId: value?.checkpointId, operation: value?.operation, state: value?.state } };
      }
    }
  );
  registry.register(
    coreDescriptor("runtime_checkpoint_load", "Load runtime checkpoint", "Loads resumable execution state from one owned workspace.", 0),
    (args, context) => ({ schemaVersion: 1, checkpoint: checkpoints.load(
      String(args.checkpointId), namespace(context, String(args.workspaceId))
    ) }),
    {
      inputSchema: { workspaceId, checkpointId },
      auditResult: (output) => {
        const value = output.checkpoint as { checkpointId?: unknown; operation?: unknown; state?: unknown } | undefined;
        return { schemaVersion: 1, checkpoint: { checkpointId: value?.checkpointId, operation: value?.operation, state: value?.state } };
      }
    }
  );
  registry.register(
    coreDescriptor("runtime_checkpoint_list", "List runtime checkpoints", "Lists owned runtime checkpoint summaries.", 0),
    (args, context) => ({ schemaVersion: 1, checkpoints: checkpoints.list(
      namespace(context, String(args.workspaceId)), Boolean(args.includeCompleted ?? true)
    ) }),
    {
      inputSchema: { workspaceId, includeCompleted: z.boolean().optional() },
      auditResult: (output) => ({
        schemaVersion: 1,
        count: Array.isArray(output.checkpoints) ? output.checkpoints.length : 0
      })
    }
  );
  registry.register(
    coreDescriptor("runtime_checkpoint_complete", "Complete runtime checkpoint", "Marks an owned runtime checkpoint complete with verification evidence.", 1),
    (args, context) => ({ schemaVersion: 1, checkpoint: checkpoints.complete(
      String(args.checkpointId), namespace(context, String(args.workspaceId)),
      (args.verification as Record<string, unknown> | undefined) ?? {}
    ) }),
    {
      inputSchema: { workspaceId, checkpointId, verification: z.record(z.string(), z.unknown()).optional() },
      auditResult: (output) => {
        const value = output.checkpoint as { checkpointId?: unknown; state?: unknown } | undefined;
        return { schemaVersion: 1, checkpoint: { checkpointId: value?.checkpointId, state: value?.state } };
      }
    }
  );
}

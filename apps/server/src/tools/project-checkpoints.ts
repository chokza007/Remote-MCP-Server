import { z } from "zod";

import type { ProjectCheckpointHelper } from "@remote-mcp/adapters";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

export function registerProjectCheckpointTools(registry: ToolRegistry, helper: ProjectCheckpointHelper): void {
  registry.register(
    coreDescriptor("project_checkpoint_discover", "Discover project checkpoint", "Finds project-owned WORK_CHECKPOINT.md references without copying their contents.", 0),
    async (args) => ({ schemaVersion: 1, references: await helper.discover(String(args.root)) }),
    { inputSchema: { root: z.string().min(1) } }
  );
  registry.register(
    coreDescriptor("project_checkpoint_read", "Read project checkpoint", "Reads a project-owned checkpoint directly from its project.", 0),
    async (args) => ({ schemaVersion: 1, checkpoint: await helper.read({
      projectRoot: String(args.root),
      ...(args.path === undefined ? {} : { path: String(args.path) })
    }) }),
    {
      inputSchema: { root: z.string().min(1), path: z.string().min(1).optional() },
      auditResult: (output) => {
        const value = output.checkpoint as { path?: unknown; projectRoot?: unknown; sha256?: unknown; sizeBytes?: unknown } | undefined;
        return { schemaVersion: 1, checkpoint: value === undefined ? null : {
          path: value.path,
          projectRoot: value.projectRoot,
          sha256: value.sha256,
          sizeBytes: value.sizeBytes
        } };
      }
    }
  );
  registry.register(
    coreDescriptor("project_checkpoint_update", "Update project checkpoint", "Atomically updates a project-owned checkpoint and records only its path and hash as an artifact reference.", 2),
    async (args, context) => ({ schemaVersion: 1, checkpoint: await helper.update({
      namespace: owner(context),
      workspaceId: String(args.workspaceId),
      projectRoot: String(args.root),
      content: String(args.content),
      ...(args.path === undefined ? {} : { path: String(args.path) }),
      ...(args.expectedSha256 === undefined ? {} : { expectedSha256: String(args.expectedSha256) })
    }) }),
    {
      inputSchema: {
        workspaceId: z.string().min(1).max(512),
        root: z.string().min(1),
        path: z.string().min(1).optional(),
        content: z.string().max(4 * 1024 * 1024),
        expectedSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional()
      },
      auditResult: (output) => ({ schemaVersion: 1, checkpoint: output.checkpoint })
    }
  );
}

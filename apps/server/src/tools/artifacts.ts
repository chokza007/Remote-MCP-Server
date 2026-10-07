import { z } from "zod";

import type { ArtifactService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

const artifactId = z.string().uuid();
const workspaceId = z.string().min(1).max(512);

export function registerArtifactTools(registry: ToolRegistry, artifacts: ArtifactService): void {
  registry.register(
    coreDescriptor("artifact_register", "Register artifact", "Registers a managed content-addressed artifact or a verified external reference.", 1),
    async (args, context) => ({ schemaVersion: 1, artifact: await artifacts.register({
      namespace: owner(context),
      workspaceId: String(args.workspaceId),
      sourcePath: String(args.path),
      kind: String(args.kind),
      storage: args.storage as "managed" | "reference",
      ...(args.mimeType === undefined ? {} : { mimeType: String(args.mimeType) }),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata as Record<string, unknown> }),
      ...(args.retention === undefined ? {} : { retention: args.retention as { pinned?: boolean; retainUntil?: string } })
    }) }),
    {
      inputSchema: {
        workspaceId,
        path: z.string().min(1),
        kind: z.string().min(1).max(256),
        storage: z.enum(["managed", "reference"]),
        mimeType: z.string().min(1).max(256).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        retention: z.object({ pinned: z.boolean().optional(), retainUntil: z.iso.datetime().optional() }).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("artifact_get", "Get artifact", "Reads owned artifact metadata without reading artifact bytes.", 0),
    (args, context) => ({
      schemaVersion: 1,
      artifact: artifacts.get(String(args.artifactId), owner(context), String(args.workspaceId))
    }),
    { inputSchema: { artifactId, workspaceId } }
  );

  registry.register(
    coreDescriptor("artifact_list", "List artifacts", "Lists artifact metadata in one owned workspace.", 0),
    (args, context) => ({
      schemaVersion: 1,
      artifacts: artifacts.list(owner(context), String(args.workspaceId))
    }),
    { inputSchema: { workspaceId } }
  );

  registry.register(
    coreDescriptor("artifact_verify", "Verify artifact", "Re-hashes an artifact and optionally relocates a missing reference by matching content hash.", 1),
    async (args, context) => ({
      schemaVersion: 1,
      artifact: await artifacts.verify(
        String(args.artifactId), owner(context), String(args.workspaceId),
        (args.candidatePaths as string[] | undefined) ?? []
      )
    }),
    { inputSchema: { artifactId, workspaceId, candidatePaths: z.array(z.string().min(1)).max(1_000).optional() } }
  );

  registry.register(
    coreDescriptor("artifact_relate", "Relate artifacts", "Records an owned parent-child artifact lineage edge.", 1),
    (args, context) => ({ schemaVersion: 1, relation: artifacts.relate({
      namespace: owner(context),
      workspaceId: String(args.workspaceId),
      parentArtifactId: String(args.parentArtifactId),
      childArtifactId: String(args.childArtifactId),
      relation: String(args.relation),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata as Record<string, unknown> })
    }) }),
    {
      inputSchema: {
        workspaceId,
        parentArtifactId: artifactId,
        childArtifactId: artifactId,
        relation: z.string().min(1).max(256),
        metadata: z.record(z.string(), z.unknown()).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("artifact_lineage", "Read artifact lineage", "Reads owned parent and child artifact relations.", 0),
    (args, context) => ({
      schemaVersion: 1,
      ...artifacts.lineage(String(args.artifactId), owner(context), String(args.workspaceId))
    }),
    { inputSchema: { artifactId, workspaceId } }
  );

  registry.register(
    coreDescriptor("artifact_retain", "Set artifact retention", "Pins an artifact or sets its minimum retention timestamp.", 1),
    (args, context) => ({ schemaVersion: 1, artifact: artifacts.retain(
      String(args.artifactId), owner(context), String(args.workspaceId),
      { ...(args.pinned === undefined ? {} : { pinned: Boolean(args.pinned) }), ...(args.retainUntil === undefined ? {} : { retainUntil: String(args.retainUntil) }) }
    ) }),
    { inputSchema: { artifactId, workspaceId, pinned: z.boolean().optional(), retainUntil: z.iso.datetime().optional() } }
  );

  registry.register(
    coreDescriptor("artifact_delete", "Delete artifact", "Deletes an owned artifact record and unshared managed bytes when retention allows it.", 2),
    async (args, context) => ({
      schemaVersion: 1,
      ...(await artifacts.delete(
        String(args.artifactId), owner(context), String(args.workspaceId), { force: Boolean(args.force) }
      ))
    }),
    { inputSchema: { artifactId, workspaceId, force: z.boolean().optional() } }
  );
}

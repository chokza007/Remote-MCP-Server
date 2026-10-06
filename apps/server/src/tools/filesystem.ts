import { z } from "zod";

import { discoverProjectGuidance, type FilesystemAdapter } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const control = { dryRun: z.boolean().optional() };

export function registerFilesystemTools(
  registry: ToolRegistry,
  filesystem: FilesystemAdapter
): void {
  registry.register(
    coreDescriptor("filesystem_apply_patch", "Apply exact text patch", "Atomically applies exact text edits.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.applyPatch({
        path: String(args.path),
        edits: args.edits as Array<{ search: string; replace: string; expectedOccurrences?: number }>,
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        path: z.string().min(1),
        edits: z.array(z.object({
          search: z.string().min(1),
          replace: z.string(),
          expectedOccurrences: z.number().int().nonnegative().optional()
        })).min(1),
        ...control
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_copy", "Copy filesystem entry", "Copies without implicit overwrite.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.copy({
        source: String(args.source),
        destination: String(args.destination),
        recursive: Boolean(args.recursive),
        overwrite: Boolean(args.overwrite),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        source: z.string().min(1),
        destination: z.string().min(1),
        recursive: z.boolean().optional(),
        overwrite: z.boolean().optional(),
        ...control
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_hash", "Hash file", "Computes a streaming cryptographic hash.", 0),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.hash({
        path: String(args.path),
        algorithm: (args.algorithm as "sha256" | "sha512" | undefined) ?? "sha256"
      }))
    }),
    { inputSchema: { path: z.string().min(1), algorithm: z.enum(["sha256", "sha512"]).optional() } }
  );

  registry.register(
    coreDescriptor("filesystem_links", "Inspect link", "Reports link target and allowed-root escape state.", 0),
    async (args) => ({ schemaVersion: 1, ...(await filesystem.links({ path: String(args.path) })) }),
    { inputSchema: { path: z.string().min(1) } }
  );

  registry.register(
    coreDescriptor("filesystem_list", "List directory", "Lists directory entries with bounded recursion.", 0),
    async (args) => ({
      schemaVersion: 1,
      entries: await filesystem.list({
        path: String(args.path),
        recursive: Boolean(args.recursive),
        ...(args.maxDepth === undefined ? {} : { maxDepth: Number(args.maxDepth) })
      })
    }),
    {
      inputSchema: {
        path: z.string().min(1),
        recursive: z.boolean().optional(),
        maxDepth: z.number().int().min(0).max(64).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_move", "Move filesystem entry", "Moves without implicit overwrite.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.move({
        source: String(args.source),
        destination: String(args.destination),
        overwrite: Boolean(args.overwrite),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        source: z.string().min(1),
        destination: z.string().min(1),
        overwrite: z.boolean().optional(),
        ...control
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_permissions", "Inspect permissions", "Reports effective filesystem access.", 0),
    async (args) => ({ schemaVersion: 1, ...(await filesystem.permissions({ path: String(args.path) })) }),
    { inputSchema: { path: z.string().min(1) } }
  );

  registry.register(
    coreDescriptor("filesystem_read_range", "Read file range", "Reads a bounded byte range.", 0),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.readRange({
        path: String(args.path),
        offset: Number(args.offset),
        length: Number(args.length),
        encoding: (args.encoding as "utf8" | "base64" | undefined) ?? "utf8"
      }))
    }),
    {
      inputSchema: {
        path: z.string().min(1),
        offset: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(),
        encoding: z.enum(["utf8", "base64"]).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_recycle", "Recycle filesystem entry", "Moves an entry to recoverable storage.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.recycle({
        path: String(args.path),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    { inputSchema: { path: z.string().min(1), ...control } }
  );

  registry.register(
    coreDescriptor("filesystem_remove", "Permanently remove entry", "Permanently removes an explicitly selected entry.", 3),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.remove({
        path: String(args.path),
        permanent: args.permanent === true,
        recursive: Boolean(args.recursive),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        path: z.string().min(1),
        permanent: z.literal(true),
        recursive: z.boolean().optional(),
        ...control
      }
    }
  );

  registry.register(
    coreDescriptor("filesystem_rename", "Rename filesystem entry", "Renames within the same directory.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.rename({
        path: String(args.path),
        newName: String(args.newName),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    { inputSchema: { path: z.string().min(1), newName: z.string().min(1), ...control } }
  );

  registry.register(
    coreDescriptor("filesystem_stat", "Stat filesystem entry", "Reports filesystem metadata.", 0),
    async (args) => ({ schemaVersion: 1, ...(await filesystem.stat({ path: String(args.path) })) }),
    { inputSchema: { path: z.string().min(1) } }
  );

  registry.register(
    coreDescriptor("filesystem_write", "Write file", "Writes using atomic replacement and explicit overwrite.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await filesystem.write({
        path: String(args.path),
        data: String(args.data),
        encoding: (args.encoding as "utf8" | "base64" | undefined) ?? "utf8",
        overwrite: Boolean(args.overwrite),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        path: z.string().min(1),
        data: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        overwrite: z.boolean().optional(),
        ...control
      }
    }
  );

  registry.register(
    coreDescriptor(
      "project_discover_guidance",
      "Discover project guidance",
      "Finds project-owned guidance references without copying their contents into MCP state.",
      0
    ),
    async (args) => {
      const root = String(args.root);
      const metadata = await filesystem.stat({ path: root });
      if (metadata.kind !== "directory") throw new Error("Project root must be a directory");
      return { schemaVersion: 1, references: await discoverProjectGuidance(root) };
    },
    { inputSchema: { root: z.string().min(1) } }
  );
}

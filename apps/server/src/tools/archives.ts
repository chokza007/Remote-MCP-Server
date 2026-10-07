import { z } from "zod";

import type { ArchiveService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export function registerArchiveTools(registry: ToolRegistry, archives: ArchiveService): void {
  registry.register(
    coreDescriptor("archive_list", "List archive", "Lists validated ZIP entries without extraction.", 0),
    async (args) => ({ schemaVersion: 1, entries: await archives.list(String(args.archive)) }),
    { inputSchema: { archive: z.string().min(1) } }
  );

  registry.register(
    { ...coreDescriptor("archive_create", "Create archive", "Creates a ZIP from explicit source/path pairs.", 2), supportsDryRun: true },
    async (args) => ({
      schemaVersion: 1,
      ...(await archives.create({
        archive: String(args.archive),
        entries: args.entries as Array<{ source: string; path: string }>,
        ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) }),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        archive: z.string().min(1),
        entries: z.array(z.object({ source: z.string().min(1), path: z.string().min(1) })).min(1).max(10_000),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    }
  );

  registry.register(
    { ...coreDescriptor("archive_extract", "Extract archive", "Safely extracts a ZIP after validating every entry and target.", 2), supportsDryRun: true },
    async (args) => ({
      schemaVersion: 1,
      ...(await archives.extract({
        archive: String(args.archive),
        destination: String(args.destination),
        ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) }),
        ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) })
      }))
    }),
    {
      inputSchema: {
        archive: z.string().min(1),
        destination: z.string().min(1),
        overwrite: z.boolean().optional(),
        dryRun: z.boolean().optional()
      }
    }
  );

  registry.register(
    coreDescriptor("archive_verify", "Verify archive", "Validates and decompresses a ZIP within configured safety limits.", 0),
    async (args) => ({ schemaVersion: 1, ...(await archives.verify(String(args.archive))) }),
    { inputSchema: { archive: z.string().min(1) } }
  );
}

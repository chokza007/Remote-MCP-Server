import { z } from "zod";

import type { SearchRequest, SearchService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const searchIdSchema = { searchId: z.string().uuid() };

export function registerSearchTools(registry: ToolRegistry, search: SearchService): void {
  registry.register(
    coreDescriptor("search_cancel", "Cancel search", "Cancels an active durable search.", 1),
    (args) => ({ schemaVersion: 1, ...search.cancel(String(args.searchId)) }),
    { inputSchema: searchIdSchema }
  );

  registry.register(
    coreDescriptor("search_page", "Page search results", "Reads one deterministic page of stored results.", 0),
    (args) => ({
      schemaVersion: 1,
      ...search.page(String(args.searchId), Number(args.cursor ?? 0), Number(args.limit ?? 100))
    }),
    {
      inputSchema: {
        ...searchIdSchema,
        cursor: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1000).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("search_resume", "Resume search", "Restarts a cancelled or failed durable search.", 1),
    async (args) => {
      const searchId = String(args.searchId);
      await search.resume(searchId);
      return { schemaVersion: 1, ...search.status(searchId) };
    },
    { inputSchema: searchIdSchema }
  );

  registry.register(
    coreDescriptor("search_start", "Start search", "Starts a bounded durable filesystem search.", 1),
    async (args) => ({
      schemaVersion: 1,
      ...(await search.start(args as unknown as SearchRequest))
    }),
    {
      inputSchema: {
        roots: z.array(z.string().min(1)).min(1),
        name: z.string().optional(),
        content: z.string().optional(),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        minSize: z.number().int().nonnegative().optional(),
        maxSize: z.number().int().nonnegative().optional(),
        modifiedAfter: z.iso.datetime().optional(),
        modifiedBefore: z.iso.datetime().optional(),
        types: z.array(z.enum(["file", "archive_member"])).optional(),
        include: z.array(z.string().min(1)).optional(),
        exclude: z.array(z.string().min(1)).optional(),
        archives: z.boolean().optional(),
        documents: z.boolean().optional(),
        ocr: z.boolean().optional(),
        maxFiles: z.number().int().positive(),
        maxResults: z.number().int().positive(),
        maxBytes: z.number().int().positive()
      }
    }
  );

  registry.register(
    coreDescriptor("search_status", "Search status", "Reports durable search progress and limits.", 0),
    (args) => ({ schemaVersion: 1, ...search.status(String(args.searchId)) }),
    { inputSchema: searchIdSchema }
  );
}

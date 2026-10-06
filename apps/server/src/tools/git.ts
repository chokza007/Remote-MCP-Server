import { z } from "zod";

import type { GitAdapter, GitControl, GitDiffOptions, GitRemoteOptions } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const rootSchema = z.string().min(1);
const outputLimitSchema = z.number().int().positive().max(64 * 1024 * 1024).optional();
const credentialReferenceSchema = z.string().min(1).max(256).optional();

function control(args: Record<string, unknown>): GitControl {
  return {
    ...(args.dryRun === undefined ? {} : { dryRun: Boolean(args.dryRun) }),
    ...(args.maxOutputBytes === undefined ? {} : { maxOutputBytes: Number(args.maxOutputBytes) }),
    ...(args.credentialReference === undefined ? {} : { credentialReference: String(args.credentialReference) })
  };
}

function descriptor(
  name: string,
  title: string,
  description: string,
  riskTier: 0 | 1 | 2 | 3,
  supportsDryRun = false
) {
  return {
    ...coreDescriptor(name, title, description, riskTier),
    supportsDryRun,
    cancellable: true
  };
}

export function registerGitTools(registry: ToolRegistry, git: GitAdapter): void {
  registry.register(
    descriptor("git_discover", "Discover Git repository", "Discovers a repository without mutating it.", 0),
    async (args) => ({ schemaVersion: 1, ...(await git.discover(String(args.startPath), control(args))) }),
    { inputSchema: { startPath: z.string().min(1), maxOutputBytes: outputLimitSchema } }
  );

  registry.register(
    descriptor("git_status", "Git status", "Reads porcelain Git status from an explicit repository root.", 0),
    async (args) => ({ schemaVersion: 1, ...(await git.status(String(args.root), control(args))) }),
    { inputSchema: { root: rootSchema, maxOutputBytes: outputLimitSchema } }
  );

  registry.register(
    descriptor("git_diff", "Git diff", "Reads a bounded Git diff from an explicit repository root.", 0),
    async (args) => {
      const options: GitDiffOptions = {
        ...control(args),
        ...(args.staged === undefined ? {} : { staged: Boolean(args.staged) }),
        ...(args.paths === undefined ? {} : { paths: args.paths as string[] })
      };
      return { schemaVersion: 1, ...(await git.diff(String(args.root), options)) };
    },
    {
      inputSchema: {
        root: rootSchema,
        staged: z.boolean().optional(),
        paths: z.array(z.string().min(1)).max(10_000).optional(),
        maxOutputBytes: outputLimitSchema
      }
    }
  );

  registry.register(
    descriptor("git_log", "Git log", "Reads bounded Git history from an explicit repository root.", 0),
    async (args) => ({
      schemaVersion: 1,
      entries: await git.log(String(args.root), {
        ...control(args),
        ...(args.limit === undefined ? {} : { limit: Number(args.limit) })
      })
    }),
    { inputSchema: { root: rootSchema, limit: z.number().int().min(1).max(500).optional(), maxOutputBytes: outputLimitSchema } }
  );

  registry.register(
    descriptor("git_branches", "Git branches", "Reads local branches and detached-HEAD state.", 0),
    async (args) => ({ schemaVersion: 1, ...(await git.branches(String(args.root), control(args))) }),
    { inputSchema: { root: rootSchema, maxOutputBytes: outputLimitSchema } }
  );

  registry.register(
    descriptor("git_conflicts", "Git conflicts", "Lists unresolved merge conflicts.", 0),
    async (args) => ({ schemaVersion: 1, root: String(args.root), conflicts: await git.conflicts(String(args.root), control(args)) }),
    { inputSchema: { root: rootSchema, maxOutputBytes: outputLimitSchema } }
  );

  registry.register(
    descriptor("git_add", "Git add", "Stages only explicit literal repository-relative paths.", 2, true),
    async (args) => ({ schemaVersion: 1, ...(await git.add(String(args.root), args.paths as string[], control(args))) }),
    {
      inputSchema: {
        root: rootSchema,
        paths: z.array(z.string().min(1)).min(1).max(10_000),
        dryRun: z.boolean().optional(),
        maxOutputBytes: outputLimitSchema
      }
    }
  );

  registry.register(
    descriptor("git_commit", "Git commit", "Commits the existing index with an explicit message.", 2, true),
    async (args) => ({ schemaVersion: 1, ...(await git.commit(String(args.root), String(args.message), control(args))) }),
    {
      inputSchema: {
        root: rootSchema,
        message: z.string().min(1).max(64 * 1024),
        dryRun: z.boolean().optional(),
        maxOutputBytes: outputLimitSchema
      }
    }
  );

  for (const operation of ["fetch", "pull", "push"] as const) {
    const riskTier = operation === "fetch" ? 1 : operation === "push" ? 3 : 2;
    registry.register(
      descriptor(`git_${operation}`, `Git ${operation}`, `Runs non-interactive Git ${operation} with an optional credential reference.`, riskTier, true),
      async (args) => {
        const options: GitRemoteOptions = {
          ...control(args),
          ...(args.remote === undefined ? {} : { remote: String(args.remote) }),
          ...(args.branch === undefined ? {} : { branch: String(args.branch) })
        };
        return { schemaVersion: 1, ...(await git[operation](String(args.root), options)) };
      },
      {
        inputSchema: {
          root: rootSchema,
          remote: z.string().min(1).max(256).optional(),
          branch: z.string().min(1).max(1024).optional(),
          dryRun: z.boolean().optional(),
          maxOutputBytes: outputLimitSchema,
          credentialReference: credentialReferenceSchema
        }
      }
    );
  }
}

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { GitAdapterError } from "./git-errors.js";

export interface RepositoryDiscoveryResult {
  readonly root: string;
  readonly gitDirectory: string;
  readonly bare: boolean;
}

export type RepositoryDiscoveryRunner = (
  cwd: string,
  argumentsValue: readonly string[],
  operation: string,
  signal?: AbortSignal
) => Promise<string>;

async function comparable(path: string): Promise<string> {
  const canonical = await realpath(resolve(path)).catch(() => resolve(path));
  const normalized = canonical.replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function discoverGitRepository(
  startPath: string,
  run: RepositoryDiscoveryRunner,
  signal?: AbortSignal
): Promise<RepositoryDiscoveryResult> {
  let root: string;
  try {
    root = resolve((await run(startPath, ["rev-parse", "--show-toplevel"], "discover", signal)).trim());
  } catch (error) {
    if (error instanceof GitAdapterError) {
      throw new GitAdapterError({
        code: "NOT_A_REPOSITORY",
        operation: "discover",
        message: `No Git repository contains the requested path: ${startPath}`,
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        ...(error.stderr === undefined ? {} : { stderr: error.stderr })
      });
    }
    throw error;
  }
  const gitDirectoryRaw = (await run(root, ["rev-parse", "--absolute-git-dir"], "discover", signal)).trim();
  const bare = (await run(root, ["rev-parse", "--is-bare-repository"], "discover", signal)).trim() === "true";
  return { root, gitDirectory: resolve(gitDirectoryRaw), bare };
}

export async function requireExactRepositoryRoot(
  requestedRoot: string,
  run: RepositoryDiscoveryRunner,
  signal?: AbortSignal
): Promise<RepositoryDiscoveryResult> {
  const discovered = await discoverGitRepository(requestedRoot, run, signal);
  if ((await comparable(discovered.root)) !== (await comparable(requestedRoot))) {
    throw new GitAdapterError({
      code: "ROOT_MISMATCH",
      operation: "validate-root",
      message: `Git operations require the exact repository root. Requested ${resolve(requestedRoot)}; discovered ${discovered.root}`
    });
  }
  return discovered;
}

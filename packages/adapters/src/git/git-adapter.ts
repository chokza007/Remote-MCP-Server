import { spawn } from "node:child_process";
import { isAbsolute, normalize, resolve } from "node:path";

import { GitAdapterError, gitAbortError, redactGitOutput } from "./git-errors.js";
import {
  discoverGitRepository,
  requireExactRepositoryRoot,
  type RepositoryDiscoveryResult
} from "./repository-discovery.js";

export interface GitControl {
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  readonly credentialReference?: string;
}

export interface GitMutationResult {
  readonly operation: string;
  readonly root: string;
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly output: string;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: string;
  readonly worktree: string;
}

export interface GitStatusResult {
  readonly root: string;
  readonly entries: readonly GitStatusEntry[];
}

export interface GitDiffOptions extends GitControl {
  readonly staged?: boolean;
  readonly paths?: readonly string[];
}

export interface GitDiffResult {
  readonly root: string;
  readonly staged: boolean;
  readonly files: readonly string[];
  readonly patch: string;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export interface GitLogOptions extends GitControl {
  readonly limit?: number;
}

export interface GitBranch {
  readonly name: string;
  readonly hash: string;
  readonly current: boolean;
}

export interface GitBranchesResult {
  readonly root: string;
  readonly current: string | null;
  readonly detached: boolean;
  readonly branches: readonly GitBranch[];
}

export interface GitRemoteOptions extends GitControl {
  readonly remote?: string;
  readonly branch?: string;
}

export interface GitConflict {
  readonly path: string;
  readonly kind: string;
}

export interface GitCredentialProvider {
  resolve(reference: string): Promise<Readonly<Record<string, string>>>;
}

export interface GitAdapterOptions {
  readonly gitExecutable?: string;
  readonly defaultMaxOutputBytes?: number;
  readonly credentialProvider?: GitCredentialProvider;
}

export interface GitAdapter {
  discover(startPath: string, control?: GitControl): Promise<RepositoryDiscoveryResult>;
  status(root: string, control?: GitControl): Promise<GitStatusResult>;
  diff(root: string, options?: GitDiffOptions): Promise<GitDiffResult>;
  log(root: string, options?: GitLogOptions): Promise<readonly GitLogEntry[]>;
  branches(root: string, control?: GitControl): Promise<GitBranchesResult>;
  add(root: string, paths: readonly string[], control?: GitControl): Promise<GitMutationResult>;
  commit(root: string, message: string, control?: GitControl): Promise<GitMutationResult>;
  fetch(root: string, options?: GitRemoteOptions): Promise<GitMutationResult>;
  pull(root: string, options?: GitRemoteOptions): Promise<GitMutationResult>;
  push(root: string, options?: GitRemoteOptions): Promise<GitMutationResult>;
  conflicts(root: string, control?: GitControl): Promise<readonly GitConflict[]>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function safePathspec(path: string): string {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new GitAdapterError({ code: "UNSAFE_PATHSPEC", operation: "pathspec", message: `Unsafe Git pathspec: ${path}` });
  }
  const value = normalize(path).replaceAll("\\", "/");
  if (value === ".." || value.startsWith("../") || value.includes("/../")) {
    throw new GitAdapterError({ code: "UNSAFE_PATHSPEC", operation: "pathspec", message: `Git pathspec escapes the repository: ${path}` });
  }
  return `:(literal)${value}`;
}

function safeRef(value: string, label: string): string {
  if (!value || value.startsWith("-") || /[\0-\x20~^:?*[\\]/u.test(value) || value.includes("..")) {
    throw new GitAdapterError({ code: "INVALID_ARGUMENT", operation: label, message: `Invalid Git ${label}: ${value}` });
  }
  return value;
}

function parseStatus(output: string): GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const path = record.slice(3);
    if (x === "R" || x === "C") {
      const originalPath = records[index + 1];
      index += 1;
      entries.push({ path, ...(originalPath ? { originalPath } : {}), index: x, worktree: y });
    } else {
      entries.push({ path, index: x, worktree: y });
    }
  }
  return entries;
}

function mutation(operation: string, root: string, dryRun: boolean, changed: boolean, output: string): GitMutationResult {
  return { operation, root, dryRun, changed, output: redactGitOutput(output).trim() };
}

export class ProcessGitAdapter implements GitAdapter {
  readonly #gitExecutable: string;
  readonly #defaultMaxOutputBytes: number;
  readonly #credentialProvider: GitCredentialProvider | undefined;

  public constructor(options: GitAdapterOptions = {}) {
    this.#gitExecutable = options.gitExecutable ?? "git";
    this.#defaultMaxOutputBytes = options.defaultMaxOutputBytes ?? 8 * 1024 * 1024;
    this.#credentialProvider = options.credentialProvider;
  }

  public discover(startPath: string, control: GitControl = {}): Promise<RepositoryDiscoveryResult> {
    return discoverGitRepository(resolve(startPath), this.discoveryRunner(control), control.signal);
  }

  public async status(root: string, control: GitControl = {}): Promise<GitStatusResult> {
    const repository = await this.repository(root, control);
    const result = await this.run(repository.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "status", control);
    return { root: repository.root, entries: parseStatus(result.stdout) };
  }

  public async diff(root: string, options: GitDiffOptions = {}): Promise<GitDiffResult> {
    const repository = await this.repository(root, options);
    const paths = (options.paths ?? []).map(safePathspec);
    const common = [...(options.staged ? ["--cached"] : []), "--no-ext-diff", "--no-color"];
    const pathArguments = paths.length === 0 ? [] : ["--", ...paths];
    const names = await this.run(repository.root, ["diff", ...common, "--name-only", "-z", ...pathArguments], "diff", options);
    const patch = await this.run(repository.root, ["diff", ...common, ...pathArguments], "diff", options);
    return {
      root: repository.root,
      staged: options.staged ?? false,
      files: names.stdout.split("\0").filter(Boolean),
      patch: patch.stdout
    };
  }

  public async log(root: string, options: GitLogOptions = {}): Promise<readonly GitLogEntry[]> {
    const repository = await this.repository(root, options);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const result = await this.run(
      repository.root,
      ["log", `--max-count=${limit}`, "-z", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s"],
      "log",
      options
    );
    return result.stdout.split("\0").filter(Boolean).map((record) => {
      const [hash = "", authorName = "", authorEmail = "", authoredAt = "", subject = ""] = record.split("\x1f");
      return { hash, authorName, authorEmail, authoredAt, subject };
    });
  }

  public async branches(root: string, control: GitControl = {}): Promise<GitBranchesResult> {
    const repository = await this.repository(root, control);
    const currentResult = await this.run(
      repository.root,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "branches",
      control,
      true
    );
    const current = currentResult.stdout.trim() || null;
    const result = await this.run(
      repository.root,
      ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00", "refs/heads"],
      "branches",
      control
    );
    const values = result.stdout.split("\0");
    const branches: GitBranch[] = [];
    for (let index = 0; index + 2 < values.length; index += 3) {
      const name = values[index]?.replace(/^\n/u, "") ?? "";
      if (!name) continue;
      branches.push({ name, hash: values[index + 1] ?? "", current: (values[index + 2] ?? "").trim() === "*" });
    }
    return { root: repository.root, current, detached: current === null, branches };
  }

  public async add(root: string, paths: readonly string[], control: GitControl = {}): Promise<GitMutationResult> {
    if (paths.length === 0) throw new GitAdapterError({ code: "INVALID_ARGUMENT", operation: "add", message: "Git add requires at least one explicit path" });
    const literalPaths = paths.map(safePathspec);
    const repository = await this.repository(root, control);
    const argumentsValue = ["add", ...(control.dryRun ? ["--dry-run"] : []), "--", ...literalPaths];
    const result = await this.run(repository.root, argumentsValue, "add", control);
    return mutation("add", repository.root, control.dryRun ?? false, !(control.dryRun ?? false), result.stdout || result.stderr);
  }

  public async commit(root: string, message: string, control: GitControl = {}): Promise<GitMutationResult> {
    if (!message.trim() || message.includes("\0")) throw new GitAdapterError({ code: "INVALID_ARGUMENT", operation: "commit", message: "Commit message must not be empty" });
    const repository = await this.repository(root, control);
    const result = await this.run(
      repository.root,
      ["commit", ...(control.dryRun ? ["--dry-run"] : []), "-m", message],
      "commit",
      control
    );
    return mutation("commit", repository.root, control.dryRun ?? false, !(control.dryRun ?? false), result.stdout || result.stderr);
  }

  public async fetch(root: string, options: GitRemoteOptions = {}): Promise<GitMutationResult> {
    const repository = await this.repository(root, options);
    const remote = safeRef(options.remote ?? "origin", "remote");
    const result = await this.run(repository.root, ["fetch", ...(options.dryRun ? ["--dry-run"] : []), "--", remote], "fetch", options);
    return mutation("fetch", repository.root, options.dryRun ?? false, !(options.dryRun ?? false), result.stdout || result.stderr);
  }

  public async pull(root: string, options: GitRemoteOptions = {}): Promise<GitMutationResult> {
    const repository = await this.repository(root, options);
    const remote = safeRef(options.remote ?? "origin", "remote");
    const branch = options.branch === undefined ? undefined : safeRef(options.branch, "branch");
    if (options.dryRun) {
      return mutation("pull", repository.root, true, false, `Would run non-interactive fast-forward pull from ${remote}${branch ? ` ${branch}` : ""}`);
    }
    const result = await this.run(repository.root, ["pull", "--ff-only", "--", remote, ...(branch ? [branch] : [])], "pull", options);
    return mutation("pull", repository.root, false, true, result.stdout || result.stderr);
  }

  public async push(root: string, options: GitRemoteOptions = {}): Promise<GitMutationResult> {
    const repository = await this.repository(root, options);
    const remote = safeRef(options.remote ?? "origin", "remote");
    const branch = options.branch === undefined ? undefined : safeRef(options.branch, "branch");
    const result = await this.run(
      repository.root,
      ["push", ...(options.dryRun ? ["--dry-run"] : []), "--", remote, ...(branch ? [branch] : [])],
      "push",
      options
    );
    return mutation("push", repository.root, options.dryRun ?? false, !(options.dryRun ?? false), result.stdout || result.stderr);
  }

  public async conflicts(root: string, control: GitControl = {}): Promise<readonly GitConflict[]> {
    const status = await this.status(root, control);
    return status.entries
      .filter((entry) => entry.index === "U" || entry.worktree === "U" || ["AA", "DD"].includes(`${entry.index}${entry.worktree}`))
      .map((entry) => ({ path: entry.path, kind: `${entry.index}${entry.worktree}` }));
  }

  private discoveryRunner(control: GitControl) {
    return async (cwd: string, argumentsValue: readonly string[], operation: string, signal?: AbortSignal): Promise<string> => {
      const result = await this.run(cwd, argumentsValue, operation, {
        ...(control.credentialReference === undefined ? {} : { credentialReference: control.credentialReference }),
        ...(signal === undefined ? {} : { signal })
      });
      return result.stdout;
    };
  }

  private repository(root: string, control: GitControl): Promise<RepositoryDiscoveryResult> {
    return requireExactRepositoryRoot(resolve(root), this.discoveryRunner(control), control.signal);
  }

  private async run(
    cwd: string,
    argumentsValue: readonly string[],
    operation: string,
    control: GitControl,
    allowFailure = false
  ): Promise<CommandResult> {
    if (control.signal?.aborted) throw gitAbortError(operation);
    const maxOutputBytes = control.maxOutputBytes ?? this.#defaultMaxOutputBytes;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new GitAdapterError({ code: "INVALID_ARGUMENT", operation, message: "Git output limit must be a positive integer" });
    }
    let credentialEnvironment: Readonly<Record<string, string>> = {};
    if (control.credentialReference !== undefined) {
      if (!this.#credentialProvider) {
        throw new GitAdapterError({ code: "INVALID_ARGUMENT", operation, message: "No Git credential provider is configured" });
      }
      credentialEnvironment = await this.#credentialProvider.resolve(control.credentialReference);
    }

    return new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn(this.#gitExecutable, ["-C", cwd, ...argumentsValue], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...credentialEnvironment,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: ""
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;

      const finishError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (): void => {
        child.kill();
        finishError(gitAbortError(operation));
      };
      const cleanup = (): void => control.signal?.removeEventListener("abort", abort);
      const capture = (target: Buffer[], chunk: Buffer): void => {
        size += chunk.length;
        if (size > maxOutputBytes) {
          child.kill();
          finishError(new GitAdapterError({ code: "OUTPUT_LIMIT", operation, message: `Git output exceeded ${maxOutputBytes} bytes` }));
          return;
        }
        target.push(chunk);
      };

      control.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => finishError(new GitAdapterError({ code: "COMMAND_FAILED", operation, message: error.message })));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdoutText = redactGitOutput(Buffer.concat(stdout).toString("utf8"));
        const stderrText = redactGitOutput(Buffer.concat(stderr).toString("utf8"));
        if (code !== 0 && !allowFailure) {
          reject(new GitAdapterError({
            code: "COMMAND_FAILED",
            operation,
            message: stderrText || `Git command failed with exit code ${code ?? "unknown"}`,
            exitCode: code,
            stderr: stderrText
          }));
          return;
        }
        resolvePromise({ stdout: stdoutText, stderr: stderrText });
      });
    });
  }
}

export function createGitAdapter(options: GitAdapterOptions = {}): GitAdapter {
  return new ProcessGitAdapter(options);
}

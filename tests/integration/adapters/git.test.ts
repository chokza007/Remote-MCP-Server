import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGitAdapter, redactGitOutput, type GitAdapter } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../../apps/server/src/http-server.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  });
  return result.stdout;
}

async function initRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Remote MCP Fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await git(root, "add", "--", "base.txt");
  await git(root, "commit", "-m", "initial");
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("Git adapter", () => {
  let temporaryRoot: string;
  let repository: string;
  let adapter: GitAdapter;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "remote-mcp-git-"));
    repository = join(temporaryRoot, "repository");
    await initRepository(repository);
    repository = await realpath(repository);
    adapter = createGitAdapter();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test("discovers a repository from a nested Unicode path but requires the exact root for operations", async () => {
    const nested = join(repository, "ไทย", "nested");
    await mkdir(nested, { recursive: true });

    await expect(adapter.discover(nested)).resolves.toMatchObject({ root: repository });
    await expect(adapter.status(nested)).rejects.toMatchObject({ code: "ROOT_MISMATCH" });
  });

  test("parses staged, unstaged, untracked, and Unicode paths without touching unrelated work", async () => {
    await writeFile(join(repository, "base.txt"), "unstaged\n", "utf8");
    await writeFile(join(repository, "staged.txt"), "staged\n", "utf8");
    await writeFile(join(repository, "ไม่เกี่ยว.txt"), "untracked\n", "utf8");
    await git(repository, "add", "--", "staged.txt");

    const status = await adapter.status(repository);
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "base.txt", index: " ", worktree: "M" }),
        expect.objectContaining({ path: "staged.txt", index: "A", worktree: " " }),
        expect.objectContaining({ path: "ไม่เกี่ยว.txt", index: "?", worktree: "?" })
      ])
    );

    await writeFile(join(repository, "wanted.txt"), "wanted\n", "utf8");
    const preview = await adapter.add(repository, ["wanted.txt"], { dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, changed: false });
    expect((await adapter.status(repository)).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "wanted.txt", index: "?" })])
    );

    await adapter.add(repository, ["wanted.txt"]);
    const after = await adapter.status(repository);
    expect(after.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "wanted.txt", index: "A" }),
        expect.objectContaining({ path: "ไม่เกี่ยว.txt", index: "?" })
      ])
    );
  });

  test("commits only the staged paths and reports branches, log, diff, and detached HEAD", async () => {
    await writeFile(join(repository, "commit-me.txt"), "commit me\n", "utf8");
    await writeFile(join(repository, "leave-me.txt"), "leave me\n", "utf8");
    await adapter.add(repository, ["commit-me.txt"]);

    await expect(adapter.commit(repository, "fixture commit", { dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      changed: false
    });
    await adapter.commit(repository, "fixture commit");

    expect((await adapter.log(repository, { limit: 2 }))[0]).toMatchObject({ subject: "fixture commit" });
    expect((await adapter.diff(repository, { staged: true })).files).toHaveLength(0);
    expect((await adapter.status(repository)).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "leave-me.txt", index: "?" })])
    );
    expect(await adapter.branches(repository)).toMatchObject({ current: "main", detached: false });

    await git(repository, "checkout", "--detach", "HEAD");
    expect(await adapter.branches(repository)).toMatchObject({ current: null, detached: true });
  });

  test("reports merge conflicts", async () => {
    await git(repository, "checkout", "-b", "side");
    await writeFile(join(repository, "base.txt"), "side\n", "utf8");
    await git(repository, "commit", "-am", "side");
    await git(repository, "checkout", "main");
    await writeFile(join(repository, "base.txt"), "main\n", "utf8");
    await git(repository, "commit", "-am", "main");
    await execFileAsync("git", ["-C", repository, "merge", "side"], { encoding: "utf8" }).catch(() => undefined);

    expect(await adapter.conflicts(repository)).toEqual([
      expect.objectContaining({ path: "base.txt", kind: expect.any(String) })
    ]);
  });

  test("uses local bare remotes non-interactively and honors push dry-run", async () => {
    const remote = join(temporaryRoot, "remote.git");
    await execFileAsync("git", ["init", "--bare", remote]);
    await git(repository, "remote", "add", "origin", remote);

    await expect(adapter.push(repository, { remote: "origin", branch: "main", dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      changed: false
    });
    await expect(git(remote, "rev-parse", "refs/heads/main")).rejects.toThrow();

    await adapter.push(repository, { remote: "origin", branch: "main" });
    await expect(git(remote, "rev-parse", "refs/heads/main")).resolves.toMatch(/[0-9a-f]{40}/);
    await expect(adapter.fetch(repository, { remote: "origin", dryRun: true })).resolves.toMatchObject({ dryRun: true });
    await expect(adapter.pull(repository, { remote: "origin", branch: "main", dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      changed: false
    });
  });

  test("rejects unsafe pathspecs, supports cancellation, limits output, and redacts remote credentials", async () => {
    await expect(adapter.add(repository, [join(temporaryRoot, "outside.txt")])).rejects.toMatchObject({
      code: "UNSAFE_PATHSPEC"
    });
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.status(repository, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

    await writeFile(join(repository, "large.txt"), "x".repeat(16_384), "utf8");
    await git(repository, "add", "--", "large.txt");
    await expect(adapter.diff(repository, { staged: true, maxOutputBytes: 64 })).rejects.toMatchObject({
      code: "OUTPUT_LIMIT"
    });

    expect(redactGitOutput("https://user:REMOTE_TOKEN_CANARY@example.invalid/private.git")).toBe(
      "https://[REDACTED]@example.invalid/private.git"
    );
    await git(repository, "remote", "add", "secret", "https://user:REMOTE_TOKEN_CANARY@127.0.0.1:9/private.git");
    await expect(adapter.fetch(repository, { remote: "secret" })).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error);
      return !serialized.includes("REMOTE_TOKEN_CANARY") && serialized.includes("127.0.0.1");
    });
  });
});

describe("Git MCP authorization", () => {
  test("denies restricted access and automatically accepts a persistent Full Access grant", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "remote-mcp-git-policy-"));
    const repository = join(temporaryRoot, "repository");
    await initRepository(repository);
    const canonicalRepository = await realpath(repository);
    const database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    const handle = await createHttpServer({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x45),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x45)
      },
      host: "127.0.0.1",
      port: 0,
      git: createGitAdapter()
    });
    const client = new Client({ name: "git-client", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(handle.url, {
          requestInit: {
            headers: {
              authorization: `Bearer ${handle.localDevelopmentToken}`,
              "x-remote-mcp-principal": "git-principal",
              "x-remote-mcp-client": "git-client"
            }
          }
        })
      );

      const denied = await client.callTool({ name: "git_status", arguments: { root: canonicalRepository } });
      expect(denied.isError).toBe(true);
      const enrollment = structured(
        await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } })
      );
      handle.grantPending(String(enrollment.requestId), "fixture-owner");
      expect(structured(await client.callTool({ name: "git_status", arguments: { root: canonicalRepository } }))).toMatchObject({
        schemaVersion: 1,
        root: canonicalRepository,
        entries: []
      });
    } finally {
      await client.close();
      await handle.close();
      database.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

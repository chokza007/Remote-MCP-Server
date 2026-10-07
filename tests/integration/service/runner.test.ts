import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error(`Timed out waiting for runner evidence: ${path}`);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows service runner", () => {
  test.skipIf(process.platform !== "win32")(
    "launches the server with ProjectRoot as its working directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "remote-mcp-runner-"));
      roots.push(root);
      const project = join(root, "checkout");
      const data = join(root, "data");
      const evidence = join(root, "cwd.txt");
      const fakeNode = join(root, "fake-node.cmd");
      await Promise.all([mkdir(project), mkdir(data)]);
      await writeFile(
        fakeNode,
        "@echo off\r\ncd > \"%REMOTE_MCP_TEST_CWD_FILE%\"\r\nexit /b 0\r\n",
        "utf8"
      );

      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("scripts/service/runner.ps1"),
          "-ProjectRoot",
          project,
          "-DataRoot",
          data,
          "-NodePath",
          fakeNode
        ],
        {
          cwd: process.env.SystemRoot ?? "C:\\Windows",
          env: { ...process.env, REMOTE_MCP_TEST_CWD_FILE: evidence },
          windowsHide: true,
          stdio: "ignore"
        }
      );
      children.push(child);

      const actual = (await waitForFile(evidence)).trim();
      expect((await realpath(actual)).toLowerCase()).toBe((await realpath(project)).toLowerCase());
    },
    10_000
  );
});

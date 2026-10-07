import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
const children: ChildProcess[] = [];
const execFileAsync = promisify(execFile);

interface AclRule {
  readonly sid: string;
  readonly inherited: boolean;
}

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

async function aclRules(path: string): Promise<AclRule[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$path = $env:REMOTE_MCP_TEST_ACL_PATH; " +
        "$acl = if ([System.IO.Directory]::Exists($path)) { " +
        "[System.IO.Directory]::GetAccessControl($path) } else { " +
        "[System.IO.File]::GetAccessControl($path) }; " +
        "@($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | " +
        "ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; " +
        "inherited = $_.IsInherited } }) | ConvertTo-Json -Compress"
    ],
    { env: { ...process.env, REMOTE_MCP_TEST_ACL_PATH: path }, windowsHide: true }
  );
  return JSON.parse(stdout) as AclRule[];
}

async function restoreFixtureAccess(path: string): Promise<void> {
  await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
        "& icacls.exe $env:REMOTE_MCP_TEST_ACL_PATH /grant:r \"*$($sid):F\" /t /c /q | Out-Null"
    ],
    { env: { ...process.env, REMOTE_MCP_TEST_ACL_PATH: path }, windowsHide: true }
  ).catch(() => undefined);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  await Promise.all(roots.splice(0).map(async (root) => {
    await restoreFixtureAccess(root);
    await rm(root, { recursive: true, force: true });
  }));
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

  test.skipIf(process.platform !== "win32")(
    "protects service data with SID-safe explicit ACLs",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "remote-mcp-acl-"));
      roots.push(root);
      const data = join(root, "data");
      const secret = join(data, "owner-token.txt");
      await mkdir(data);
      await writeFile(secret, "fixture-secret", "utf8");
      const { stdout: currentSidText } = await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
        ],
        { windowsHide: true }
      );
      const currentSid = currentSidText.trim();

      await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("scripts/service/protect-data.ps1"),
          "-DataRoot",
          data,
          "-SecretPath",
          secret
        ],
        { windowsHide: true }
      );

      const directoryRules = await aclRules(data);
      const secretRules = await aclRules(secret);
      const allowed = new Set(["S-1-5-18", "S-1-5-32-544", currentSid]);
      expect(directoryRules.every((rule) => !rule.inherited && allowed.has(rule.sid))).toBe(true);
      expect(secretRules.every((rule) => !rule.inherited && allowed.has(rule.sid))).toBe(true);
      expect(new Set(directoryRules.map((rule) => rule.sid))).toEqual(allowed);
      expect(new Set(secretRules.map((rule) => rule.sid))).toEqual(allowed);
    },
    10_000
  );
});

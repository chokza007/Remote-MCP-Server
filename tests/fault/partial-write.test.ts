import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

function runScript(script: string, args: readonly string[]) {
  return spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", resolve(script), ...args
  ], { encoding: "utf8", windowsHide: true });
}

describe("backup and partial-write recovery", () => {
  let root = "";
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("refuses a tampered backup and leaves the live data unchanged", async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-backup-"));
    const dataRoot = join(root, "data");
    const backups = join(root, "backups");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataRoot));
    await writeFile(join(dataRoot, "operational.db"), "database-v1", "utf8");
    await writeFile(join(dataRoot, "owner-token.txt"), "secret-v1", "utf8");

    const backup = runScript("scripts/operations/backup.ps1", [
      "-DataRoot", dataRoot, "-DestinationRoot", backups, "-Force"
    ]);
    expect(backup.status, backup.stderr).toBe(0);
    const backupName = (await readdir(backups)).find((name) => name.startsWith("backup-"));
    expect(backupName).toBeDefined();
    const backupRoot = join(backups, backupName!);
    await writeFile(join(backupRoot, "files", "operational.db"), "tampered", "utf8");
    await writeFile(join(dataRoot, "operational.db"), "live-newer", "utf8");

    const restore = runScript("scripts/operations/restore.ps1", [
      "-BackupRoot", backupRoot, "-DataRoot", dataRoot, "-Force"
    ]);
    expect(restore.status).not.toBe(0);
    expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/hash|integrity|tamper/i);
    expect(await readFile(join(dataRoot, "operational.db"), "utf8")).toBe("live-newer");
  });

  test("restores a verified backup as one complete data-root replacement", async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-restore-"));
    const dataRoot = join(root, "data");
    const backups = join(root, "backups");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataRoot));
    await writeFile(join(dataRoot, "operational.db"), "database-v1", "utf8");
    await writeFile(join(dataRoot, "owner-token.txt"), "secret-v1", "utf8");
    const backup = runScript("scripts/operations/backup.ps1", [
      "-DataRoot", dataRoot, "-DestinationRoot", backups, "-Force"
    ]);
    expect(backup.status, backup.stderr).toBe(0);
    const backupName = (await readdir(backups)).find((name) => name.startsWith("backup-"))!;
    await writeFile(join(dataRoot, "operational.db"), "database-v2", "utf8");
    await writeFile(join(dataRoot, "untracked.txt"), "must-disappear", "utf8");

    const restore = runScript("scripts/operations/restore.ps1", [
      "-BackupRoot", join(backups, backupName), "-DataRoot", dataRoot, "-Force"
    ]);
    expect(restore.status, restore.stderr).toBe(0);
    expect(await readFile(join(dataRoot, "operational.db"), "utf8")).toBe("database-v1");
    expect(await readFile(join(dataRoot, "owner-token.txt"), "utf8")).toBe("secret-v1");
    await expect(readFile(join(dataRoot, "untracked.txt"), "utf8")).rejects.toThrow();
  });
});

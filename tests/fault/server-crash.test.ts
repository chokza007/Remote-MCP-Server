import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createEmergencyStopService } from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

describe("server crash recovery", () => {
  let root = "";
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("preserves emergency stop state across an abrupt server database reopen", async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-server-crash-"));
    const filename = join(root, "operational.db");
    const first = openDatabase({ filename });
    migrateDatabase(first);
    createEmergencyStopService({ database: first }).activate({ kind: "owner", id: "owner" }, "incident");
    first.close();

    const restarted = openDatabase({ filename });
    expect(createEmergencyStopService({ database: restarted }).status()).toMatchObject({
      active: true,
      reason: "incident"
    });
    restarted.close();
  });

  test("owner emergency-stop script persists the stop before service termination", async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-emergency-stop-"));
    const filename = join(root, "operational.db");
    const database = openDatabase({ filename });
    migrateDatabase(database);
    database.close();

    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve("scripts/operations/emergency-stop.ps1"),
      "-DataRoot", root, "-Reason", "fault-injection", "-Force"
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);

    const reopened = openDatabase({ filename });
    expect(createEmergencyStopService({ database: reopened }).status()).toMatchObject({
      active: true,
      reason: "fault-injection"
    });
    reopened.close();
  });
});

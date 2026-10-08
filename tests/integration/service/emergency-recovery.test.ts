import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("local owner emergency recovery", () => {
  test("clears stop without changing existing grant or security epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-mcp-emergency-clear-"));
    dirs.push(dir);
    const filename = join(dir, "operational.db");
    const database = openDatabase({ filename });
    migrateDatabase(database);
    database.close();

    const db = new Database(filename);
    db.prepare("INSERT INTO operational_state(namespace,key,value_json,updated_at) VALUES ('security','emergency_stop',?,?)")
      .run(JSON.stringify({ active: true, actor: "owner:test", reason: "testing", changedAt: "2026-10-08T00:00:00.000Z" }), "2026-10-08T00:00:00.000Z");
    const before = db.prepare("SELECT security_epoch FROM server_identity WHERE id=1").get() as {security_epoch:number}|undefined;
    db.close();

    const script = resolve("scripts/operations/clear-emergency-stop.mjs");
    const arguments_ = [script, filename, "2026-10-08T01:00:00.000Z", "owner:authorized-test"];
    const result = await run("node", arguments_, { windowsHide: true });
    expect(JSON.parse(result.stdout)).toMatchObject({ active: false, reason: "cleared" });

    const after = new Database(filename, { readonly: true });
    const row = after.prepare("SELECT value_json FROM operational_state WHERE namespace='security' AND key='emergency_stop'").get() as {value_json: string};
    expect(JSON.parse(row.value_json)).toMatchObject({ active: false, actor: "owner:authorized-test" });
    const epoch = after.prepare("SELECT security_epoch FROM server_identity WHERE id=1").get() as {security_epoch:number}|undefined;
    expect(epoch).toEqual(before);
    after.close();

    const again = await run("node", arguments_, { windowsHide: true });
    expect(JSON.parse(again.stdout)).toMatchObject({ active: false });
  });

  test.skipIf(process.platform !== "win32").each([
    "scripts/operations/clear-emergency-stop.ps1",
    "scripts/operations/emergency-stop.ps1",
    "scripts/operations/security-reset.ps1"
  ])("%s uses correct ProgramData even when environment variable is empty", async (scriptPath) => {
    const script = resolve(scriptPath);
    const command = [
      "$tokens=$null;$errors=$null",
      "$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:REMOTE_MCP_SCRIPT,[ref]$tokens,[ref]$errors)",
      "if($errors.Count -gt 0){throw 'Syntax errors'}",
      "$param=$ast.ParamBlock.Parameters|Where-Object{$_.Name.VariablePath.UserPath -eq 'DataRoot'}",
      "if(-not $param){throw 'Missing DataRoot'}",
      "$actual=Invoke-Expression $param.DefaultValue.Extent.Text",
      "$expected=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'",
      "if($actual -ne $expected){throw ('Wrong data folder '+$actual)}",
      "if($env:REMOTE_MCP_SCRIPT -like '*clear-emergency-stop.ps1') {",
      "  if(-not ($ast.Extent.Text -match 'Assert-Administrator')){throw 'Missing admin check'}",
      "  if(-not ($ast.Extent.Text -match 'service\\\\start\\.ps1')){throw 'Missing service health-checked restart'}",
      "}"
    ].join(";");
    const result = await run("powershell.exe", ["-NoProfile","-NonInteractive","-Command",command], {
      env: { ...process.env, ProgramData: "", REMOTE_MCP_SCRIPT: script }, windowsHide: true
    });
    expect(result.stderr).toBe("");
  });
});

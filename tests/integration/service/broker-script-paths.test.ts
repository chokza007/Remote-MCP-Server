import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const run = promisify(execFile);

describe("Broker Windows directory defaults", () => {
  test.skipIf(process.platform !== "win32").each([
    ["scripts/broker/install.ps1", "InstallRoot", "ProgramFiles"],
    ["scripts/broker/install.ps1", "DataRoot", "CommonApplicationData"],
    ["scripts/broker/status.ps1", "DataRoot", "CommonApplicationData"],
    ["scripts/broker/uninstall.ps1", "InstallRoot", "ProgramFiles"],
    ["scripts/broker/uninstall.ps1", "DataRoot", "CommonApplicationData"]
  ])("%s %s uses OS known folders even with environment variables unset",
    async (script, param, folder) => {
      const command = [
        "$tokens = $null; $errors = $null",
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:BROKER_SCRIPT, [ref]$tokens, [ref]$errors)",
        "if ($errors.Count -gt 0) { throw 'PowerShell parser failed' }",
        "$value = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq $env:BROKER_PARAMETER }",
        "if (-not $value) { throw 'Parameter not found' }",
        "$actual = Invoke-Expression $value.DefaultValue.Extent.Text",
        "$expected = Join-Path ([Environment]::GetFolderPath($env:BROKER_FOLDER)) 'Remote-MCP-Server\\Broker'",
        "if ($actual -ne $expected) { throw ('Unexpected default directory: ' + $actual) }"
      ].join("; ");
      const result = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", command
      ], {
        env: {
          ...process.env,
          ProgramData: "",
          ProgramFiles: "",
          USERPROFILE: "",
          BROKER_SCRIPT: resolve(script),
          BROKER_PARAMETER: param,
          BROKER_FOLDER: folder
        },
        windowsHide: true
      });
      expect(result.stderr).toBe("");
    }
  );
});

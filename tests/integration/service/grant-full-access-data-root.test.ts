import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("Windows service data directory defaults", () => {
  test.skipIf(process.platform !== "win32").each([
    "scripts/operations/grant-full-access.ps1",
    "scripts/service/install.ps1",
    "scripts/service/status.ps1"
  ])(
    "%s resolves Windows ProgramData even when the environment variable is empty",
    async (scriptPath) => {
      const command = [
        "$tokens = $null; $errors = $null",
        "$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:REMOTE_MCP_TEST_SCRIPT, [ref]$tokens, [ref]$errors)",
        "if ($errors.Count -gt 0) { throw 'PowerShell script syntax error' }",
        "$parameter = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'DataRoot' }",
        "if (-not $parameter) { throw 'DataRoot parameter not found' }",
        "$actual = Invoke-Expression $parameter.DefaultValue.Extent.Text",
        "$expected = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Remote-MCP-Server'",
        "if ($actual -ne $expected) { throw ('Wrong DataRoot default: ' + $actual) }"
      ].join("; ");

      const result = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          env: {
            ...process.env,
            ProgramData: "",
            REMOTE_MCP_TEST_SCRIPT: resolve(scriptPath)
          },
          windowsHide: true
        }
      );

      expect(result.stderr).toBe("");
    }
  );
});

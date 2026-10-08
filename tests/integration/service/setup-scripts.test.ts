import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows setup scripts", () => {
  test.skipIf(process.platform !== "win32")(
    "treats an empty installed tunnel version as not installed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "remote-mcp-tunnel-installer-"));
      roots.push(root);
      await mkdir(join(root, "tools", "tunnel-client"), { recursive: true });
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      await writeFile(join(root, "tools", "tunnel-client", "VERSION.txt"), "", "utf8");

      const command = [
        "$architecture = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) { 'X64' { 'amd64' } 'Arm64' { 'arm64' } default { throw 'unsupported test architecture' } }",
        "$archiveName = \"tunnel-client-v-test-windows-$architecture.zip\"",
        "function Invoke-RestMethod { [pscustomobject]@{ tag_name = 'v-test'; assets = @([pscustomobject]@{ name = $archiveName; browser_download_url = 'https://example.invalid/client.zip' }, [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = 'https://example.invalid/SHA256SUMS.txt' }) } }",
        "function Invoke-WebRequest { throw [System.InvalidOperationException]::new('DOWNLOAD_BOUNDARY_REACHED') }",
        "try { & $env:REMOTE_MCP_TEST_SCRIPT -ProjectRoot $env:REMOTE_MCP_TEST_ROOT -Force; exit 9 } catch { if ($_.Exception.Message -eq 'DOWNLOAD_BOUNDARY_REACHED') { exit 0 }; Write-Error $_; exit 10 }"
      ].join("; ");

      const result = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          env: {
            ...process.env,
            REMOTE_MCP_TEST_ROOT: root,
            REMOTE_MCP_TEST_SCRIPT: resolve("scripts/tunnel/install-client.ps1")
          },
          windowsHide: true
        }
      );

      expect(result.stderr).toBe("");
    }
  );

  test.skipIf(process.platform !== "win32")(
    "starts an installed service task and waits until the local endpoint is healthy",
    async () => {
      const command = [
        "$global:RemoteMcpTestStarted = $false",
        "function Get-ScheduledTask { param([string]$TaskName, $ErrorAction) [pscustomobject]@{ TaskName = $TaskName; State = if ($global:RemoteMcpTestStarted) { 'Running' } else { 'Ready' } } }",
        "function Start-ScheduledTask { param([string]$TaskName) $global:RemoteMcpTestStarted = $true }",
        "function Invoke-WebRequest { param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec) if (-not $global:RemoteMcpTestStarted) { throw 'not started' }; [pscustomobject]@{ StatusCode = 200 } }",
        "$result = & $env:REMOTE_MCP_TEST_SCRIPT -TimeoutSeconds 1",
        "if (-not $global:RemoteMcpTestStarted -or $result.State -ne 'Running' -or $result.HttpStatus -ne 200) { throw 'service start contract failed' }"
      ].join("; ");

      const result = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        {
          env: {
            ...process.env,
            REMOTE_MCP_TEST_SCRIPT: resolve("scripts/service/start.ps1")
          },
          windowsHide: true
        }
      );

      expect(result.stderr).toBe("");
    }
  );
});

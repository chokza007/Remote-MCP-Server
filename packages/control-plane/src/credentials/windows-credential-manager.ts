import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface VaultCredential {
  readonly secret: Uint8Array;
  readonly username?: string;
}

export interface CredentialVault {
  write(target: string, value: VaultCredential): Promise<void>;
  read(target: string): Promise<VaultCredential | null>;
  delete(target: string): Promise<boolean>;
}

export interface WindowsCredentialManagerOptions {
  readonly modulePath: string;
  readonly powershellExecutable?: string;
  readonly timeoutMs?: number;
}

interface HelperResponse {
  readonly ok: boolean;
  readonly found?: boolean;
  readonly deleted?: boolean;
  readonly username?: string | null;
  readonly secretBase64?: string;
  readonly error?: string;
}

const helperScript = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module $env:REMOTE_MCP_CREDENTIAL_MODULE -Force
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  switch ($request.operation) {
    'write' {
      Set-RemoteMcpCredential -Target ([string]$request.target) -Username ([string]$request.username) -SecretBytes ([Convert]::FromBase64String([string]$request.secretBase64))
      @{ ok = $true } | ConvertTo-Json -Compress
    }
    'read' {
      $item = Get-RemoteMcpCredential -Target ([string]$request.target)
      if ($null -eq $item) { @{ ok = $true; found = $false } | ConvertTo-Json -Compress }
      else { @{ ok = $true; found = $true; username = $item.Username; secretBase64 = [Convert]::ToBase64String($item.SecretBytes) } | ConvertTo-Json -Compress }
    }
    'delete' {
      $deleted = Remove-RemoteMcpCredential -Target ([string]$request.target)
      @{ ok = $true; deleted = [bool]$deleted } | ConvertTo-Json -Compress
    }
    default { throw 'Unknown credential helper operation' }
  }
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}`;

export class WindowsCredentialManager implements CredentialVault {
  private readonly modulePath: string;
  private readonly executable: string;
  private readonly timeoutMs: number;

  public constructor(options: WindowsCredentialManagerOptions) {
    this.modulePath = resolve(options.modulePath);
    this.executable = options.powershellExecutable ?? "powershell.exe";
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  public async write(target: string, value: VaultCredential): Promise<void> {
    await this.run({
      operation: "write",
      target,
      username: value.username ?? "",
      secretBase64: Buffer.from(value.secret).toString("base64")
    });
  }

  public async read(target: string): Promise<VaultCredential | null> {
    const response = await this.run({ operation: "read", target });
    if (response.found !== true || response.secretBase64 === undefined) return null;
    return {
      secret: Buffer.from(response.secretBase64, "base64"),
      ...(response.username === undefined || response.username === null || response.username === ""
        ? {}
        : { username: response.username })
    };
  }

  public async delete(target: string): Promise<boolean> {
    return (await this.run({ operation: "delete", target })).deleted === true;
  }

  private async run(request: Record<string, unknown>): Promise<HelperResponse> {
    if (process.platform !== "win32") throw new Error("Windows Credential Manager is available only on Windows");
    const environment: NodeJS.ProcessEnv = {
      REMOTE_MCP_CREDENTIAL_MODULE: this.modulePath
    };
    for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return new Promise<HelperResponse>((resolvePromise, reject) => {
      const child = spawn(this.executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", helperScript
      ], { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= 1024 * 1024) stdout.push(chunk);
        else child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).byteLength < 64 * 1024) stderr.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        let response: HelperResponse;
        try {
          response = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) as HelperResponse;
        } catch {
          reject(new Error(`Credential helper returned invalid JSON: ${Buffer.concat(stderr).toString("utf8").trim()}`));
          return;
        }
        if (code !== 0 || !response.ok) {
          reject(new Error(response.error ?? `Credential helper exited with code ${code ?? -1}`));
          return;
        }
        resolvePromise(response);
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  }
}

export function createWindowsCredentialManager(options: WindowsCredentialManagerOptions): WindowsCredentialManager {
  return new WindowsCredentialManager(options);
}

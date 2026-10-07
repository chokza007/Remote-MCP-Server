import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { RemoteMcpError } from "@remote-mcp/contracts";

const execFileAsync = promisify(execFile);
const trackedMetadata = new Map<number, { readonly parentPid: number; readonly commandLine: string }>();
const PROCESS_QUERY_TIMEOUT_MS = 15_000;

export interface ProcessIdentity {
  readonly pid: number;
  readonly createdAt: string;
}

export interface ProcessInfo {
  readonly identity: ProcessIdentity;
  readonly parentPid: number;
  readonly name: string;
  readonly executable: string | null;
  readonly commandLine: string | null;
}

export interface StartProcessInput {
  readonly file: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface WaitProcessInput {
  readonly identity: ProcessIdentity;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface TerminateProcessInput {
  readonly identity: ProcessIdentity;
  readonly force?: boolean;
}

function redactCommandLine(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/(\bBearer\s+)[^\s"]+/giu, "$1[REDACTED]")
    .replace(/(--(?:token|password|secret|api-key))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s"]+)/giu, "$1=[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s"]+)/gu, "$1=[REDACTED]");
}

async function queryProcesses(pid?: number): Promise<readonly ProcessInfo[]> {
  const source = pid === undefined
    ? "Get-CimInstance Win32_Process -ErrorAction Stop"
    : `Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction Stop`;
  const script = [
    `$items = @(${source});`,
    "$out = @($items | ForEach-Object {",
    "$started = $null; try { $started = $_.CreationDate.ToUniversalTime().ToString('o') } catch {} ;",
    "if ($started) { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=[string]$_.Name; executable=$_.ExecutablePath; createdAt=$started } }",
    "}); ConvertTo-Json -InputObject $out -Compress -Depth 4"
  ].join(" ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: PROCESS_QUERY_TIMEOUT_MS
    });
    const raw = stdout.trim().length === 0 ? [] : JSON.parse(stdout) as Array<{
      pid: number;
      parentPid: number;
      name: string;
      executable: string | null;
      createdAt: string | null;
    }>;
    return raw
      .filter((entry) => entry.createdAt !== null)
      .map((entry) => {
        const tracked = trackedMetadata.get(entry.pid);
        return {
          identity: { pid: entry.pid, createdAt: entry.createdAt! },
          parentPid: tracked?.parentPid ?? entry.parentPid,
          name: entry.name,
          executable: entry.executable,
          commandLine: redactCommandLine(tracked?.commandLine ?? null)
        };
      });
  } catch (error) {
    throw new RemoteMcpError({
      errorCode: "PROCESS_INSPECTION_FAILED",
      message: "Windows process inspection failed.",
      retryable: true,
      suggestedAction: "Retry or inspect PowerShell availability and account permissions.",
      target: pid === undefined ? "all-processes" : String(pid),
      cause: error
    });
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Process wait cancelled", "AbortError");
}

export class ProcessService {
  readonly #children = new Map<number, { readonly process: ChildProcess; exitCode: number | null }>();

  public async list(): Promise<readonly ProcessInfo[]> {
    return queryProcesses();
  }

  public async inspect(pid: number): Promise<ProcessInfo> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Invalid process ID: ${pid}`);
    const process = (await queryProcesses(pid))[0];
    if (!process) throw new Error(`Process not found: ${pid}`);
    return process;
  }

  public async start(input: StartProcessInput): Promise<ProcessIdentity> {
    const environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      ...input.env
    };
    const child = spawn(input.file, [...(input.args ?? [])], {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      env: environment,
      windowsHide: true,
      stdio: "ignore"
    });
    if (child.pid === undefined) throw new Error(`Failed to start process: ${input.file}`);
    const tracked = { process: child, exitCode: null as number | null };
    this.#children.set(child.pid, tracked);
    trackedMetadata.set(child.pid, {
      parentPid: process.pid,
      commandLine: [input.file, ...(input.args ?? [])].join(" ")
    });
    child.once("exit", (code) => {
      tracked.exitCode = code ?? -1;
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return (await this.inspect(child.pid)).identity;
      } catch (error) {
        if (attempt === 99) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`Failed to inspect started process: ${child.pid}`);
  }

  public async wait(input: WaitProcessInput): Promise<{ readonly exitCode: number }> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0) throw new Error("Wait timeout is invalid");
    abortIfNeeded(input.signal);
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() <= deadline) {
      abortIfNeeded(input.signal);
      try {
        await this.assertIdentity(input.identity);
      } catch (error) {
        if (/not found/iu.test((error as Error).message)) {
          return { exitCode: this.#children.get(input.identity.pid)?.exitCode ?? -1 };
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Process wait timeout: ${input.identity.pid}`);
  }

  public async terminateTree(input: TerminateProcessInput): Promise<void> {
    await this.assertIdentity(input.identity);
    const args = ["/PID", String(input.identity.pid), "/T", ...(input.force === false ? [] : ["/F"] )];
    try {
      await execFileAsync("taskkill.exe", args, { windowsHide: true });
    } catch (error) {
      const message = (error as Error).message;
      if (!/not found|no running instance/iu.test(message)) throw error;
    }
  }

  private async assertIdentity(identity: ProcessIdentity): Promise<void> {
    const current = await this.inspect(identity.pid);
    if (current.identity.createdAt !== identity.createdAt) {
      throw new Error(`Process creation identity mismatch for PID ${identity.pid}`);
    }
  }
}

export function createProcessService(): ProcessService {
  return new ProcessService();
}

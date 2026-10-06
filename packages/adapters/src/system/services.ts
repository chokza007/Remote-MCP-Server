import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsServiceInfo {
  readonly name: string;
  readonly displayName: string;
  readonly state: "running" | "stopped" | "paused" | "start_pending" | "stop_pending" | "unknown";
  readonly startMode: string;
  readonly processId: number | null;
}

export interface WindowsServiceBackend {
  list(): Promise<readonly WindowsServiceInfo[]>;
  inspect(name: string): Promise<WindowsServiceInfo>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}

function normalizeState(value: string): WindowsServiceInfo["state"] {
  switch (value.toLowerCase()) {
    case "running": return "running";
    case "stopped": return "stopped";
    case "paused": return "paused";
    case "start pending": return "start_pending";
    case "stop pending": return "stop_pending";
    default: return "unknown";
  }
}

class PowerShellWindowsServiceBackend implements WindowsServiceBackend {
  public async list(): Promise<readonly WindowsServiceInfo[]> {
    return this.query();
  }

  public async inspect(name: string): Promise<WindowsServiceInfo> {
    const service = (await this.query(name))[0];
    if (!service) throw new Error(`Windows service not found: ${name}`);
    return service;
  }

  public async start(name: string): Promise<void> {
    await this.mutate("Start-Service", name);
  }

  public async stop(name: string): Promise<void> {
    await this.mutate("Stop-Service", name);
  }

  private async query(name?: string): Promise<readonly WindowsServiceInfo[]> {
    const escaped = name?.replaceAll("'", "''");
    const filter = escaped === undefined ? "" : ` | Where-Object Name -eq '${escaped}'`;
    const script = `$out = @(Get-CimInstance Win32_Service${filter} | ForEach-Object { [pscustomobject]@{ name=$_.Name; displayName=$_.DisplayName; state=$_.State; startMode=$_.StartMode; processId=if($_.ProcessId -gt 0){[int]$_.ProcessId}else{$null} } }); ConvertTo-Json -InputObject $out -Compress`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const rows = JSON.parse(stdout || "[]") as Array<{ name: string; displayName: string; state: string; startMode: string; processId: number | null }>;
    return rows.map((row) => ({ ...row, state: normalizeState(row.state) }));
  }

  private async mutate(command: string, name: string): Promise<void> {
    const escaped = name.replaceAll("'", "''");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${command} -Name '${escaped}' -ErrorAction Stop`], { windowsHide: true });
  }
}

export class WindowsServiceService {
  readonly #backend: WindowsServiceBackend;

  public constructor(options: { readonly backend?: WindowsServiceBackend } = {}) {
    this.#backend = options.backend ?? new PowerShellWindowsServiceBackend();
  }

  public list(): Promise<readonly WindowsServiceInfo[]> { return this.#backend.list(); }
  public inspect(name: string): Promise<WindowsServiceInfo> { return this.#backend.inspect(name); }
  public async start(name: string): Promise<void> { await this.#backend.start(name); }
  public async stop(name: string): Promise<void> { await this.#backend.stop(name); }
  public async restart(name: string): Promise<void> {
    await this.#backend.stop(name);
    await this.#backend.start(name);
  }
}

export function createWindowsServiceService(
  options: { readonly backend?: WindowsServiceBackend } = {}
): WindowsServiceService {
  return new WindowsServiceService(options);
}

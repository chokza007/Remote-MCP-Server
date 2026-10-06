import { execFile } from "node:child_process";
import { arch, hostname, platform, release, type } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemSnapshot {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostname: string;
  readonly osType: string;
  readonly osRelease: string;
  readonly nodeVersion: string;
}

export interface CapabilityStatus {
  readonly name: string;
  readonly available: boolean;
  readonly path: string | null;
}

const capabilities = [
  ["powershell", "powershell.exe"],
  ["cmd", "cmd.exe"],
  ["python", "python.exe"],
  ["node", "node.exe"],
  ["git", "git.exe"],
  ["ffmpeg", "ffmpeg.exe"]
] as const;

export class SystemDiscovery {
  public async snapshot(): Promise<SystemSnapshot> {
    return {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      osType: type(),
      osRelease: release(),
      nodeVersion: process.version
    };
  }

  public async capabilities(): Promise<readonly CapabilityStatus[]> {
    return Promise.all(
      capabilities.map(async ([name, executable]) => {
        try {
          const { stdout } = await execFileAsync("where.exe", [executable], { windowsHide: true });
          return { name, available: true, path: stdout.split(/\r?\n/u).find(Boolean) ?? null };
        } catch {
          return { name, available: false, path: null };
        }
      })
    );
  }
}

export function createSystemDiscovery(): SystemDiscovery {
  return new SystemDiscovery();
}

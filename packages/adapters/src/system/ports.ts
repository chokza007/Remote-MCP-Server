import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PortListener {
  readonly protocol: "tcp" | "udp";
  readonly address: string;
  readonly port: number;
  readonly pid: number;
  readonly state: string;
}

function parseEndpoint(endpoint: string): { readonly address: string; readonly port: number } | null {
  const bracket = /^\[(.*)\]:(\d+)$/u.exec(endpoint);
  if (bracket) return { address: bracket[1]!, port: Number(bracket[2]) };
  const separator = endpoint.lastIndexOf(":");
  if (separator < 0) return null;
  return { address: endpoint.slice(0, separator), port: Number(endpoint.slice(separator + 1)) };
}

export class PortService {
  public async listeners(): Promise<readonly PortListener[]> {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano"], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    const output: PortListener[] = [];
    for (const line of stdout.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u);
      const protocol = fields[0]?.toLowerCase();
      if (protocol === "tcp") {
        if (fields[3]?.toUpperCase() !== "LISTENING") continue;
        const endpoint = parseEndpoint(fields[1] ?? "");
        const pid = Number(fields[4]);
        if (endpoint && Number.isSafeInteger(pid)) {
          output.push({ protocol: "tcp", ...endpoint, pid, state: "listening" });
        }
      } else if (protocol === "udp") {
        const endpoint = parseEndpoint(fields[1] ?? "");
        const pid = Number(fields[3]);
        if (endpoint && Number.isSafeInteger(pid)) {
          output.push({ protocol: "udp", ...endpoint, pid, state: "bound" });
        }
      }
    }
    return output.sort((left, right) =>
      left.port - right.port || left.protocol.localeCompare(right.protocol) || left.pid - right.pid
    );
  }

  public async resolve(
    port: number,
    protocol?: "tcp" | "udp"
  ): Promise<readonly PortListener[]> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Port is invalid");
    return (await this.listeners()).filter(
      (entry) => entry.port === port && (protocol === undefined || entry.protocol === protocol)
    );
  }
}

export function createPortService(): PortService {
  return new PortService();
}

import type { WatchAdapter, WatchProbeInput, WatchProbeResult } from "./file-watch.js";

export type ProcessProbe = (pid: number) => boolean | Promise<boolean>;

export class ProcessWatchAdapter implements WatchAdapter {
  public readonly kind = "process";

  public constructor(private readonly inspect: ProcessProbe = defaultProcessProbe) {}

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const pid = Number(input.target);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Process watch target must be a positive PID");
    const alive = await this.inspect(pid);
    const fingerprint = alive ? "running" : "stopped";
    return {
      fingerprint,
      events: input.fingerprint === null || input.fingerprint === fingerprint
        ? []
        : [{ type: alive ? "process_started" : "process_stopped", payload: { pid } }]
    };
  }
}

function defaultProcessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

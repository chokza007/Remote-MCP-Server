import type { WatchAdapter, WatchProbeInput, WatchProbeResult } from "./file-watch.js";

export type JobStateProbe = (jobId: string) => string | Promise<string>;

export class JobWatchAdapter implements WatchAdapter {
  public readonly kind = "job";

  public constructor(private readonly inspect: JobStateProbe) {}

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const state = await this.inspect(input.target);
    return {
      fingerprint: state,
      events: input.fingerprint === null || input.fingerprint === state
        ? []
        : [{ type: "job_state_changed", payload: { jobId: input.target, state } }]
    };
  }
}

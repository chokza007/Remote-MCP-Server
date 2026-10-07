import { createHash } from "node:crypto";

import type { WatchAdapter, WatchProbeInput, WatchProbeResult } from "./file-watch.js";

export interface UrlProbeResult {
  readonly status: number;
  readonly body: string | Uint8Array;
}

export type UrlProbe = (url: string) => Promise<UrlProbeResult>;

export class UrlWatchAdapter implements WatchAdapter {
  public readonly kind = "url";

  public constructor(private readonly request: UrlProbe) {}

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const response = await this.request(input.target);
    const content = typeof response.body === "string" ? Buffer.from(response.body, "utf8") : Buffer.from(response.body);
    const fingerprint = createHash("sha256").update(String(response.status)).update(content).digest("hex");
    return {
      fingerprint,
      events: input.fingerprint === null || input.fingerprint === fingerprint
        ? []
        : [{ type: "url_changed", payload: { url: input.target, status: response.status, bodyBytes: content.byteLength } }]
    };
  }
}

export async function defaultUrlProbe(url: string): Promise<UrlProbeResult> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 1_048_576) throw new Error("URL watch response exceeds 1 MiB");
  return { status: response.status, body };
}

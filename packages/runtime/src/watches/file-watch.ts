import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";

export interface WatchProbeEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface WatchProbeInput {
  readonly target: string;
  readonly cursor: unknown;
  readonly fingerprint: string | null;
  readonly specification: Readonly<Record<string, unknown>>;
}

export interface WatchProbeResult {
  readonly fingerprint: string;
  readonly cursor?: unknown;
  readonly events: readonly WatchProbeEvent[];
}

export interface WatchAdapter {
  readonly kind: string;
  probe(input: WatchProbeInput): Promise<WatchProbeResult>;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class FileWatchAdapter implements WatchAdapter {
  public readonly kind = "file";

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const info = await stat(input.target).catch(() => undefined);
    const fingerprint = info
      ? hash(`${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.birthtimeMs}`)
      : "missing";
    if (input.fingerprint === null || input.fingerprint === fingerprint) return { fingerprint, events: [] };
    return {
      fingerprint,
      events: [{
        type: info ? (input.fingerprint === "missing" ? "file_created" : "file_changed") : "file_deleted",
        payload: info ? { path: input.target, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() } : { path: input.target }
      }]
    };
  }
}

export class DirectoryWatchAdapter implements WatchAdapter {
  public readonly kind = "directory";

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const entries = await readdir(input.target, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      const fingerprint = "missing";
      return {
        fingerprint,
        events: input.fingerprint === null || input.fingerprint === fingerprint
          ? []
          : [{ type: "directory_deleted", payload: { path: input.target } }]
      };
    }
    const details = await Promise.all(entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const info = await stat(`${input.target}/${entry.name}`).catch(() => undefined);
        return `${entry.name}:${entry.isDirectory() ? "d" : "f"}:${info?.size ?? -1}:${info?.mtimeMs ?? -1}`;
      }));
    const fingerprint = hash(details.join("\n"));
    return {
      fingerprint,
      events: input.fingerprint === null || input.fingerprint === fingerprint
        ? []
        : [{ type: "directory_changed", payload: { path: input.target, entries: entries.length } }]
    };
  }
}

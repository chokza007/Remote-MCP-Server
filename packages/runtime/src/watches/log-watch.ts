import { open, stat } from "node:fs/promises";

import type { WatchAdapter, WatchProbeEvent, WatchProbeInput, WatchProbeResult } from "./file-watch.js";

interface LogCursor {
  readonly offset: number;
  readonly signature: string;
}

function cursor(value: unknown): LogCursor | null {
  if (
    typeof value !== "object" || value === null || typeof (value as LogCursor).offset !== "number" ||
    typeof (value as LogCursor).signature !== "string"
  ) return null;
  return value as LogCursor;
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  if (end <= start) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export class LogWatchAdapter implements WatchAdapter {
  public readonly kind = "log";

  public async probe(input: WatchProbeInput): Promise<WatchProbeResult> {
    const info = await stat(input.target);
    const signature = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    const previous = cursor(input.cursor);
    if (!previous) return { fingerprint: `${signature}:${info.size}`, cursor: { offset: info.size, signature }, events: [] };
    const events: WatchProbeEvent[] = [];
    let offset = previous.offset;
    if (signature !== previous.signature) {
      events.push({ type: "log_rotated", payload: { path: input.target } });
      offset = 0;
    } else if (info.size < previous.offset) {
      events.push({ type: "log_truncated", payload: { path: input.target, previousOffset: previous.offset, sizeBytes: info.size } });
      offset = 0;
    }
    if (info.size > offset) {
      const content = await readRange(input.target, offset, info.size);
      events.push({ type: "log_appended", payload: { path: input.target, offset, content } });
    }
    return {
      fingerprint: `${signature}:${info.size}`,
      cursor: { offset: info.size, signature },
      events
    };
  }
}

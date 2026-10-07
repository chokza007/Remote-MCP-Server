import { RemoteMcpError } from "@remote-mcp/contracts";

import type { Disposable } from "./secret-fingerprints.js";

export interface SecurityLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxArchiveExpandedBytes: number;
  readonly maxArchiveCompressionRatio: number;
  readonly maxMediaInputBytes: number;
  readonly maxConcurrentProcesses: number;
  readonly maxConcurrentJobs: number;
}

export const DEFAULT_SECURITY_LIMITS: Readonly<SecurityLimits> = Object.freeze({
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  maxArchiveExpandedBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveCompressionRatio: 200,
  maxMediaInputBytes: 16 * 1024 * 1024 * 1024,
  maxConcurrentProcesses: 16,
  maxConcurrentJobs: 32
});

export class SecurityLimitError extends RemoteMcpError {
  public constructor(message: string, target: string) {
    super({
      errorCode: "RESOURCE_LIMIT_EXCEEDED",
      message,
      retryable: target === "process" || target === "job",
      suggestedAction: "Reduce the input size or wait for existing work to release capacity.",
      target
    });
    this.name = "SecurityLimitError";
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export class SecurityLimiter {
  public readonly limits: Readonly<SecurityLimits>;
  readonly #active = { process: 0, job: 0 };

  public constructor(overrides: Partial<SecurityLimits> = {}) {
    const limits = { ...DEFAULT_SECURITY_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
      if (name === "maxArchiveCompressionRatio") {
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
      } else {
        positiveInteger(name, value);
      }
    }
    this.limits = Object.freeze(limits);
  }

  public assertRequestBytes(bytes: number): void {
    this.assertBytes("request", bytes, this.limits.maxRequestBytes);
  }

  public assertResponseBytes(bytes: number): void {
    this.assertBytes("response", bytes, this.limits.maxResponseBytes);
  }

  public assertMediaInputBytes(bytes: number): void {
    this.assertBytes("media input", bytes, this.limits.maxMediaInputBytes);
  }

  public assertArchive(input: {
    readonly entries: number;
    readonly expandedBytes: number;
    readonly compressedBytes: number;
  }): void {
    const entries = this.nonNegative("archive entries", input.entries);
    const expanded = this.nonNegative("archive expanded bytes", input.expandedBytes);
    const compressed = this.nonNegative("archive compressed bytes", input.compressedBytes);
    if (entries > this.limits.maxArchiveEntries) {
      throw new SecurityLimitError(`Archive entries exceed ${this.limits.maxArchiveEntries}`, "archive");
    }
    if (expanded > this.limits.maxArchiveExpandedBytes) {
      throw new SecurityLimitError(`Archive expanded bytes exceed ${this.limits.maxArchiveExpandedBytes}`, "archive");
    }
    const ratio = expanded === 0 ? 0 : compressed === 0 ? Number.POSITIVE_INFINITY : expanded / compressed;
    if (ratio > this.limits.maxArchiveCompressionRatio) {
      throw new SecurityLimitError(`Archive compression ratio exceeds ${this.limits.maxArchiveCompressionRatio}`, "archive");
    }
  }

  public acquire(kind: "process" | "job"): Disposable {
    const limit = kind === "process" ? this.limits.maxConcurrentProcesses : this.limits.maxConcurrentJobs;
    if (this.#active[kind] >= limit) {
      throw new SecurityLimitError(`${kind} capacity ${limit} is exhausted`, kind);
    }
    this.#active[kind] += 1;
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.#active[kind] -= 1;
      }
    };
  }

  private assertBytes(label: string, bytes: number, limit: number): void {
    this.nonNegative(label, bytes);
    if (bytes > limit) throw new SecurityLimitError(`${label} bytes exceed ${limit}`, label);
  }

  private nonNegative(label: string, value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SecurityLimitError(`${label} must be a non-negative safe integer`, label);
    }
    return value;
  }
}

export function createSecurityLimiter(overrides: Partial<SecurityLimits> = {}): SecurityLimiter {
  return new SecurityLimiter(overrides);
}

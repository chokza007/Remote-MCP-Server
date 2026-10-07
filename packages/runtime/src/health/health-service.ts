import type { CapabilityReportEntry, CapabilityRegistry } from "./capability-registry.js";

interface HealthConnection {
  pragma(value: string, options?: { readonly simple?: boolean }): unknown;
}

export interface HealthDatabase {
  integrityCheck(): readonly string[];
  read<Result>(reader: (connection: HealthConnection) => Result): Result;
}

export interface HealthReport {
  readonly schemaVersion: 1;
  readonly status: "ready" | "degraded" | "failed";
  readonly database: {
    readonly status: "ready" | "failed";
    readonly writable: boolean;
    readonly integrity: readonly string[];
  };
  readonly capabilities: readonly CapabilityReportEntry[];
  readonly checkedAt: string;
}

function secretSafe(value: unknown, key = ""): unknown {
  if (/(?:secret|token|password|credential|authorization|cookie)/iu.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => secretSafe(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, secretSafe(entry, entryKey)]));
  }
  return value;
}

function queryOnly(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === "object") return Object.values(first)[0] !== 0;
  }
  return false;
}

export class HealthService {
  readonly #database: HealthDatabase;
  readonly #registry: CapabilityRegistry;
  readonly #now: () => Date;
  readonly #redact: (value: unknown) => unknown;

  public constructor(options: {
    readonly database: HealthDatabase;
    readonly registry: CapabilityRegistry;
    readonly now?: () => Date;
    readonly redact?: (value: unknown) => unknown;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#now = options.now ?? (() => new Date());
    this.#redact = options.redact ?? secretSafe;
  }

  public async report(): Promise<HealthReport> {
    let integrity: readonly string[];
    let writable = false;
    try {
      integrity = this.#database.integrityCheck();
      writable = !this.#database.read((connection) => queryOnly(connection.pragma("query_only", { simple: true })));
    } catch (error) {
      integrity = [error instanceof Error ? error.message : String(error)];
    }
    const databaseReady = writable && integrity.length > 0 && integrity.every((entry) => entry === "ok");
    const capabilities = this.#redact(await this.#registry.probeAll()) as readonly CapabilityReportEntry[];
    const requiredFailure = capabilities.some((entry) => entry.required && (entry.status === "failed" || entry.status === "unavailable"));
    const anyImpaired = capabilities.some((entry) => entry.status !== "ready");
    const status = !databaseReady || requiredFailure ? "failed" : anyImpaired ? "degraded" : "ready";
    return {
      schemaVersion: 1,
      status,
      database: { status: databaseReady ? "ready" : "failed", writable, integrity },
      capabilities,
      checkedAt: this.#now().toISOString()
    };
  }
}

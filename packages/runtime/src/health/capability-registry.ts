export type CapabilityStatus = "ready" | "degraded" | "unavailable" | "failed";

export interface CapabilityProbeResult {
  readonly status: CapabilityStatus;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly evidence?: unknown;
  readonly remediation?: string;
}

export interface CapabilitySelfTestResult {
  readonly verified: boolean;
  readonly evidence: unknown;
}

export interface CapabilityDefinition {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  readonly description: string;
  readonly remediation?: string;
  probe(): Promise<CapabilityProbeResult>;
  selfTest(): Promise<CapabilitySelfTestResult>;
}

export interface CapabilityLastTest extends CapabilitySelfTestResult {
  readonly checkedAt: string;
}

export interface CapabilityReportEntry extends CapabilityProbeResult {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  readonly description: string;
  readonly remediation?: string;
  readonly lastTest: CapabilityLastTest | null;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();
  readonly #lastTests = new Map<string, CapabilityLastTest>();
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public register(definition: CapabilityDefinition): void {
    if (!/^[a-z][a-z0-9_.-]+$/u.test(definition.id)) throw new Error(`Invalid capability ID: ${definition.id}`);
    if (this.#definitions.has(definition.id)) throw new Error(`Capability is already registered: ${definition.id}`);
    this.#definitions.set(definition.id, definition);
  }

  public definitions(): readonly CapabilityDefinition[] {
    return [...this.#definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public get(id: string): CapabilityDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error(`Capability is not registered: ${id}`);
    return definition;
  }

  public lastTest(id: string): CapabilityLastTest | null {
    return this.#lastTests.get(id) ?? null;
  }

  public recordTest(id: string, result: CapabilitySelfTestResult): CapabilityLastTest {
    this.get(id);
    const record = { ...result, checkedAt: this.#now().toISOString() };
    this.#lastTests.set(id, record);
    return record;
  }

  public async probeAll(): Promise<readonly CapabilityReportEntry[]> {
    return Promise.all(this.definitions().map(async (definition) => {
      try {
        const result = await definition.probe();
        const remediation = result.remediation ?? definition.remediation;
        return {
          ...result,
          id: definition.id,
          version: definition.version,
          required: definition.required,
          description: definition.description,
          ...(remediation === undefined ? {} : { remediation }),
          lastTest: this.lastTest(definition.id)
        };
      } catch (error) {
        return {
          id: definition.id,
          version: definition.version,
          required: definition.required,
          description: definition.description,
          status: "failed" as const,
          dependencies: {},
          evidence: { error: error instanceof Error ? error.message : String(error) },
          ...(definition.remediation === undefined ? {} : { remediation: definition.remediation }),
          lastTest: this.lastTest(definition.id)
        };
      }
    }));
  }
}

export const CORE_CAPABILITY_MANIFEST = Object.freeze({
  schemaVersion: 1,
  capabilities: [
    { id: "browser.playwright", version: "1.0.0", required: false },
    { id: "core.database", version: "1.0.0", required: true },
    { id: "core.gateway", version: "1.0.0", required: true },
    { id: "core.jobs", version: "1.0.0", required: true },
    { id: "documents.python", version: "1.0.0", required: false },
    { id: "gui.windows", version: "1.0.0", required: false },
    { id: "media.ffmpeg", version: "1.0.0", required: false },
    { id: "privileged.broker", version: "1.0.0", required: false },
    { id: "system.git", version: "1.0.0", required: false },
    { id: "system.powershell", version: "1.0.0", required: true }
  ]
} as const);

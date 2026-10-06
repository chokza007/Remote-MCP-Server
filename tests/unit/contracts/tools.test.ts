import { describe, expect, test } from "vitest";

interface ContractsModule {
  asPrincipalId?: (value: string) => string;
  asClientId?: (value: string) => string;
  parseToolDescriptor?: (value: unknown) => unknown;
  createOperationalEvent?: (input: {
    type: string;
    sequence: number;
    correlationId: string;
    payload: unknown;
    occurredAt: string;
  }) => unknown;
}

const validDescriptor = {
  schemaVersion: 1,
  name: "filesystem_read",
  version: "1.0.0",
  title: "Read a file range",
  description: "Reads a bounded byte range from a canonical file target.",
  riskTier: 0,
  requiredScope: "filesystem:read",
  supportsDryRun: false,
  defaultTimeoutMs: 30_000,
  cancellable: true
} as const;

describe("tool and identity contracts", () => {
  test("accepts a complete version-one tool descriptor", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    expect(typeof contracts.parseToolDescriptor).toBe("function");
    expect(contracts.parseToolDescriptor?.(validDescriptor)).toEqual(validDescriptor);
  });

  test("rejects an unsupported tool schema version", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;

    expect(() =>
      contracts.parseToolDescriptor?.({ ...validDescriptor, schemaVersion: 2 })
    ).toThrow(/schema/i);
  });

  test("rejects empty stable identity values", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;

    expect(contracts.asPrincipalId?.("principal-1")).toBe("principal-1");
    expect(contracts.asClientId?.("client-1")).toBe("client-1");
    expect(() => contracts.asPrincipalId?.("  ")).toThrow(/principal/i);
  });

  test("creates an immutable version-one operational event", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const event = contracts.createOperationalEvent?.({
      type: "job.started",
      sequence: 7,
      correlationId: "corr-1",
      payload: { jobId: "job-1" },
      occurredAt: "2026-10-06T15:00:00.000Z"
    });

    expect(event).toEqual({
      schemaVersion: 1,
      type: "job.started",
      sequence: 7,
      correlationId: "corr-1",
      payload: { jobId: "job-1" },
      occurredAt: "2026-10-06T15:00:00.000Z"
    });
    expect(Object.isFrozen(event)).toBe(true);
  });
});

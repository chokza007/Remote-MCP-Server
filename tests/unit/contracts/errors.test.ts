import { describe, expect, test } from "vitest";

interface ErrorOptions {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction: string;
  readonly target: string;
  readonly cause?: unknown;
}

interface ToolErrorEnvelope {
  readonly error_code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggested_action: string;
  readonly target: string;
  readonly underlying_error: string;
}

interface ContractsModule {
  RemoteMcpError?: new (options: ErrorOptions) => Error;
  toToolError?: (error: unknown, context?: { readonly target?: string }) => ToolErrorEnvelope;
}

describe("structured tool errors", () => {
  test("preserves every public recovery field without exposing a stack", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    expect(typeof contracts.RemoteMcpError).toBe("function");
    expect(typeof contracts.toToolError).toBe("function");

    if (!contracts.RemoteMcpError || !contracts.toToolError) {
      throw new Error("Structured error exports are unavailable");
    }

    const error = new contracts.RemoteMcpError({
      errorCode: "RESOURCE_LOCKED",
      message: "The target is locked by another operation.",
      retryable: true,
      suggestedAction: "Wait for the reported job or cancel it.",
      target: "C:\\Work\\file.txt",
      cause: new Error("sharing violation\nprivate stack line")
    });

    expect(contracts.toToolError(error)).toEqual({
      error_code: "RESOURCE_LOCKED",
      message: "The target is locked by another operation.",
      retryable: true,
      suggested_action: "Wait for the reported job or cancel it.",
      target: "C:\\Work\\file.txt",
      underlying_error: "sharing violation private stack line"
    });
  });

  test("maps unknown failures to a non-retryable sanitized envelope", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const result = contracts.toToolError?.(new Error("boom\u0000\r\nnext"), {
      target: "system"
    });

    expect(result).toEqual({
      error_code: "INTERNAL_ERROR",
      message: "The operation failed unexpectedly.",
      retryable: false,
      suggested_action: "Inspect the sanitized audit log and retry only after resolving the cause.",
      target: "system",
      underlying_error: "boom next"
    });
  });
});

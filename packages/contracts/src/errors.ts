export interface ToolErrorEnvelope {
  readonly error_code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggested_action: string;
  readonly target: string;
  readonly underlying_error: string;
}

export interface RemoteMcpErrorOptions {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction: string;
  readonly target: string;
  readonly cause?: unknown;
}

export class RemoteMcpError extends Error {
  public readonly errorCode: string;
  public readonly retryable: boolean;
  public readonly suggestedAction: string;
  public readonly target: string;

  public constructor(options: RemoteMcpErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RemoteMcpError";
    this.errorCode = options.errorCode;
    this.retryable = options.retryable;
    this.suggestedAction = options.suggestedAction;
    this.target = options.target;
  }
}

function sanitizeDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_048);
}

export function toToolError(
  error: unknown,
  context: { readonly target?: string } = {}
): ToolErrorEnvelope {
  if (error instanceof RemoteMcpError) {
    return {
      error_code: error.errorCode,
      message: error.message,
      retryable: error.retryable,
      suggested_action: error.suggestedAction,
      target: error.target,
      underlying_error: sanitizeDiagnostic(error.cause ?? error.message)
    };
  }

  return {
    error_code: "INTERNAL_ERROR",
    message: "The operation failed unexpectedly.",
    retryable: false,
    suggested_action: "Inspect the sanitized audit log and retry only after resolving the cause.",
    target: context.target ?? "unknown",
    underlying_error: sanitizeDiagnostic(error)
  };
}

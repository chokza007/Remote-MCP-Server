export type GitErrorCode =
  | "COMMAND_FAILED"
  | "NOT_A_REPOSITORY"
  | "OUTPUT_LIMIT"
  | "ROOT_MISMATCH"
  | "UNSAFE_PATHSPEC"
  | "INVALID_ARGUMENT";

export interface GitAdapterErrorOptions {
  readonly code: GitErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;
}

const credentialInUrl = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu;
const sensitiveAssignment = /\b(token|password|secret|api[-_]?key)=([^\s&]+)/giu;

export function redactGitOutput(value: string): string {
  return value
    .replace(credentialInUrl, "$1[REDACTED]@")
    .replace(sensitiveAssignment, "$1=[REDACTED]");
}

export class GitAdapterError extends RemoteMcpError {
  public readonly code: GitErrorCode;
  public readonly operation: string;
  public readonly exitCode?: number | null;
  public readonly stderr?: string;

  public constructor(options: GitAdapterErrorOptions) {
    super({
      errorCode: options.code,
      message: redactGitOutput(options.message),
      retryable: options.code === "COMMAND_FAILED",
      suggestedAction: "Inspect the explicit repository root, Git state, non-interactive credentials, and bounded output before retrying.",
      target: options.operation
    });
    this.name = "GitAdapterError";
    this.code = options.code;
    this.operation = options.operation;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.stderr !== undefined) this.stderr = redactGitOutput(options.stderr);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      message: this.message,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.stderr === undefined ? {} : { stderr: this.stderr })
    };
  }
}

export function gitAbortError(operation: string): DOMException {
  return new DOMException(`Git operation was cancelled: ${operation}`, "AbortError");
}
import { RemoteMcpError } from "@remote-mcp/contracts";


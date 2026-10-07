import { RemoteMcpError } from "@remote-mcp/contracts";
import {
  createSsrfGuard,
  isBlockedNetworkAddress,
  SsrfGuardError,
  type SecurityResolvedAddress,
  type SsrfGuard
} from "@remote-mcp/control-plane";

export type NetworkErrorCode =
  | "CONTENT_LENGTH_MISMATCH"
  | "CREDENTIALS_IN_URL"
  | "DESTINATION_EXISTS"
  | "HASH_MISMATCH"
  | "INVALID_RESPONSE"
  | "PRIVATE_NETWORK"
  | "REQUEST_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TLS_ERROR"
  | "TOO_MANY_REDIRECTS"
  | "UNSUPPORTED_PROTOCOL";

export type ResolvedAddress = SecurityResolvedAddress;

export interface UrlPolicyOptions {
  readonly allowPrivateNetwork?: boolean;
  readonly resolver?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export interface AllowedUrl {
  readonly url: URL;
  readonly addresses: readonly ResolvedAddress[];
}

const credentialInUrl = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu;
const sensitiveQuery = /([?&](?:access[-_]?token|api[-_]?key|key|password|secret|signature|sig|token)=)[^&#\s]+/giu;

export function redactNetworkText(value: string): string {
  return value
    .replace(credentialInUrl, "$1[REDACTED]@")
    .replace(sensitiveQuery, "$1[REDACTED]");
}

export class NetworkError extends RemoteMcpError {
  public readonly code: NetworkErrorCode;

  public constructor(code: NetworkErrorCode, message: string, target?: string) {
    super({
      errorCode: code,
      message: redactNetworkText(message),
      retryable: ["REQUEST_FAILED", "TIMEOUT", "TLS_ERROR"].includes(code),
      suggestedAction: "Inspect the validated URL, limits, network policy, and credential reference before retrying.",
      target: redactNetworkText(target ?? "network")
    });
    this.name = "NetworkError";
    this.code = code;
  }

  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, target: this.target };
  }
}

export function isPrivateAddress(address: string): boolean {
  return isBlockedNetworkAddress(address);
}

export interface UrlPolicy {
  assertAllowed(url: URL): Promise<AllowedUrl>;
}

export class DefaultUrlPolicy implements UrlPolicy {
  readonly #guard: SsrfGuard;

  public constructor(options: UrlPolicyOptions = {}) {
    this.#guard = createSsrfGuard(options);
  }

  public async assertAllowed(url: URL): Promise<AllowedUrl> {
    try {
      const allowed = await this.#guard.authorize(url);
      return { url: allowed.url, addresses: allowed.addresses };
    } catch (error) {
      if (error instanceof SsrfGuardError) {
        const code: NetworkErrorCode = error.code === "UNSUPPORTED_PROTOCOL"
          ? "UNSUPPORTED_PROTOCOL"
          : error.code === "CREDENTIALS_IN_URL"
            ? "CREDENTIALS_IN_URL"
            : error.code === "PRIVATE_NETWORK" || error.code === "DNS_REBINDING"
              ? "PRIVATE_NETWORK"
              : "REQUEST_FAILED";
        throw new NetworkError(code, error.message, error.target);
      }
      throw error;
    }
  }
}

export function createUrlPolicy(options: UrlPolicyOptions = {}): UrlPolicy {
  return new DefaultUrlPolicy(options);
}

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { RemoteMcpError } from "@remote-mcp/contracts";

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

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

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

const blockedNetworks = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4]
] as const) blockedNetworks.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) blockedNetworks.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? blockedNetworks.check(address, "ipv4")
    : family === 6
      ? blockedNetworks.check(address.split("%")[0] ?? address, "ipv6")
      : true;
}

export interface UrlPolicy {
  assertAllowed(url: URL): Promise<AllowedUrl>;
}

export class DefaultUrlPolicy implements UrlPolicy {
  readonly #allowPrivateNetwork: boolean;
  readonly #resolver: (hostname: string) => Promise<readonly ResolvedAddress[]>;

  public constructor(options: UrlPolicyOptions = {}) {
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.#resolver = options.resolver ?? (async (hostname) => {
      const literalFamily = isIP(hostname);
      if (literalFamily !== 0) return [{ address: hostname, family: literalFamily as 4 | 6 }];
      const resolved = await lookup(hostname, { all: true, verbatim: true });
      return resolved.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
    });
  }

  public async assertAllowed(url: URL): Promise<AllowedUrl> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new NetworkError("UNSUPPORTED_PROTOCOL", `Only HTTP and HTTPS URLs are allowed: ${url.protocol}`);
    }
    if (url.username || url.password) {
      const safe = new URL(url);
      safe.username = "[REDACTED]";
      safe.password = "";
      throw new NetworkError("CREDENTIALS_IN_URL", `Credentials must be supplied by reference, not in a URL: ${safe.toString()}`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (!hostname || hostname.toLowerCase() === "localhost") {
      if (!this.#allowPrivateNetwork) throw new NetworkError("PRIVATE_NETWORK", "Private network targets are not allowed", url.toString());
    }
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolver(hostname);
    } catch (error) {
      throw new NetworkError("REQUEST_FAILED", `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`, url.toString());
    }
    if (addresses.length === 0) throw new NetworkError("REQUEST_FAILED", "DNS resolution returned no addresses", url.toString());
    if (!this.#allowPrivateNetwork && addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new NetworkError("PRIVATE_NETWORK", "Private or reserved network targets are not allowed", url.toString());
    }
    return { url: new URL(url), addresses };
  }
}

export function createUrlPolicy(options: UrlPolicyOptions = {}): UrlPolicy {
  return new DefaultUrlPolicy(options);
}

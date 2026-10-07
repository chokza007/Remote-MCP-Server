import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { RemoteMcpError } from "@remote-mcp/contracts";

export interface SecurityResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface AuthorizedNetworkTarget {
  readonly url: URL;
  readonly addresses: readonly SecurityResolvedAddress[];
}

export type SsrfGuardErrorCode =
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_IN_URL"
  | "PRIVATE_NETWORK"
  | "DNS_FAILURE"
  | "DNS_REBINDING"
  | "AMBIGUOUS_URL";

export class SsrfGuardError extends RemoteMcpError {
  public readonly code: SsrfGuardErrorCode;

  public constructor(code: SsrfGuardErrorCode, message: string, target = "network") {
    super({
      errorCode: code,
      message,
      retryable: code === "DNS_FAILURE",
      suggestedAction: "Use an explicit public HTTP(S) destination and retry after DNS is stable.",
      target
    });
    this.name = "SsrfGuardError";
    this.code = code;
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4]
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) blocked.addSubnet(network, prefix, "ipv6");

export function isBlockedNetworkAddress(address: string): boolean {
  const withoutZone = address.split("%")[0] ?? address;
  const family = isIP(withoutZone);
  if (family === 4) return blocked.check(withoutZone, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(withoutZone);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      return isBlockedNetworkAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
    }
    return blocked.check(withoutZone, "ipv6");
  }
  return true;
}

export function assertUnambiguousWindowsPath(path: string): void {
  if (path.includes("\0")) throw new Error("Path contains a NUL byte");
  for (const part of path.split(/[\\/]/u)) {
    const normalized = part.normalize("NFKC");
    if (normalized !== part && /^(?:\.{1,2})$/u.test(normalized)) {
      throw new Error(`Ambiguous Unicode path component is not allowed: ${part}`);
    }
    if (/[\\/:]/u.test(normalized) && !/[\\/:]/u.test(part)) {
      throw new Error(`Ambiguous Unicode path separator is not allowed: ${part}`);
    }
  }
}

function assertUnambiguousUrlText(value: string): void {
  const normalized = value.normalize("NFKC");
  if (normalized !== value) {
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      const folded = character.normalize("NFKC");
      if (/[\\/:@.]/u.test(folded) && folded !== character) {
        throw new SsrfGuardError("AMBIGUOUS_URL", "URL contains an ambiguous Unicode delimiter");
      }
    }
  }
}

export class SsrfGuard {
  readonly #allowPrivateNetwork: boolean;
  readonly #resolver: (hostname: string) => Promise<readonly SecurityResolvedAddress[]>;

  public constructor(options: {
    readonly allowPrivateNetwork?: boolean;
    readonly resolver?: (hostname: string) => Promise<readonly SecurityResolvedAddress[]>;
  } = {}) {
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.#resolver = options.resolver ?? (async (hostname) => {
      const literal = isIP(hostname);
      if (literal !== 0) return [{ address: hostname, family: literal as 4 | 6 }];
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
    });
  }

  public async authorize(input: string | URL): Promise<AuthorizedNetworkTarget> {
    const raw = typeof input === "string" ? input : input.href;
    assertUnambiguousUrlText(raw);
    const url = new URL(raw);
    if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) {
      throw new SsrfGuardError("UNSUPPORTED_PROTOCOL", `Only HTTP and HTTPS are allowed: ${url.protocol}`, url.href);
    }
    if (url.username || url.password) {
      throw new SsrfGuardError("CREDENTIALS_IN_URL", "Credentials must be supplied by reference", `${url.protocol}//${url.host}`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (!hostname || hostname.toLowerCase() === "localhost") {
      if (!this.#allowPrivateNetwork) throw new SsrfGuardError("PRIVATE_NETWORK", "Private network targets are not allowed", url.href);
    }
    let addresses: readonly SecurityResolvedAddress[];
    try {
      addresses = await this.#resolver(hostname);
    } catch (error) {
      throw new SsrfGuardError("DNS_FAILURE", `DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`, url.href);
    }
    if (addresses.length === 0) throw new SsrfGuardError("DNS_FAILURE", "DNS resolution returned no addresses", url.href);
    if (!this.#allowPrivateNetwork && addresses.some((entry) => isBlockedNetworkAddress(entry.address))) {
      throw new SsrfGuardError("PRIVATE_NETWORK", "Private or reserved network targets are not allowed", url.href);
    }
    return Object.freeze({
      url: new URL(url.href),
      addresses: Object.freeze(addresses.map((entry) => Object.freeze({ ...entry })))
    });
  }

  public assertConnectionAddress(target: AuthorizedNetworkTarget, connectedAddress: string): void {
    if (!this.#allowPrivateNetwork && isBlockedNetworkAddress(connectedAddress)) {
      throw new SsrfGuardError("DNS_REBINDING", "Connected address changed to a blocked address", target.url.href);
    }
    const allowed = new Set(target.addresses.map((entry) => entry.address.toLowerCase()));
    if (!allowed.has(connectedAddress.toLowerCase())) {
      throw new SsrfGuardError("DNS_REBINDING", "Connected address does not match the pinned DNS result", target.url.href);
    }
  }
}

export function createSsrfGuard(options: ConstructorParameters<typeof SsrfGuard>[0] = {}): SsrfGuard {
  return new SsrfGuard(options);
}

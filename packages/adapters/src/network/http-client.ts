import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { DEFAULT_SECURITY_LIMITS } from "@remote-mcp/control-plane";

import { NetworkError, type UrlPolicy, createUrlPolicy, redactNetworkText } from "./url-policy.js";

export interface HttpRequestInput {
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialReference?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponseResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly finalUrl: string;
  readonly redirects: number;
}

export interface HttpServiceOptions {
  readonly urlPolicy?: UrlPolicy;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxResponseBytes?: number;
  readonly defaultMaxRedirects?: number;
  readonly credentialProvider?: HttpCredentialProvider;
}

export interface HttpCredentialProvider {
  resolve(reference: string): Promise<Readonly<Record<string, string>>>;
}

export interface HttpService {
  request(input: HttpRequestInput): Promise<HttpResponseResult>;
}

function abortError(): DOMException {
  return new DOMException("HTTP request was cancelled", "AbortError");
}

function safeHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    output[name.toLowerCase()] = ["set-cookie", "authorization", "proxy-authenticate"].includes(name.toLowerCase())
      ? "[REDACTED]"
      : Array.isArray(value) ? value.join(", ") : value;
  }
  return output;
}

function withoutCrossOriginCredentials(headers: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase()))
  );
}

export class NodeHttpService implements HttpService {
  readonly #policy: UrlPolicy;
  readonly #defaultTimeoutMs: number;
  readonly #defaultMaxResponseBytes: number;
  readonly #defaultMaxRedirects: number;
  readonly #credentialProvider: HttpCredentialProvider | undefined;

  public constructor(options: HttpServiceOptions = {}) {
    this.#policy = options.urlPolicy ?? createUrlPolicy();
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#defaultMaxResponseBytes = options.defaultMaxResponseBytes ?? DEFAULT_SECURITY_LIMITS.maxResponseBytes;
    this.#defaultMaxRedirects = options.defaultMaxRedirects ?? 5;
    this.#credentialProvider = options.credentialProvider;
  }

  public async request(input: HttpRequestInput): Promise<HttpResponseResult> {
    if (input.signal?.aborted) throw abortError();
    const timeoutMs = input.timeoutMs ?? this.#defaultTimeoutMs;
    const maxBytes = input.maxResponseBytes ?? this.#defaultMaxResponseBytes;
    const maxRedirects = input.maxRedirects ?? this.#defaultMaxRedirects;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new NetworkError("REQUEST_FAILED", "Timeout must be a positive integer");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new NetworkError("REQUEST_FAILED", "Response limit must be a non-negative integer");
    let credentialHeaders: Readonly<Record<string, string>> = {};
    if (input.credentialReference !== undefined) {
      if (!this.#credentialProvider) throw new NetworkError("REQUEST_FAILED", "No HTTP credential provider is configured");
      credentialHeaders = await this.#credentialProvider.resolve(input.credentialReference);
    }
    const effectiveInput: HttpRequestInput = {
      ...input,
      headers: { ...input.headers, ...credentialHeaders }
    };
    return this.follow(new URL(input.url), effectiveInput, 0, timeoutMs, maxBytes, maxRedirects);
  }

  private async follow(
    url: URL,
    input: HttpRequestInput,
    redirects: number,
    timeoutMs: number,
    maxBytes: number,
    maxRedirects: number
  ): Promise<HttpResponseResult> {
    const allowed = await this.#policy.assertAllowed(url);
    if (input.signal?.aborted) throw abortError();
    const address = allowed.addresses[0];
    if (!address) throw new NetworkError("REQUEST_FAILED", "No validated address is available", url.toString());
    const lookup: LookupFunction = (_hostname, _options, callback) => callback(null, address.address, address.family);

    const response = await new Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>((resolve, reject) => {
      const requestFunction = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requestFunction(url, {
        method: input.method ?? "GET",
        headers: input.headers,
        lookup
      });
      let settled = false;
      const chunks: Buffer[] = [];
      let received = 0;
      let expectedLength: number | undefined;
      const finishError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        request.destroy();
        reject(error);
      };
      const onAbort = (): void => finishError(abortError());
      const timer = setTimeout(() => finishError(new NetworkError("TIMEOUT", `HTTP request timed out after ${timeoutMs}ms`, url.toString())), timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      request.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        const tls = url.protocol === "https:" && (error.code?.includes("CERT") || error.code?.includes("TLS") || error.code === "EPROTO");
        finishError(new NetworkError(tls ? "TLS_ERROR" : "REQUEST_FAILED", error.message, url.toString()));
      });
      request.once("response", (incoming) => {
        const contentLength = incoming.headers["content-length"];
        if (contentLength !== undefined && (input.method ?? "GET") !== "HEAD") {
          expectedLength = Number(contentLength);
          if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
            finishError(new NetworkError("INVALID_RESPONSE", "Invalid Content-Length response header", url.toString()));
            return;
          }
          if (expectedLength > maxBytes) {
            finishError(new NetworkError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`, url.toString()));
            return;
          }
        }
        incoming.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            incoming.destroy();
            finishError(new NetworkError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`, url.toString()));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("aborted", () => finishError(new NetworkError("CONTENT_LENGTH_MISMATCH", "Response ended before Content-Length bytes arrived", url.toString())));
        incoming.once("error", (error) => finishError(new NetworkError("REQUEST_FAILED", error.message, url.toString())));
        incoming.once("end", () => {
          if (settled) return;
          if (expectedLength !== undefined && expectedLength !== received) {
            finishError(new NetworkError("CONTENT_LENGTH_MISMATCH", `Expected ${expectedLength} bytes but received ${received}`, url.toString()));
            return;
          }
          settled = true;
          cleanup();
          resolve({ status: incoming.statusCode ?? 0, headers: safeHeaders(incoming.headers), body: Buffer.concat(chunks) });
        });
      });
      request.end();
    });

    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= maxRedirects) throw new NetworkError("TOO_MANY_REDIRECTS", `Redirect limit ${maxRedirects} exceeded`, url.toString());
      const next = new URL(response.headers.location, url);
      const redirectedInput = next.origin === url.origin
        ? input
        : { ...input, headers: withoutCrossOriginCredentials(input.headers) };
      return this.follow(next, redirectedInput, redirects + 1, timeoutMs, maxBytes, maxRedirects);
    }
    return { ...response, finalUrl: redactNetworkText(url.toString()), redirects };
  }
}

export function createHttpService(options: HttpServiceOptions = {}): HttpService {
  return new NodeHttpService(options);
}

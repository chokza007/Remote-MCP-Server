import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { RemoteMcpError } from "@remote-mcp/contracts";

import { canonicalJson, type PrivilegedRequest } from "./capability-token.js";

export interface PrivilegedResult {
  readonly ok: true;
  readonly result: unknown;
  readonly auditId?: string;
}

export interface BrokerClientOptions {
  readonly pipeName: string;
  readonly sharedSecret: string;
  readonly timeoutMs?: number;
  readonly maxFrameBytes?: number;
}

interface BrokerResponse {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly auditId?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly transportNonce?: string;
  readonly brokerProof?: string;
}

export function encodeBrokerFrame(value: unknown, maxFrameBytes = 1_048_576): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length < 1 || body.length > maxFrameBytes) {
    throw new Error(`Broker frame size is invalid: ${body.length}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class BrokerFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(options: { readonly maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  }

  public push(chunk: Uint8Array): readonly unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length < 1 || length > this.#maxFrameBytes) {
        this.#buffer = Buffer.alloc(0);
        throw new Error(`Broker frame is too large or invalid: ${length}`);
      }
      if (this.#buffer.length < length + 4) break;
      const body = this.#buffer.subarray(4, length + 4).toString("utf8");
      this.#buffer = this.#buffer.subarray(length + 4);
      try {
        values.push(JSON.parse(body) as unknown);
      } catch {
        throw new Error("Broker frame contains malformed JSON");
      }
    }
    return values;
  }
}

export class BrokerClient {
  readonly #pipeName: string;
  readonly #timeoutMs: number;
  readonly #maxFrameBytes: number;
  readonly #sharedSecret: Buffer;

  public constructor(options: BrokerClientOptions) {
    if (options.pipeName.trim().length === 0) throw new Error("Broker pipe name must not be empty");
    const sharedSecret = Buffer.from(options.sharedSecret, "base64");
    if (sharedSecret.length !== 32) throw new Error("Broker shared secret must contain 32 bytes");
    this.#pipeName = options.pipeName;
    this.#sharedSecret = sharedSecret;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  }

  public async execute(request: PrivilegedRequest): Promise<PrivilegedResult> {
    const requestId = randomUUID();
    const transportNonce = randomUUID();
    const unsignedEnvelope = { protocolVersion: 1, requestId, ...request, transportNonce };
    const envelope = { ...unsignedEnvelope, clientProof: this.proof(unsignedEnvelope) };
    const frame = encodeBrokerFrame(envelope, this.#maxFrameBytes);
    return new Promise<PrivilegedResult>((resolve, reject) => {
      const decoder = new BrokerFrameDecoder({ maxFrameBytes: this.#maxFrameBytes });
      const deadline = Date.now() + this.#timeoutMs;
      let socket: Socket | undefined;
      let settled = false;
      const finish = (error?: unknown, response?: BrokerResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.destroy();
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (!response || response.requestId !== requestId) {
          reject(new Error("Broker returned a mismatched response"));
          return;
        }
        if (response.transportNonce !== transportNonce || response.brokerProof === undefined) {
          reject(new Error("Broker response authentication proof is missing or mismatched"));
          return;
        }
        const { brokerProof, ...unsignedResponse } = response;
        const expectedProof = this.proof(unsignedResponse);
        const presented = Buffer.from(brokerProof, "base64");
        const expected = Buffer.from(expectedProof, "base64");
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          reject(new Error("Broker response authentication proof is invalid"));
          return;
        }
        if (!response.ok) {
          reject(new RemoteMcpError({
            errorCode: response.error?.code ?? "BROKER_DENIED",
            message: response.error?.message ?? "Privileged broker denied the request",
            retryable: false,
            suggestedAction: "Inspect the broker audit and refresh authorization state before retrying.",
            target: request.action
          }));
          return;
        }
        resolve({
          ok: true,
          result: response.result,
          ...(response.auditId === undefined ? {} : { auditId: response.auditId })
        });
      };
      const timer = setTimeout(() => finish(new Error("Privileged broker request timeout")), this.#timeoutMs);
      const connect = (): void => {
        if (settled) return;
        const candidate = createConnection(`\\\\.\\pipe\\${this.#pipeName}`);
        socket = candidate;
        candidate.once("connect", () => candidate.write(frame));
        candidate.on("data", (chunk) => {
          try {
            for (const value of decoder.push(chunk)) finish(undefined, value as BrokerResponse);
          } catch (error) {
            finish(error);
          }
        });
        candidate.once("error", (error: NodeJS.ErrnoException) => {
          if (!settled && ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") && Date.now() + 25 < deadline) {
            candidate.destroy();
            setTimeout(connect, 25).unref();
            return;
          }
          finish(new RemoteMcpError({
            errorCode: "BROKER_DISCONNECTED",
            message: `Privileged broker connection failed: ${error.message}`,
            retryable: true,
            suggestedAction: "Start or repair the privileged broker service, then retry.",
            target: this.#pipeName,
            cause: error
          }));
        });
        candidate.once("end", () => finish(new Error("Privileged broker disconnected before responding")));
      };
      connect();
    });
  }

  private proof(value: unknown): string {
    return createHmac("sha256", this.#sharedSecret)
      .update(canonicalJson(value), "utf8")
      .digest("base64");
  }
}

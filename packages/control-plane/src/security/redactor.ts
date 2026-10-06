import { SecretFingerprints, type Disposable } from "./secret-fingerprints.js";

export type RedactedValue = unknown;

const sensitiveKey = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/iu;

export class Redactor {
  readonly #fingerprints = new SecretFingerprints();

  public registerEphemeral(secret: string): Disposable {
    return this.#fingerprints.register(secret);
  }

  public redact(value: unknown): RedactedValue {
    return this.redactValue(value, new WeakMap<object, unknown>());
  }

  private redactText(value: string): string {
    return this.#fingerprints
      .redact(value)
      .replace(/(https?:\/\/)[^\/\s:@]+:[^\/\s@]+@/giu, "$1[REDACTED]@")
      .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]")
      .replace(
        /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s\r\n]+)/gu,
        "$1=[REDACTED]"
      )
      .replace(
        /(--(?:password|passwd|token|secret|api-key))(\s+|=)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
        "$1$2[REDACTED]"
      );
  }

  private redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return "[REDACTED_BINARY]";
    }
    const previous = seen.get(value);
    if (previous) {
      return previous;
    }
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      seen.set(value, output);
      for (const item of value) {
        output.push(this.redactValue(item, seen));
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sensitiveKey.test(key)
        ? "[REDACTED]"
        : this.redactValue(entryValue, seen);
    }
    return output;
  }
}

export function createRedactor(): Redactor {
  return new Redactor();
}

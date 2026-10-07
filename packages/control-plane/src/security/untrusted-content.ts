import { createHash } from "node:crypto";

export type UntrustedSourceKind = "filesystem" | "web" | "document" | "tool" | "user_supplied";

export interface UntrustedSource {
  readonly kind: UntrustedSourceKind;
  readonly location: string;
}

export interface UntrustedContent<T> {
  readonly trust: "untrusted";
  readonly source: UntrustedSource;
  readonly contentHash: string;
  readonly value: T;
}

const authenticWrappers = new WeakSet<object>();

function serialized(value: unknown): string {
  const result = JSON.stringify(value);
  return result === undefined ? String(value) : result;
}

export function wrapUntrustedContent<T>(input: {
  readonly source: UntrustedSource;
  readonly value: T;
}): UntrustedContent<T> {
  if (input.source.location.trim().length === 0) throw new Error("Untrusted content source must not be empty");
  const valueText = serialized(input.value);
  const wrapper: UntrustedContent<T> = Object.freeze({
    trust: "untrusted",
    source: Object.freeze({ ...input.source }),
    contentHash: createHash("sha256").update(valueText, "utf8").digest("hex"),
    value: input.value
  });
  authenticWrappers.add(wrapper);
  return wrapper;
}

export function isUntrustedContent(value: unknown): value is UntrustedContent<unknown> {
  return typeof value === "object" && value !== null && authenticWrappers.has(value);
}

export function unwrapUntrustedData<T>(content: UntrustedContent<T>): T {
  if (!isUntrustedContent(content)) throw new Error("Untrusted content wrapper provenance is invalid");
  return content.value;
}

export function renderUntrustedForModel(content: UntrustedContent<unknown>): string {
  if (!isUntrustedContent(content)) throw new Error("Untrusted content wrapper provenance is invalid");
  const source = `${content.source.kind}:${content.source.location}`.replace(/[\r\n\]]/gu, "_");
  return `[UNTRUSTED_DATA source=${source}]\n${serialized(content.value)}\n[/UNTRUSTED_DATA]`;
}

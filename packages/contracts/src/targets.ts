import { realpath } from "node:fs/promises";
import { win32 } from "node:path";

export type TargetKind = "path" | "url" | "process" | "service" | "port" | "opaque";

export interface TargetInput {
  readonly kind: TargetKind;
  readonly value: string;
  readonly followSymlinks?: boolean;
}

export interface CanonicalTarget {
  readonly kind: TargetKind;
  readonly canonical: string;
  readonly display: string;
  readonly identityKey: string;
}

function stripExtendedPathPrefix(value: string): string {
  if (value.toLowerCase().startsWith("\\\\?\\unc\\")) {
    return `\\\\${value.slice(8)}`;
  }

  if (value.startsWith("\\\\?\\")) {
    return value.slice(4);
  }

  return value;
}

function normalizeDriveLetter(value: string): string {
  if (/^[a-z]:/u.test(value)) {
    return `${value[0]?.toUpperCase()}${value.slice(1)}`;
  }

  return value;
}

function normalizePath(value: string): string {
  const withoutPrefix = stripExtendedPathPrefix(value);
  if (/^[a-zA-Z]:[^\\/]/u.test(withoutPrefix)) {
    throw new Error(`Drive-relative paths are ambiguous: ${value}`);
  }

  return normalizeDriveLetter(win32.normalize(withoutPrefix));
}

function normalizeOpaque(kind: Exclude<TargetKind, "path" | "url">, value: string): CanonicalTarget {
  const canonical = value.trim();
  if (canonical.length === 0) {
    throw new Error(`${kind} target must not be empty`);
  }

  return {
    kind,
    canonical,
    display: canonical,
    identityKey: `${kind}:${canonical.toLowerCase()}`
  };
}

export async function canonicalizeTarget(input: TargetInput | string): Promise<CanonicalTarget> {
  const target: TargetInput =
    typeof input === "string" ? { kind: "path", value: input } : input;

  if (target.kind === "url") {
    const url = new URL(target.value);
    const canonical = url.href;
    return {
      kind: "url",
      canonical,
      display: canonical,
      identityKey: `url:${canonical}`
    };
  }

  if (target.kind !== "path") {
    return normalizeOpaque(target.kind, target.value);
  }

  let canonical = normalizePath(target.value);
  if (target.followSymlinks === true) {
    canonical = normalizePath(await realpath(canonical));
  }

  return {
    kind: "path",
    canonical,
    display: canonical,
    identityKey: `path:${canonical.toLowerCase()}`
  };
}

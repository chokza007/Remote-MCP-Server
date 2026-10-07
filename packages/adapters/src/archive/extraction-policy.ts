import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";
import { DEFAULT_SECURITY_LIMITS } from "@remote-mcp/control-plane";

export type ArchiveErrorCode =
  | "ABSOLUTE_PATH"
  | "CASE_COLLISION"
  | "COMPRESSION_RATIO"
  | "DESTINATION_EXISTS"
  | "DUPLICATE_ENTRY"
  | "ENTRY_LIMIT"
  | "EXPANDED_SIZE_LIMIT"
  | "INVALID_ARCHIVE"
  | "PATH_TRAVERSAL"
  | "UNSAFE_LINK";

export class ArchiveError extends RemoteMcpError {
  public readonly code: ArchiveErrorCode;
  public readonly entry?: string;

  public constructor(code: ArchiveErrorCode, message: string, entry?: string) {
    super({
      errorCode: code,
      message,
      retryable: code === "DESTINATION_EXISTS",
      suggestedAction: "Inspect the archive policy violation and choose a safe explicit destination or corrected archive.",
      target: entry ?? "archive"
    });
    this.name = "ArchiveError";
    this.code = code;
    if (entry !== undefined) this.entry = entry;
  }

  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, ...(this.entry === undefined ? {} : { entry: this.entry }) };
  }
}

export interface ArchivePolicyOptions {
  readonly maxEntries?: number;
  readonly maxExpandedBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxCompressionRatio?: number;
}

export interface RawArchiveEntry {
  readonly path: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
  readonly encrypted: boolean;
}

export interface ValidatedArchiveEntry extends RawArchiveEntry {
  readonly normalizedPath: string;
}

export interface ExtractionPolicy {
  validate(entries: readonly RawArchiveEntry[]): readonly ValidatedArchiveEntry[];
}

function normalizedEntryPath(path: string): string {
  if (path.includes("\0")) throw new ArchiveError("PATH_TRAVERSAL", "Archive entry contains a NUL byte", path);
  const forward = path.replaceAll("\\", "/");
  if (forward.startsWith("/") || forward.startsWith("//") || /^[a-z]:\//iu.test(forward) || isAbsolute(forward)) {
    throw new ArchiveError("ABSOLUTE_PATH", "Archive entry uses an absolute path", path);
  }
  const parts = forward.split("/");
  if (parts.some((part) => part === "..") || parts[0]?.includes(":")) {
    throw new ArchiveError("PATH_TRAVERSAL", "Archive entry escapes the destination", path);
  }
  const normalized = normalize(forward).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ArchiveError("PATH_TRAVERSAL", "Archive entry has an invalid path", path);
  }
  return normalized;
}

export class DefaultExtractionPolicy implements ExtractionPolicy {
  readonly #maxEntries: number;
  readonly #maxExpandedBytes: number;
  readonly #maxEntryBytes: number;
  readonly #maxCompressionRatio: number;

  public constructor(options: ArchivePolicyOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_SECURITY_LIMITS.maxArchiveEntries;
    this.#maxExpandedBytes = options.maxExpandedBytes ?? DEFAULT_SECURITY_LIMITS.maxArchiveExpandedBytes;
    this.#maxEntryBytes = options.maxEntryBytes ?? 512 * 1024 * 1024;
    this.#maxCompressionRatio = options.maxCompressionRatio ?? DEFAULT_SECURITY_LIMITS.maxArchiveCompressionRatio;
  }

  public validate(entries: readonly RawArchiveEntry[]): readonly ValidatedArchiveEntry[] {
    if (entries.length > this.#maxEntries) throw new ArchiveError("ENTRY_LIMIT", `Archive contains more than ${this.#maxEntries} entries`);
    const exact = new Set<string>();
    const folded = new Map<string, string>();
    let expanded = 0;
    const validated = entries.map((entry) => {
      const normalizedPath = normalizedEntryPath(entry.path).replace(/\/$/u, "");
      if (entry.symbolicLink) throw new ArchiveError("UNSAFE_LINK", "Archive symbolic links are not allowed", entry.path);
      if (entry.encrypted) throw new ArchiveError("INVALID_ARCHIVE", "Encrypted archive entries are not supported", entry.path);
      if (exact.has(normalizedPath)) throw new ArchiveError("DUPLICATE_ENTRY", "Archive contains a duplicate entry", entry.path);
      exact.add(normalizedPath);
      const key = normalizedPath.toLocaleLowerCase("en-US");
      const previous = folded.get(key);
      if (previous !== undefined && previous !== normalizedPath) {
        throw new ArchiveError("CASE_COLLISION", `Archive entries collide by case: ${previous} and ${normalizedPath}`, entry.path);
      }
      folded.set(key, normalizedPath);
      if (entry.uncompressedSize > this.#maxEntryBytes) throw new ArchiveError("EXPANDED_SIZE_LIMIT", "Archive entry exceeds the per-entry size limit", entry.path);
      expanded += entry.uncompressedSize;
      if (expanded > this.#maxExpandedBytes) throw new ArchiveError("EXPANDED_SIZE_LIMIT", "Archive exceeds the expanded-size limit", entry.path);
      const ratio = entry.uncompressedSize === 0 ? 0 : entry.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedSize / entry.compressedSize;
      if (ratio > this.#maxCompressionRatio) throw new ArchiveError("COMPRESSION_RATIO", "Archive entry exceeds the compression-ratio limit", entry.path);
      return { ...entry, normalizedPath };
    });
    const byPath = new Map(validated.map((entry) => [entry.normalizedPath.toLocaleLowerCase("en-US"), entry]));
    for (const entry of validated) {
      const parts = entry.normalizedPath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join("/");
        const parent = byPath.get(ancestor.toLocaleLowerCase("en-US"));
        if (parent && !parent.directory) {
          throw new ArchiveError("CASE_COLLISION", `Archive file is also a parent directory: ${parent.normalizedPath}`, entry.path);
        }
      }
    }
    return validated;
  }
}

export function createExtractionPolicy(options: ArchivePolicyOptions = {}): ExtractionPolicy {
  return new DefaultExtractionPolicy(options);
}

export function assertArchiveTarget(destination: string, entry: string): string {
  const root = resolve(destination);
  const target = resolve(root, entry);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ArchiveError("PATH_TRAVERSAL", "Archive target escapes the canonical destination", entry);
  }
  return target;
}

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { unzipSync, zipSync } from "fflate";

import {
  ArchiveError,
  assertArchiveTarget,
  createExtractionPolicy,
  type ArchivePolicyOptions,
  type ExtractionPolicy,
  type RawArchiveEntry,
  type ValidatedArchiveEntry
} from "./extraction-policy.js";

export interface ArchiveEntry {
  readonly path: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly directory: boolean;
}

export interface ArchiveCreateEntry {
  readonly source: string;
  readonly path: string;
}

export interface ArchiveCreateInput {
  readonly archive: string;
  readonly entries: readonly ArchiveCreateEntry[];
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
}

export interface ArchiveExtractInput {
  readonly archive: string;
  readonly destination: string;
  readonly overwrite?: boolean;
  readonly dryRun?: boolean;
}

export interface ArchiveMutationResult {
  readonly operation: "create" | "extract";
  readonly archive: string;
  readonly destination: string;
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly entries: number;
}

export interface ArchiveVerification {
  readonly valid: boolean;
  readonly entries: number;
  readonly expandedBytes: number;
  readonly sha256: string;
}

export interface ArchiveServiceOptions extends ArchivePolicyOptions {
  readonly extractionPolicy?: ExtractionPolicy;
}

export interface ArchiveService {
  list(archive: string): Promise<readonly ArchiveEntry[]>;
  create(input: ArchiveCreateInput): Promise<ArchiveMutationResult>;
  extract(input: ArchiveExtractInput): Promise<ArchiveMutationResult>;
  verify(archive: string): Promise<ArchiveVerification>;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ArchiveError("INVALID_ARCHIVE", "ZIP end-of-central-directory record was not found");
}

function parseCentralDirectory(data: Buffer): RawArchiveEntry[] {
  const end = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(end + 10);
  const centralOffset = data.readUInt32LE(end + 16);
  const entries: RawArchiveEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new ArchiveError("INVALID_ARCHIVE", "ZIP central directory is malformed");
    }
    const madeBy = data.readUInt16LE(offset + 4);
    const flags = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttributes = data.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > data.length) throw new ArchiveError("INVALID_ARCHIVE", "ZIP entry name exceeds the archive bounds");
    const path = data.subarray(nameStart, nameEnd).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    entries.push({
      path,
      compressedSize,
      uncompressedSize,
      directory: path.endsWith("/"),
      symbolicLink: (unixMode & 0xf000) === 0xa000,
      encrypted: (flags & 1) !== 0
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function decompress(data: Buffer, entries: readonly ValidatedArchiveEntry[]): Record<string, Uint8Array> {
  try {
    return unzipSync(data, {
      filter: (entry) => entries.some((validated) => validated.path === entry.name && !validated.directory)
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("INVALID_ARCHIVE", `ZIP decompression failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateArchiveData(data: Buffer, policy: ExtractionPolicy): readonly ValidatedArchiveEntry[] {
  try {
    return policy.validate(parseCentralDirectory(data));
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("INVALID_ARCHIVE", `ZIP metadata is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function canonicalDestination(path: string): Promise<string> {
  const unresolved: string[] = [];
  let cursor = resolve(path);
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    unresolved.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  const base = await realpath(cursor).catch(() => cursor);
  return resolve(base, ...unresolved);
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  let cursor = target;
  const ancestors: string[] = [];
  while (cursor.length >= root.length) {
    ancestors.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of ancestors.reverse()) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) throw new ArchiveError("UNSAFE_LINK", "Extraction path contains an existing symbolic link", candidate);
      if (candidate !== target && !metadata.isDirectory()) {
        throw new ArchiveError("DESTINATION_EXISTS", "Extraction parent path is not a directory", candidate);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class ZipArchiveService implements ArchiveService {
  readonly #policy: ExtractionPolicy;

  public constructor(options: ArchiveServiceOptions = {}) {
    this.#policy = options.extractionPolicy ?? createExtractionPolicy(options);
  }

  public async list(archive: string): Promise<readonly ArchiveEntry[]> {
    const entries = await this.validatedEntries(archive);
    return entries.map((entry) => ({
      path: entry.normalizedPath,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      directory: entry.directory
    }));
  }

  public async create(input: ArchiveCreateInput): Promise<ArchiveMutationResult> {
    const archive = resolve(input.archive);
    if ((await exists(archive)) && !input.overwrite) throw new ArchiveError("DESTINATION_EXISTS", `Archive destination already exists: ${archive}`);
    const rawEntries: RawArchiveEntry[] = [];
    const contents: Record<string, Uint8Array> = {};
    for (const entry of input.entries) {
      const metadata = await lstat(resolve(entry.source));
      if (metadata.isSymbolicLink()) throw new ArchiveError("UNSAFE_LINK", "Archive sources must not be symbolic links", entry.source);
      if (!metadata.isFile()) throw new ArchiveError("INVALID_ARCHIVE", "Archive sources must be regular files", entry.source);
      rawEntries.push({ path: entry.path, compressedSize: metadata.size, uncompressedSize: metadata.size, directory: false, symbolicLink: false, encrypted: false });
    }
    this.#policy.validate(rawEntries);
    for (const entry of input.entries) {
      const data = await readFile(resolve(entry.source));
      contents[entry.path.replaceAll("\\", "/")] = data;
    }
    const archiveData = Buffer.from(zipSync(contents, { level: 6 }));
    const validated = validateArchiveData(archiveData, this.#policy);
    if (input.dryRun) return { operation: "create", archive, destination: archive, dryRun: true, changed: false, entries: validated.length };
    const temporary = `${archive}.remote-mcp-${randomUUID()}.tmp`;
    const backup = `${archive}.remote-mcp-${randomUUID()}.backup`;
    let backupCreated = false;
    await mkdir(dirname(archive), { recursive: true });
    try {
      await writeFile(temporary, archiveData, { flag: "wx" });
      if (await exists(archive)) {
        await rename(archive, backup);
        backupCreated = true;
      }
      await rename(temporary, archive);
      if (backupCreated) await rm(backup, { force: true });
    } catch (error) {
      if (backupCreated && !(await exists(archive)) && (await exists(backup))) await rename(backup, archive);
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(backup, { force: true }).catch(() => undefined);
    }
    return { operation: "create", archive, destination: archive, dryRun: false, changed: true, entries: validated.length };
  }

  public async extract(input: ArchiveExtractInput): Promise<ArchiveMutationResult> {
    const archive = resolve(input.archive);
    const data = await readFile(archive);
    const entries = validateArchiveData(data, this.#policy);
    const destination = await canonicalDestination(input.destination);
    const targets = entries.map((entry) => ({ entry, target: assertArchiveTarget(destination, entry.normalizedPath) }));
    for (const { entry, target } of targets) {
      await assertNoSymlinkPath(destination, target);
      if (await exists(target)) {
        const targetMetadata = await lstat(target);
        if (entry.directory && !targetMetadata.isDirectory()) {
          throw new ArchiveError("DESTINATION_EXISTS", `Extraction directory target is occupied by a file: ${target}`, entry.path);
        }
        if (!entry.directory && (!input.overwrite || !targetMetadata.isFile())) {
          throw new ArchiveError("DESTINATION_EXISTS", `Extraction target already exists: ${target}`, entry.path);
        }
      }
    }
    if (input.dryRun) return { operation: "extract", archive, destination, dryRun: true, changed: false, entries: entries.length };
    const decompressed = decompress(data, entries);
    await mkdir(destination, { recursive: true });
    for (const { entry, target } of targets) {
      if (entry.directory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const content = decompressed[entry.path];
      if (!content) throw new ArchiveError("INVALID_ARCHIVE", "ZIP entry could not be decompressed", entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: input.overwrite ? "w" : "wx" });
    }
    return { operation: "extract", archive, destination, dryRun: false, changed: true, entries: entries.length };
  }

  public async verify(archive: string): Promise<ArchiveVerification> {
    const path = resolve(archive);
    const data = await readFile(path);
    const entries = validateArchiveData(data, this.#policy);
    const expanded = decompress(data, entries);
    const expandedBytes = Object.values(expanded).reduce((total, value) => total + value.length, 0);
    return {
      valid: true,
      entries: entries.length,
      expandedBytes,
      sha256: createHash("sha256").update(data).digest("hex")
    };
  }

  private async validatedEntries(archive: string): Promise<readonly ValidatedArchiveEntry[]> {
    return validateArchiveData(await readFile(resolve(archive)), this.#policy);
  }
}

export function createArchiveService(options: ArchiveServiceOptions = {}): ArchiveService {
  return new ZipArchiveService(options);
}

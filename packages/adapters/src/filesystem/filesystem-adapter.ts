import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path";

import { canonicalizeTarget } from "@remote-mcp/contracts";

import type {
  ApplyPatchInput,
  FilesystemAdapter,
  FilesystemAdapterOptions,
  FilesystemEntry,
  FilesystemStat,
  HashInput,
  HashResult,
  LinkResult,
  ListInput,
  MutationResult,
  PathInput,
  PermissionResult,
  ReadRangeInput,
  ReadRangeResult,
  RecycleResult,
  RemoveInput,
  RenameInput,
  TransferInput,
  WriteInput
} from "./contracts.js";
import { readFilesystemStat, readLinkMetadata, readPermissions } from "./metadata.js";
import { applyExactTextEdits } from "./patcher.js";

function normalizeForComparison(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, "").toLowerCase();
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The filesystem operation was cancelled", "AbortError");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function mutation(
  operation: string,
  dryRun: boolean,
  changed: boolean,
  source?: string,
  destination?: string
): MutationResult {
  return {
    operation,
    dryRun,
    changed,
    ...(source === undefined ? {} : { source }),
    ...(destination === undefined ? {} : { destination })
  };
}

export class NodeFilesystemAdapter implements FilesystemAdapter {
  readonly #allowedRoots: readonly string[];
  readonly #resolvedAllowedRoots: Promise<readonly string[]>;
  readonly #recycleDirectory: string;
  readonly #maxReadBytes: number;
  readonly #beforeAtomicCommit?: FilesystemAdapterOptions["beforeAtomicCommit"];

  public constructor(options: FilesystemAdapterOptions = {}) {
    this.#allowedRoots = (options.allowedRoots ?? []).map((root) => resolve(root));
    this.#resolvedAllowedRoots = Promise.all(
      this.#allowedRoots.map(async (root) => realpath(root).catch(() => root))
    );
    this.#recycleDirectory = resolve(
      options.recycleDirectory ??
        join(process.env.LOCALAPPDATA ?? tmpdir(), "RemoteMCP", "Recoverable-Recycle")
    );
    this.#maxReadBytes = options.maxReadBytes ?? 4 * 1024 * 1024;
    this.#beforeAtomicCommit = options.beforeAtomicCommit;
  }

  public async list(input: ListInput): Promise<readonly FilesystemEntry[]> {
    abortIfNeeded(input.signal);
    const root = await this.safePath(input.path);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new Error(`List target is not a directory: ${root}`);
    const output: FilesystemEntry[] = [];
    const maxDepth = Math.min(Math.max(input.maxDepth ?? 16, 0), 64);

    const visit = async (directory: string, depth: number): Promise<void> => {
      abortIfNeeded(input.signal);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        abortIfNeeded(input.signal);
        const path = join(directory, entry.name);
        const metadata = await readFilesystemStat(path);
        output.push(metadata);
        if (input.recursive && entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth) {
          await visit(path, depth + 1);
        }
      }
    };
    await visit(root, 0);
    return output.sort((left, right) => left.path.localeCompare(right.path, "en"));
  }

  public async stat(input: PathInput): Promise<FilesystemStat> {
    abortIfNeeded(input.signal);
    return readFilesystemStat(await this.safePath(input.path));
  }

  public async readRange(input: ReadRangeInput): Promise<ReadRangeResult> {
    abortIfNeeded(input.signal);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error("Read offset must be non-negative");
    if (!Number.isSafeInteger(input.length) || input.length < 0 || input.length > this.#maxReadBytes) {
      throw new Error(`Read length is bounded to ${this.#maxReadBytes} bytes`);
    }
    const path = await this.safePath(input.path);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(input.length);
      const { bytesRead } = await handle.read(buffer, 0, input.length, input.offset);
      abortIfNeeded(input.signal);
      const size = (await handle.stat()).size;
      return {
        data: buffer.subarray(0, bytesRead).toString(input.encoding ?? "utf8"),
        bytesRead,
        offset: input.offset,
        eof: input.offset + bytesRead >= size
      };
    } finally {
      await handle.close();
    }
  }

  public async write(input: WriteInput): Promise<MutationResult> {
    abortIfNeeded(input.signal);
    const destination = await this.safePath(input.path, false);
    await this.assertDestination(destination, input.overwrite ?? false);
    if (input.dryRun) return mutation("write", true, false, undefined, destination);
    const data = Buffer.from(input.data, input.encoding ?? "utf8");
    await this.atomicWrite(destination, data, input.overwrite ?? false, input.signal);
    return mutation("write", false, true, undefined, destination);
  }

  public async applyPatch(input: ApplyPatchInput): Promise<MutationResult> {
    abortIfNeeded(input.signal);
    const path = await this.safePath(input.path);
    const original = await readFile(path, "utf8");
    const patched = applyExactTextEdits(original, input.edits);
    if (input.dryRun) return mutation("applyPatch", true, false, path, path);
    await this.atomicWrite(path, Buffer.from(patched, "utf8"), true, input.signal);
    return mutation("applyPatch", false, patched !== original, path, path);
  }

  public async copy(input: TransferInput): Promise<MutationResult> {
    abortIfNeeded(input.signal);
    const source = await this.safePath(input.source);
    const destination = await this.safePath(input.destination, false);
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory() && !input.recursive) throw new Error("Directory copy requires recursive: true");
    await this.assertDestination(destination, input.overwrite ?? false);
    if (input.dryRun) return mutation("copy", true, false, source, destination);
    await cp(source, destination, {
      recursive: input.recursive ?? false,
      force: input.overwrite ?? false,
      errorOnExist: !(input.overwrite ?? false),
      verbatimSymlinks: true
    });
    abortIfNeeded(input.signal);
    return mutation("copy", false, true, source, destination);
  }

  public async move(input: TransferInput): Promise<MutationResult> {
    abortIfNeeded(input.signal);
    const source = await this.safePath(input.source);
    const destination = await this.safePath(input.destination, false);
    await this.protectRoot(source);
    await this.assertDestination(destination, input.overwrite ?? false);
    if (input.dryRun) return mutation("move", true, false, source, destination);
    if ((input.overwrite ?? false) && (await exists(destination))) {
      await rm(destination, { recursive: true, force: true });
    }
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(source, destination, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      await rm(source, { recursive: true, force: false });
    }
    abortIfNeeded(input.signal);
    return mutation("move", false, true, source, destination);
  }

  public async rename(input: RenameInput): Promise<MutationResult> {
    if (basename(input.newName) !== input.newName || input.newName === "." || input.newName === "..") {
      throw new Error("New name must be one filename without path separators");
    }
    const source = await this.safePath(input.path);
    return this.move({
      source,
      destination: join(dirname(source), input.newName),
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  }

  public async recycle(input: PathInput): Promise<RecycleResult> {
    abortIfNeeded(input.signal);
    const source = await this.safePath(input.path);
    await this.protectRoot(source);
    const destination = join(
      this.#recycleDirectory,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}-${basename(source)}`
    );
    if (input.dryRun) {
      return { ...mutation("recycle", true, false, source, destination), recoverable: true, recycledPath: destination };
    }
    await mkdir(this.#recycleDirectory, { recursive: true });
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(source, destination, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      await rm(source, { recursive: true, force: false });
    }
    return { ...mutation("recycle", false, true, source, destination), recoverable: true, recycledPath: destination };
  }

  public async remove(input: RemoveInput): Promise<MutationResult> {
    abortIfNeeded(input.signal);
    if (!input.permanent) throw new Error("Permanent removal requires permanent: true; use recycle otherwise");
    const path = await this.safePath(input.path);
    await this.protectRoot(path);
    if (input.dryRun) return mutation("remove", true, false, path);
    const value = await lstat(path);
    if (value.isDirectory() && !input.recursive) throw new Error("Directory removal requires recursive: true");
    await rm(path, { recursive: input.recursive ?? false, force: false });
    return mutation("remove", false, true, path);
  }

  public async hash(input: HashInput): Promise<HashResult> {
    abortIfNeeded(input.signal);
    const path = await this.safePath(input.path);
    const algorithm = input.algorithm ?? "sha256";
    const digest = createHash(algorithm);
    for await (const chunk of createReadStream(path)) {
      abortIfNeeded(input.signal);
      digest.update(chunk as Buffer);
    }
    return { algorithm, digest: digest.digest("hex") };
  }

  public async permissions(input: PathInput): Promise<PermissionResult> {
    abortIfNeeded(input.signal);
    return readPermissions(await this.safePath(input.path));
  }

  public async links(input: PathInput): Promise<LinkResult> {
    abortIfNeeded(input.signal);
    const path = await this.canonicalPath(input.path);
    this.assertLexicallyAllowed(path);
    const allowedRoots = await this.#resolvedAllowedRoots;
    return readLinkMetadata(path, (candidate) => this.isAllowedAgainst(candidate, allowedRoots));
  }

  private async canonicalPath(path: string): Promise<string> {
    const target = await canonicalizeTarget({ kind: "path", value: path });
    this.rejectAlternateDataStream(target.canonical);
    return resolve(target.canonical);
  }

  private async safePath(path: string, mustExist = true): Promise<string> {
    const canonical = await this.canonicalPath(path);
    this.assertLexicallyAllowed(canonical);
    const resolved = await this.resolveThroughExistingPath(canonical);
    const allowedRoots = await this.#resolvedAllowedRoots;
    if (!this.isAllowedAgainst(resolved, allowedRoots)) {
      throw new Error(`Path escapes an allowed root: ${path}`);
    }
    if (mustExist && !(await exists(canonical))) throw new Error(`Path does not exist: ${canonical}`);
    return canonical;
  }

  private assertLexicallyAllowed(path: string): void {
    if (!this.isAllowed(path)) throw new Error(`Path is outside every allowed root: ${path}`);
  }

  private isAllowed(path: string): boolean {
    return this.isAllowedAgainst(path, this.#allowedRoots);
  }

  private isAllowedAgainst(path: string, roots: readonly string[]): boolean {
    if (roots.length === 0) return true;
    const candidate = normalizeForComparison(path);
    return roots.some((root) => isWithin(normalizeForComparison(root), candidate));
  }

  private async resolveThroughExistingPath(path: string): Promise<string> {
    let cursor = path;
    const remainder: string[] = [];
    while (!(await exists(cursor))) {
      const parent = dirname(cursor);
      if (parent === cursor) return path;
      remainder.unshift(basename(cursor));
      cursor = parent;
    }
    const resolved = await realpath(cursor);
    return resolve(resolved, ...remainder);
  }

  private rejectAlternateDataStream(path: string): void {
    const remainder = /^[A-Za-z]:/u.test(path) ? path.slice(2) : path;
    if (remainder.includes(":")) throw new Error(`NTFS alternate data streams are not supported: ${path}`);
  }

  private async protectRoot(path: string): Promise<void> {
    if (normalizeForComparison(path) === normalizeForComparison(parse(path).root)) {
      throw new Error(`Refusing to mutate a filesystem root: ${path}`);
    }
  }

  private async assertDestination(destination: string, overwrite: boolean): Promise<void> {
    const parent = dirname(destination);
    if (!(await exists(parent)) || !(await stat(parent)).isDirectory()) {
      throw new Error(`Destination parent does not exist: ${parent}`);
    }
    const desiredName = basename(destination);
    const collision = (await readdir(parent)).find(
      (name) => name.toLowerCase() === desiredName.toLowerCase()
    );
    if (collision && collision !== desiredName) {
      throw new Error(`Destination has a case collision with existing entry: ${collision}`);
    }
    if (collision && !overwrite) throw new Error(`Destination already exists: ${destination}`);
  }

  private async atomicWrite(
    destination: string,
    data: Uint8Array,
    overwrite: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    const temporary = join(dirname(destination), `.${basename(destination)}.remote-mcp-tmp-${randomUUID()}`);
    const backup = join(dirname(destination), `.${basename(destination)}.remote-mcp-backup-${randomUUID()}`);
    let backupCreated = false;
    try {
      await writeFile(temporary, data, { flag: "wx" });
      abortIfNeeded(signal);
      await this.#beforeAtomicCommit?.(temporary, destination);
      abortIfNeeded(signal);
      if (overwrite && (await exists(destination))) {
        await rename(destination, backup);
        backupCreated = true;
      }
      await rename(temporary, destination);
      if (backupCreated) await rm(backup, { force: true });
    } catch (error) {
      if (backupCreated && !(await exists(destination)) && (await exists(backup))) {
        await rename(backup, destination);
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(backup, { force: true }).catch(() => undefined);
    }
  }
}

export function createFilesystemAdapter(options: FilesystemAdapterOptions = {}): FilesystemAdapter {
  return new NodeFilesystemAdapter(options);
}

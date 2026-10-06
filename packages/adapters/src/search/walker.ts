import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface WalkedFile {
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedAt: Date;
}

export interface WalkerOptions {
  readonly roots: readonly string[];
  readonly allowedRoots: readonly string[];
  readonly signal: AbortSignal;
  readonly onIssue: (path: string, error: unknown) => void;
}

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
}

export async function* walkFiles(options: WalkerOptions): AsyncGenerator<WalkedFile> {
  const allowed = await Promise.all(options.allowedRoots.map(async (root) => realpath(resolve(root)).catch(() => resolve(root))));
  const seenDirectories = new Set<string>();

  async function* visit(directory: string, searchRoot: string): AsyncGenerator<WalkedFile> {
    abortIfNeeded(options.signal);
    let actual: string;
    try {
      actual = await realpath(directory);
      if (allowed.length > 0 && !allowed.some((root) => within(root.toLowerCase(), actual.toLowerCase()))) {
        throw new Error(`Search path escapes an allowed root: ${directory}`);
      }
      const key = actual.toLowerCase();
      if (seenDirectories.has(key)) return;
      seenDirectories.add(key);
    } catch (error) {
      options.onIssue(directory, error);
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      options.onIssue(directory, error);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      abortIfNeeded(options.signal);
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        yield* visit(path, searchRoot);
      } else if (entry.isFile()) {
        try {
          const metadata = await lstat(path);
          yield {
            path,
            root: searchRoot,
            relativePath: relative(searchRoot, path),
            size: metadata.size,
            modifiedAt: metadata.mtime
          };
        } catch (error) {
          options.onIssue(path, error);
        }
      }
    }
  }

  for (const rootValue of [...options.roots].sort((left, right) => left.localeCompare(right, "en"))) {
    abortIfNeeded(options.signal);
    const root = resolve(rootValue);
    try {
      const metadata = await lstat(root);
      if (metadata.isFile()) {
        const parent = resolve(root, "..");
        yield { path: root, root: parent, relativePath: relative(parent, root), size: metadata.size, modifiedAt: metadata.mtime };
      } else if (metadata.isDirectory()) {
        yield* visit(root, root);
      } else {
        options.onIssue(root, new Error("Unsupported search root type"));
      }
    } catch (error) {
      options.onIssue(root, error);
    }
  }
}

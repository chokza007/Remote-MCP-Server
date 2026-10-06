import { constants } from "node:fs";
import { access, lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type {
  FilesystemEntry,
  FilesystemStat,
  LinkResult,
  PermissionResult
} from "./contracts.js";

function kind(value: Awaited<ReturnType<typeof lstat>>): FilesystemEntry["kind"] {
  if (value.isSymbolicLink()) return "link";
  if (value.isFile()) return "file";
  if (value.isDirectory()) return "directory";
  return "other";
}

export async function readFilesystemStat(path: string): Promise<FilesystemStat> {
  const value = await lstat(path);
  return {
    path,
    name: basename(path),
    kind: kind(value),
    size: value.size,
    createdAt: value.birthtime.toISOString(),
    modifiedAt: value.mtime.toISOString()
  };
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function readPermissions(path: string): Promise<PermissionResult> {
  const value = await stat(path);
  const [readable, writable, executable] = await Promise.all([
    canAccess(path, constants.R_OK),
    canAccess(path, constants.W_OK),
    canAccess(path, constants.X_OK)
  ]);
  return { readable, writable, executable, mode: value.mode };
}

export async function readLinkMetadata(
  path: string,
  isAllowed: (candidate: string) => boolean
): Promise<LinkResult> {
  const value = await lstat(path);
  if (!value.isSymbolicLink()) {
    return { isLink: false, target: null, resolvedTarget: null, escapesAllowedRoots: false };
  }
  const target = await readlink(path);
  const resolvedTarget = await realpath(path);
  return {
    isLink: true,
    target,
    resolvedTarget: resolve(resolvedTarget),
    escapesAllowedRoots: !isAllowed(resolvedTarget)
  };
}

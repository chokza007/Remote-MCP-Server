import { basename } from "node:path";

import type { SearchRequest } from "./search-service.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globRegex(pattern: string): RegExp {
  const source = escapeRegex(pattern.replaceAll("\\", "/"))
    .replaceAll("\\*\\*", ".*")
    .replaceAll("\\*", "[^/]*")
    .replaceAll("\\?", "[^/]");
  return new RegExp(`^${source}$`, "iu");
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const matcher = globRegex(pattern);
  return matcher.test(normalized) || matcher.test(basename(normalized));
}

export function compileSearchPattern(
  pattern: string | undefined,
  regex: boolean,
  caseSensitive: boolean
): RegExp | null {
  if (pattern === undefined) return null;
  try {
    return new RegExp(regex ? pattern : escapeRegex(pattern), caseSensitive ? "u" : "iu");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${(error as Error).message}`);
  }
}

export function passesPathFilters(relativePath: string, request: SearchRequest): boolean {
  if (request.include?.length && !request.include.some((pattern) => matchesGlob(relativePath, pattern))) {
    return false;
  }
  if (request.exclude?.some((pattern) => matchesGlob(relativePath, pattern))) return false;
  return true;
}

export function passesMetadataFilters(
  size: number,
  modifiedAt: Date,
  request: SearchRequest
): boolean {
  if (request.minSize !== undefined && size < request.minSize) return false;
  if (request.maxSize !== undefined && size > request.maxSize) return false;
  if (request.modifiedAfter !== undefined && modifiedAt <= new Date(request.modifiedAfter)) return false;
  if (request.modifiedBefore !== undefined && modifiedAt >= new Date(request.modifiedBefore)) return false;
  return true;
}

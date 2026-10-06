import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import { extractFileText, extractZipMembers, type ContentMatch } from "./extractors.js";
import {
  compileSearchPattern,
  passesMetadataFilters,
  passesPathFilters
} from "./filters.js";
import { emptyMetrics, SearchResultStore } from "./result-store.js";
import { walkFiles } from "./walker.js";

export interface SearchRequest {
  readonly roots: readonly string[];
  readonly name?: string;
  readonly content?: string;
  readonly regex?: boolean;
  readonly caseSensitive?: boolean;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly modifiedAfter?: string;
  readonly modifiedBefore?: string;
  readonly types?: readonly ("file" | "archive_member")[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly archives?: boolean;
  readonly documents?: boolean;
  readonly ocr?: boolean;
  readonly maxFiles: number;
  readonly maxResults: number;
  readonly maxBytes: number;
}

export interface SearchResult {
  readonly sequence: number;
  readonly kind: "file" | "archive_member";
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly matches: readonly ContentMatch[];
  readonly archivePath?: string;
  readonly memberPath?: string;
}

export interface SearchPage {
  readonly items: readonly SearchResult[];
  readonly nextCursor: number | null;
}

export interface SearchStatus {
  readonly searchId: string;
  readonly state: "pending" | "running" | "completed" | "cancelled" | "failed";
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly matchedResults: number;
  readonly issues: number;
  readonly skippedBinary: number;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SearchServiceOptions {
  readonly database: OperationalDatabase;
  readonly allowedRoots?: readonly string[];
  readonly now?: () => Date;
}

function validateRequest(request: SearchRequest): void {
  if (request.roots.length === 0) throw new Error("Search requires at least one root");
  for (const [name, value] of [
    ["maxFiles", request.maxFiles],
    ["maxResults", request.maxResults],
    ["maxBytes", request.maxBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (request.minSize !== undefined && request.minSize < 0) throw new Error("minSize must be non-negative");
  if (request.maxSize !== undefined && request.maxSize < 0) throw new Error("maxSize must be non-negative");
  if (request.modifiedAfter !== undefined && Number.isNaN(Date.parse(request.modifiedAfter))) {
    throw new Error("modifiedAfter must be a valid date");
  }
  if (request.modifiedBefore !== undefined && Number.isNaN(Date.parse(request.modifiedBefore))) {
    throw new Error("modifiedBefore must be a valid date");
  }
  compileSearchPattern(request.name, request.regex ?? false, request.caseSensitive ?? false);
  compileSearchPattern(request.content, request.regex ?? false, request.caseSensitive ?? false);
}

export class SearchService {
  readonly #store: SearchResultStore;
  readonly #allowedRoots: readonly string[];
  readonly #now: () => Date;
  readonly #active = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >();

  public constructor(options: SearchServiceOptions) {
    this.#store = new SearchResultStore(options.database);
    this.#allowedRoots = options.allowedRoots ?? [];
    this.#now = options.now ?? (() => new Date());
  }

  public async start(request: SearchRequest): Promise<{ readonly searchId: string }> {
    validateRequest(request);
    const searchId = randomUUID();
    this.#store.create(searchId, request, this.#now().toISOString());
    this.launch(searchId);
    return { searchId };
  }

  public page(searchId: string, cursor = 0, limit = 100): SearchPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Search cursor must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Search page limit must be from 1 through 1000");
    }
    return this.#store.page(searchId, cursor, limit);
  }

  public status(searchId: string): SearchStatus {
    return this.#store.get(searchId).status;
  }

  public cancel(searchId: string): SearchStatus {
    const current = this.#store.get(searchId).status;
    if (["completed", "failed", "cancelled"].includes(current.state)) return current;
    this.#active.get(searchId)?.controller.abort();
    this.#store.update(searchId, "cancelled", this.metrics(current), this.#now().toISOString());
    return this.status(searchId);
  }

  public async resume(searchId: string): Promise<void> {
    const current = this.#store.get(searchId);
    if (!(["cancelled", "failed"] as const).includes(current.status.state as "cancelled" | "failed")) {
      throw new Error(`Search cannot resume from state: ${current.status.state}`);
    }
    validateRequest(current.request);
    await this.#active.get(searchId)?.done;
    this.#store.clearResults(searchId);
    this.#store.update(searchId, "pending", { ...emptyMetrics }, this.#now().toISOString());
    this.launch(searchId);
  }

  private metrics(status: SearchStatus): typeof emptyMetrics {
    return {
      scannedFiles: status.scannedFiles,
      scannedBytes: status.scannedBytes,
      matchedResults: status.matchedResults,
      issues: status.issues,
      skippedBinary: status.skippedBinary,
      truncated: status.truncated,
      error: status.error
    };
  }

  private launch(searchId: string): void {
    const controller = new AbortController();
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const active = { controller, done };
    this.#active.set(searchId, active);
    setImmediate(() => {
      void this.run(searchId, controller).finally(() => {
        if (this.#active.get(searchId) === active) this.#active.delete(searchId);
        complete();
      });
    });
  }

  private async run(searchId: string, controller: AbortController): Promise<void> {
    const initial = this.#store.get(searchId);
    if (initial.status.state === "cancelled") return;
    const metrics = { ...emptyMetrics };
    this.#store.update(searchId, "running", metrics, this.#now().toISOString());
    const request = initial.request;
    const nameMatcher = compileSearchPattern(
      request.name,
      request.regex ?? false,
      request.caseSensitive ?? false
    );
    const contentMatcher = compileSearchPattern(
      request.content,
      request.regex ?? false,
      request.caseSensitive ?? false
    );

    try {
      const walker = walkFiles({
        roots: request.roots,
        allowedRoots: this.#allowedRoots,
        signal: controller.signal,
        onIssue: () => {
          metrics.issues += 1;
        }
      });
      for await (const file of walker) {
        if (controller.signal.aborted || this.#store.get(searchId).status.state === "cancelled") {
          throw new DOMException("Search cancelled", "AbortError");
        }
        if (metrics.scannedFiles >= request.maxFiles) {
          metrics.truncated = true;
          break;
        }
        metrics.scannedFiles += 1;
        if (metrics.scannedBytes + file.size > request.maxBytes) {
          metrics.truncated = true;
          break;
        }
        metrics.scannedBytes += file.size;

        if (!passesPathFilters(file.relativePath, request) ||
            !passesMetadataFilters(file.size, file.modifiedAt, request) ||
            (nameMatcher && !nameMatcher.test(basename(file.path)))) {
          this.#store.update(searchId, "running", metrics, this.#now().toISOString());
          continue;
        }

        if (request.archives && extname(file.path).toLowerCase() === ".zip" && contentMatcher) {
          try {
            const members = await extractZipMembers(
              file.path,
              contentMatcher,
              Math.max(0, request.maxBytes - metrics.scannedBytes)
            );
            for (const member of members) {
              if (request.types?.length && !request.types.includes("archive_member")) continue;
              if (metrics.matchedResults >= request.maxResults) {
                metrics.truncated = true;
                break;
              }
              const sequence = metrics.matchedResults;
              this.#store.append(searchId, sequence, {
                sequence,
                kind: "archive_member",
                path: `${file.path}::${member.memberPath}`,
                archivePath: file.path,
                memberPath: member.memberPath,
                size: member.size,
                modifiedAt: file.modifiedAt.toISOString(),
                matches: member.matches
              });
              metrics.matchedResults += 1;
            }
          } catch {
            metrics.issues += 1;
          }
        } else {
          if (request.types?.length && !request.types.includes("file")) continue;
          let matches: readonly ContentMatch[] = [];
          if (contentMatcher) {
            const extracted = await extractFileText(file.path, contentMatcher);
            if (extracted.binary) {
              metrics.skippedBinary += 1;
              continue;
            }
            matches = extracted.matches;
            if (matches.length === 0) continue;
          }
          if (metrics.matchedResults >= request.maxResults) {
            metrics.truncated = true;
            break;
          }
          const sequence = metrics.matchedResults;
          this.#store.append(searchId, sequence, {
            sequence,
            kind: "file",
            path: file.path,
            size: file.size,
            modifiedAt: file.modifiedAt.toISOString(),
            matches
          });
          metrics.matchedResults += 1;
        }
        this.#store.update(searchId, "running", metrics, this.#now().toISOString());
        if (metrics.truncated) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const current = this.#store.get(searchId).status;
      if (current.state !== "cancelled") {
        this.#store.update(searchId, "completed", metrics, this.#now().toISOString());
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        metrics.error = error instanceof Error ? error.message : String(error);
        this.#store.update(searchId, "failed", metrics, this.#now().toISOString());
      }
    } finally {
      // Lifecycle cleanup is owned by launch() so an older worker cannot delete a resumed worker.
    }
  }
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  return new SearchService(options);
}

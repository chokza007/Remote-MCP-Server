import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { HttpService } from "./http-client.js";
import { NetworkError } from "./url-policy.js";

export type DownloadState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DownloadInput {
  readonly url: string;
  readonly destination: string;
  readonly expectedSha256?: string;
  readonly overwrite?: boolean;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly credentialReference?: string;
  readonly namespace?: string;
}

export interface DownloadStatus {
  readonly jobId: string;
  readonly state: DownloadState;
  readonly destination: string;
  readonly bytesDownloaded: number;
  readonly totalBytes: number | null;
  readonly sha256: string | null;
  readonly error: string | null;
}

export interface DownloadVerification {
  readonly valid: boolean;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DownloadServiceOptions {
  readonly http: HttpService;
  readonly defaultMaxBytes?: number;
  readonly database?: OperationalDatabase;
  readonly authorizeResume?: (namespace: string) => boolean | Promise<boolean>;
}

export interface DownloadService {
  start(input: DownloadInput): Promise<DownloadStatus>;
  status(jobId: string, namespace?: string): Promise<DownloadStatus>;
  cancel(jobId: string, namespace?: string): Promise<DownloadStatus>;
  resume(jobId: string, namespace?: string): Promise<DownloadStatus>;
  verify(jobId: string, namespace?: string): Promise<DownloadVerification>;
}

interface DownloadRecord {
  readonly input: DownloadInput;
  readonly destination: string;
  readonly partial: string;
  readonly namespace: string;
  controller: AbortController;
  state: DownloadState;
  bytesDownloaded: number;
  totalBytes: number | null;
  sha256: string | null;
  error: string | null;
  active: Promise<void> | null;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

export class InMemoryDownloadService implements DownloadService {
  readonly #http: HttpService;
  readonly #defaultMaxBytes: number;
  readonly #records = new Map<string, DownloadRecord>();
  readonly #database: OperationalDatabase | undefined;
  readonly #authorizeResume: ((namespace: string) => boolean | Promise<boolean>) | undefined;

  public constructor(options: DownloadServiceOptions) {
    this.#http = options.http;
    this.#defaultMaxBytes = options.defaultMaxBytes ?? 512 * 1024 * 1024;
    this.#database = options.database;
    this.#authorizeResume = options.authorizeResume;
    if (this.#database) this.restore();
  }

  public async start(input: DownloadInput): Promise<DownloadStatus> {
    const destination = resolve(input.destination);
    if ((await exists(destination)) && !input.overwrite) throw new NetworkError("DESTINATION_EXISTS", `Download destination already exists: ${destination}`);
    const jobId = randomUUID();
    const record: DownloadRecord = {
      input,
      destination,
      partial: `${destination}.remote-mcp.part`,
      namespace: input.namespace ?? "",
      controller: new AbortController(),
      state: "queued",
      bytesDownloaded: 0,
      totalBytes: null,
      sha256: null,
      error: null,
      active: null
    };
    this.#records.set(jobId, record);
    this.insert(jobId, record);
    void this.launch(jobId, record);
    return this.snapshot(jobId, record);
  }

  public async status(jobId: string, namespace?: string): Promise<DownloadStatus> {
    return this.snapshot(jobId, this.record(jobId, namespace));
  }

  public async cancel(jobId: string, namespace?: string): Promise<DownloadStatus> {
    const record = this.record(jobId, namespace);
    if (record.state === "running" || record.state === "queued") {
      record.state = "cancelled";
      record.controller.abort();
      this.persist(jobId, record);
    }
    return this.snapshot(jobId, record);
  }

  public async resume(jobId: string, namespace?: string): Promise<DownloadStatus> {
    const record = this.record(jobId, namespace);
    if (record.state !== "failed" && record.state !== "cancelled") throw new Error(`Download cannot be resumed from state ${record.state}`);
    await record.active;
    record.controller = new AbortController();
    record.state = "queued";
    record.error = null;
    this.persist(jobId, record);
    void this.launch(jobId, record);
    return this.snapshot(jobId, record);
  }

  public async verify(jobId: string, namespace?: string): Promise<DownloadVerification> {
    const record = this.record(jobId, namespace);
    if (record.state !== "completed") throw new Error(`Download is not complete: ${record.state}`);
    const data = await readFile(record.destination);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const valid = record.input.expectedSha256 === undefined || sha256 === record.input.expectedSha256.toLowerCase();
    return { valid, sha256, bytes: data.length };
  }

  private async execute(jobId: string, record: DownloadRecord): Promise<void> {
    record.state = "running";
    this.persist(jobId, record);
    try {
      const partialMetadata = await lstat(record.partial).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (partialMetadata?.isSymbolicLink()) throw new NetworkError("DESTINATION_EXISTS", "Download partial path must not be a symbolic link", record.partial);
      if ((await lstat(record.destination).catch(() => null))?.isSymbolicLink()) {
        throw new NetworkError("DESTINATION_EXISTS", "Download destination must not be a symbolic link", record.destination);
      }
      const partialBytes = partialMetadata?.size ?? 0;
      const maxBytes = record.input.maxBytes ?? this.#defaultMaxBytes;
      if (partialBytes > maxBytes) throw new NetworkError("RESPONSE_TOO_LARGE", "Partial download already exceeds its configured maximum", record.input.url);
      record.bytesDownloaded = partialBytes;
      this.persist(jobId, record);
      const response = await this.#http.request({
        url: record.input.url,
        headers: partialBytes > 0 ? { range: `bytes=${partialBytes}-` } : {},
        signal: record.controller.signal,
        maxResponseBytes: maxBytes - partialBytes,
        ...(record.input.timeoutMs === undefined ? {} : { timeoutMs: record.input.timeoutMs }),
        ...(record.input.credentialReference === undefined ? {} : { credentialReference: record.input.credentialReference })
      });
      if (![200, 206].includes(response.status)) {
        throw new NetworkError("INVALID_RESPONSE", `Download server returned HTTP ${response.status}`, record.input.url);
      }
      if (record.controller.signal.aborted) throw new DOMException("Download was cancelled", "AbortError");
      if (partialBytes > 0 && response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(response.headers["content-range"] ?? "");
        const start = Number(match?.[1]);
        const end = Number(match?.[2]);
        const total = match?.[3] === "*" ? null : Number(match?.[3]);
        if (!match || start !== partialBytes || end - start + 1 !== response.body.length || (total !== null && end >= total)) {
          throw new NetworkError("INVALID_RESPONSE", "Download server returned an invalid resume range", record.input.url);
        }
        await appendFile(record.partial, response.body);
      } else {
        await writeFile(record.partial, response.body, { flag: "w" });
      }
      const current = await readFile(record.partial);
      record.bytesDownloaded = current.length;
      const contentRangeTotal = /\/(\d+)$/u.exec(response.headers["content-range"] ?? "")?.[1];
      record.totalBytes = contentRangeTotal ? Number(contentRangeTotal) : current.length;
      if (record.bytesDownloaded > (record.input.maxBytes ?? this.#defaultMaxBytes)) {
        throw new NetworkError("RESPONSE_TOO_LARGE", "Download exceeded its configured maximum", record.input.url);
      }
      const sha256 = createHash("sha256").update(current).digest("hex");
      record.sha256 = sha256;
      if (record.input.expectedSha256 !== undefined && sha256 !== record.input.expectedSha256.toLowerCase()) {
        throw new NetworkError("HASH_MISMATCH", "Downloaded content did not match the expected SHA-256", record.input.url);
      }
      if (await exists(record.destination)) {
        if (!record.input.overwrite) throw new NetworkError("DESTINATION_EXISTS", `Download destination already exists: ${record.destination}`);
        const backup = `${record.destination}.remote-mcp.backup-${jobId}`;
        await rename(record.destination, backup);
        try {
          await rename(record.partial, record.destination);
          await rm(backup, { force: true });
        } catch (error) {
          await rename(backup, record.destination).catch(() => undefined);
          throw error;
        }
      } else {
        await rename(record.partial, record.destination);
      }
      record.state = "completed";
      this.persist(jobId, record);
    } catch (error) {
      if (record.controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        record.state = "cancelled";
      } else {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      }
      this.persist(jobId, record);
    }
  }

  private record(jobId: string, namespace?: string): DownloadRecord {
    const record = this.#records.get(jobId);
    if (!record || (namespace !== undefined && record.namespace !== namespace)) throw new Error(`Download job not found: ${jobId}`);
    return record;
  }

  private snapshot(jobId: string, record: DownloadRecord): DownloadStatus {
    return {
      jobId,
      state: record.state,
      destination: record.destination,
      bytesDownloaded: record.bytesDownloaded,
      totalBytes: record.totalBytes,
      sha256: record.sha256,
      error: record.error
    };
  }

  private insert(jobId: string, record: DownloadRecord): void {
    if (!this.#database) return;
    const now = new Date().toISOString();
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO download_jobs(
          id, namespace, input_json, destination, partial_path, state,
          bytes_downloaded, total_bytes, sha256, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        record.namespace,
        JSON.stringify(record.input),
        record.destination,
        record.partial,
        record.state,
        record.bytesDownloaded,
        record.totalBytes,
        record.sha256,
        record.error,
        now,
        now
      );
    });
  }

  private persist(jobId: string, record: DownloadRecord): void {
    if (!this.#database) return;
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `UPDATE download_jobs SET state = ?, bytes_downloaded = ?, total_bytes = ?,
          sha256 = ?, error = ?, updated_at = ? WHERE id = ?`
      ).run(
        record.state,
        record.bytesDownloaded,
        record.totalBytes,
        record.sha256,
        record.error,
        new Date().toISOString(),
        jobId
      );
    });
  }

  private restore(): void {
    const rows = this.#database!.read((connection) => connection.prepare(
      "SELECT * FROM download_jobs ORDER BY created_at, id"
    ).all() as Array<{
      id: string;
      namespace: string;
      input_json: string;
      destination: string;
      partial_path: string;
      state: DownloadState;
      bytes_downloaded: number;
      total_bytes: number | null;
      sha256: string | null;
      error: string | null;
    }>);
    for (const row of rows) {
      const record: DownloadRecord = {
        input: JSON.parse(row.input_json) as DownloadInput,
        destination: row.destination,
        partial: row.partial_path,
        namespace: row.namespace,
        controller: new AbortController(),
        state: row.state,
        bytesDownloaded: row.bytes_downloaded,
        totalBytes: row.total_bytes,
        sha256: row.sha256,
        error: row.error,
        active: null
      };
      this.#records.set(row.id, record);
      if (record.state === "queued" || record.state === "running") {
        record.state = "queued";
        void this.resumeRestored(row.id, record);
      }
    }
  }

  private async resumeRestored(jobId: string, record: DownloadRecord): Promise<void> {
    const authorized = this.#authorizeResume === undefined
      ? false
      : await this.#authorizeResume(record.namespace);
    if (!authorized) {
      record.state = "failed";
      record.error = "Interrupted download requires a newly authorized resume";
      this.persist(jobId, record);
      return;
    }
    await this.launch(jobId, record);
  }

  private launch(jobId: string, record: DownloadRecord): Promise<void> {
    const running = this.execute(jobId, record).finally(() => {
      if (record.active === running) record.active = null;
    });
    record.active = running;
    return running;
  }
}

export function createDownloadService(options: DownloadServiceOptions): DownloadService {
  return new InMemoryDownloadService(options);
}

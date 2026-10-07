import { createHash, randomUUID } from "node:crypto";
import { watch as watchFs, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { EventPage } from "../events/event-repository.js";
import { DirectoryWatchAdapter, FileWatchAdapter, type WatchAdapter, type WatchProbeResult } from "./file-watch.js";
import { JobWatchAdapter, type JobStateProbe } from "./job-watch.js";
import { LogWatchAdapter } from "./log-watch.js";
import { PortWatchAdapter, type PortProbe } from "./port-watch.js";
import { ProcessWatchAdapter, type ProcessProbe } from "./process-watch.js";
import { defaultUrlProbe, UrlWatchAdapter, type UrlProbe } from "./url-watch.js";

export type WatchKind = "file" | "directory" | "process" | "port" | "job" | "log" | "url";
export type WatchState = "active" | "paused" | "cancelled";

export interface WatchRecord {
  readonly watchId: string;
  readonly ownerId: string;
  readonly kind: WatchKind;
  readonly target: string;
  readonly workspaceId?: string;
  readonly grantId?: string;
  readonly specification: Readonly<Record<string, unknown>>;
  readonly state: WatchState;
  readonly intervalMs: number;
  readonly cursor: unknown;
  readonly lastFingerprint: string | null;
  readonly nextPollAt: string | null;
  readonly consecutiveFailures: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWatchInput {
  readonly ownerId: string;
  readonly kind: WatchKind;
  readonly target: string;
  readonly workspaceId?: string;
  readonly grantId?: string;
  readonly intervalMs?: number;
  readonly specification?: Readonly<Record<string, unknown>>;
}

export interface WatchServiceOptions {
  readonly database: OperationalDatabase;
  readonly eventBus?: EventBus;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly urlProbe?: UrlProbe;
  readonly jobState?: JobStateProbe;
  readonly processState?: ProcessProbe;
  readonly portState?: PortProbe;
  readonly authorize?: (watch: WatchRecord) => boolean | Promise<boolean>;
}

interface WatchRow {
  readonly id: string;
  readonly kind: WatchKind;
  readonly workspace_id: string | null;
  readonly grant_id: string | null;
  readonly specification_json: string;
  readonly state: WatchState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner_id: string;
  readonly target: string;
  readonly interval_ms: number;
  readonly cursor_json: string | null;
  readonly last_fingerprint: string | null;
  readonly next_poll_at: string | null;
  readonly consecutive_failures: number;
}

function record(row: WatchRow): WatchRecord {
  return {
    watchId: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    target: row.target,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
    specification: JSON.parse(row.specification_json) as Record<string, unknown>,
    state: row.state,
    intervalMs: row.interval_ms,
    cursor: row.cursor_json === null ? null : JSON.parse(row.cursor_json) as unknown,
    lastFingerprint: row.last_fingerprint,
    nextPollAt: row.next_poll_at,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function watchError(code: string, message: string, target: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: code,
    message,
    retryable: false,
    suggestedAction: "Refresh the owned watch list and retry with an active watch.",
    target
  });
}

export class WatchService {
  private readonly database: OperationalDatabase;
  private readonly eventsBus: EventBus;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly adapters = new Map<WatchKind, WatchAdapter>();
  private readonly authorize: (watch: WatchRecord) => boolean | Promise<boolean>;
  private readonly native = new Map<string, FSWatcher>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private started = false;
  private timer: NodeJS.Timeout | null = null;

  public constructor(options: WatchServiceOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.eventsBus = options.eventBus ?? createEventBus({ database: options.database, now: this.now });
    this.authorize = options.authorize ?? (() => true);
    const adapters: WatchAdapter[] = [
      new FileWatchAdapter(),
      new DirectoryWatchAdapter(),
      new LogWatchAdapter(),
      new UrlWatchAdapter(options.urlProbe ?? defaultUrlProbe),
      new ProcessWatchAdapter(options.processState),
      new PortWatchAdapter(options.portState),
      new JobWatchAdapter(options.jobState ?? (async () => { throw new Error("Job watch capability is unavailable"); }))
    ];
    for (const adapter of adapters) this.adapters.set(adapter.kind as WatchKind, adapter);
  }

  public async create(input: CreateWatchInput): Promise<WatchRecord> {
    if (input.ownerId.trim().length === 0 || input.target.trim().length === 0) throw new Error("Watch owner and target are required");
    const intervalMs = input.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 86_400_000) {
      throw new Error("Watch interval must be from 100 through 86400000 ms");
    }
    const watchId = randomUUID();
    const now = this.now().toISOString();
    const target = ["file", "directory", "log"].includes(input.kind) ? resolve(input.target) : input.target;
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO watches(
          id, kind, workspace_id, grant_id, specification_json, state, created_at, updated_at,
          owner_id, target, interval_ms, next_poll_at, consecutive_failures
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0)`
      ).run(
        watchId,
        input.kind,
        input.workspaceId ?? null,
        input.grantId ?? null,
        JSON.stringify(input.specification ?? {}),
        now,
        now,
        input.ownerId,
        target,
        intervalMs,
        now
      );
    });
    const created = this.get(watchId);
    if (this.started) this.startNative(created);
    return created;
  }

  public list(ownerId: string): readonly WatchRecord[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM watches WHERE owner_id = ? ORDER BY created_at, id").all(ownerId) as WatchRow[]).map(record)
    );
  }

  public async pause(watchId: string, ownerId: string): Promise<WatchRecord> {
    this.owned(watchId, ownerId);
    this.setState(watchId, "paused");
    this.stopNative(watchId);
    return this.get(watchId);
  }

  public async resume(watchId: string, ownerId: string): Promise<WatchRecord> {
    this.owned(watchId, ownerId);
    this.setState(watchId, "active");
    const resumed = this.get(watchId);
    if (this.started) this.startNative(resumed);
    return resumed;
  }

  public async cancel(watchId: string, ownerId: string): Promise<WatchRecord> {
    this.owned(watchId, ownerId);
    this.setState(watchId, "cancelled");
    this.stopNative(watchId);
    return this.get(watchId);
  }

  public events(watchId: string, ownerId: string, cursor = 0, limit = 100): EventPage {
    this.owned(watchId, ownerId);
    return this.eventsBus.watchEvents(watchId, cursor, limit);
  }

  public async pollOnce(watchId?: string): Promise<{ readonly polled: number }> {
    const now = this.now().toISOString();
    const records = watchId === undefined
      ? this.database.read((connection) => connection.prepare(
        "SELECT * FROM watches WHERE state = 'active' AND (next_poll_at IS NULL OR next_poll_at <= ?) ORDER BY created_at, id"
      ).all(now) as WatchRow[]).map(record)
      : [this.get(watchId)].filter((item) => item.state === "active");
    for (const item of records) await this.queuePoll(item);
    return { polled: records.length };
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const active = this.database.read((connection) =>
      (connection.prepare("SELECT * FROM watches WHERE state = 'active' ORDER BY created_at, id").all() as WatchRow[]).map(record)
    );
    for (const item of active) this.startNative(item);
    this.schedulePoll();
  }

  public async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.native.values()) watcher.close();
    this.native.clear();
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private get(watchId: string): WatchRecord {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM watches WHERE id = ?").get(watchId) as WatchRow | undefined
    );
    if (!row) throw watchError("WATCH_NOT_FOUND", "The watch does not exist.", watchId);
    return record(row);
  }

  private owned(watchId: string, ownerId: string): WatchRecord {
    const item = this.get(watchId);
    if (item.ownerId !== ownerId) throw watchError("WATCH_NOT_FOUND", "The watch does not exist.", watchId);
    return item;
  }

  private setState(watchId: string, state: WatchState): void {
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE watches SET state = ?, updated_at = ?, next_poll_at = ? WHERE id = ?")
        .run(state, now, state === "active" ? now : null, watchId);
    });
  }

  private async queuePoll(item: WatchRecord): Promise<void> {
    const existing = this.inFlight.get(item.watchId);
    if (existing) return existing;
    const running = this.poll(item).finally(() => this.inFlight.delete(item.watchId));
    this.inFlight.set(item.watchId, running);
    return running;
  }

  private async poll(item: WatchRecord): Promise<void> {
    const current = this.get(item.watchId);
    if (current.state !== "active") return;
    if (!await this.authorize(current)) {
      this.publish(current, "watch_authorization_revoked", { target: current.target }, "authorization_revoked");
      this.setState(current.watchId, "paused");
      this.stopNative(current.watchId);
      return;
    }
    const adapter = this.adapters.get(current.kind);
    if (!adapter) throw watchError("CAPABILITY_UNAVAILABLE", `No watch adapter is available for ${current.kind}.`, current.target);
    try {
      const result = await adapter.probe({
        target: current.target,
        cursor: current.cursor,
        fingerprint: current.lastFingerprint,
        specification: current.specification
      });
      this.publishProbe(current, result);
      const now = this.now();
      this.database.writeTransaction((connection) => {
        connection.prepare(
          `UPDATE watches SET cursor_json = ?, last_fingerprint = ?, next_poll_at = ?,
            consecutive_failures = 0, updated_at = ? WHERE id = ?`
        ).run(
          result.cursor === undefined ? null : JSON.stringify(result.cursor),
          result.fingerprint,
          new Date(now.getTime() + current.intervalMs).toISOString(),
          now.toISOString(),
          current.watchId
        );
      });
      if (current.consecutiveFailures > 0) {
        this.publish(current, "watch_recovered", { target: current.target }, `recovered:${result.fingerprint}`);
      }
    } catch (error) {
      const failures = current.consecutiveFailures + 1;
      const backoff = current.intervalMs * (2 ** Math.min(failures, 8));
      const jitter = 0.75 + this.random() * 0.5;
      const now = this.now();
      this.database.writeTransaction((connection) => {
        connection.prepare(
          "UPDATE watches SET consecutive_failures = ?, next_poll_at = ?, updated_at = ? WHERE id = ?"
        ).run(failures, new Date(now.getTime() + Math.round(backoff * jitter)).toISOString(), now.toISOString(), current.watchId);
      });
      this.publish(
        current,
        "watch_error",
        { target: current.target, message: error instanceof Error ? error.message : String(error), consecutiveFailures: failures },
        `error:${failures}:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private publishProbe(item: WatchRecord, result: WatchProbeResult): void {
    for (const event of result.events) {
      const payloadHash = createHash("sha256").update(JSON.stringify(event.payload), "utf8").digest("hex");
      this.publish(item, event.type, event.payload, `${event.type}:${result.fingerprint}:${payloadHash}`);
    }
  }

  private publish(item: WatchRecord, type: string, payload: unknown, suffix: string): void {
    this.eventsBus.publish({
      namespace: item.ownerId,
      type,
      sourceType: "watch",
      sourceId: item.watchId,
      payload,
      dedupeKey: `watch:${item.watchId}:${suffix}`
    });
  }

  private startNative(item: WatchRecord): void {
    if (!this.started || this.native.has(item.watchId) || !["file", "directory", "log"].includes(item.kind)) return;
    const directory = item.kind === "directory" ? item.target : dirname(item.target);
    const filterName = item.kind === "directory" ? null : basename(item.target).toLowerCase();
    try {
      const watcher = watchFs(directory, { persistent: false }, (_event, filename) => {
        if (filterName !== null && filename && filename.toString().toLowerCase() !== filterName) return;
        void this.queuePoll(this.get(item.watchId)).catch(() => undefined);
      });
      watcher.once("error", () => this.stopNative(item.watchId));
      this.native.set(item.watchId, watcher);
    } catch {
      // Polling remains the fallback when native watching is unavailable.
    }
  }

  private stopNative(watchId: string): void {
    this.native.get(watchId)?.close();
    this.native.delete(watchId);
  }

  private schedulePoll(): void {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().catch(() => undefined).finally(() => this.schedulePoll());
    }, 250);
    this.timer.unref();
  }
}

export function createWatchService(options: WatchServiceOptions): WatchService {
  return new WatchService(options);
}

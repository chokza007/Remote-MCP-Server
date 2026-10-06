import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

import type { IPty } from "node-pty";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import { OutputBuffer, type OutputPage } from "./output-buffer.js";
import { spawnPty, type TerminalShell } from "./pty-adapter.js";

export type TerminalState = "running" | "exited" | "closed" | "orphaned";
export type TerminalControl = "ctrl_c" | "ctrl_break" | "eof";

export interface CreateTerminalInput {
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface TerminalStatus {
  readonly terminalId: string;
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly pid: number | null;
  readonly state: TerminalState;
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly outputOffset: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TerminalServiceOptions {
  readonly database: OperationalDatabase;
  readonly allowedShells: readonly TerminalShell[];
  readonly maxBufferBytes?: number;
  readonly now?: () => Date;
  readonly redactOutput?: (value: string) => string;
}

interface LiveTerminal {
  readonly pty: IPty;
  readonly output: OutputBuffer;
  readonly exited: Promise<void>;
  readonly resolveExited: () => void;
  status: TerminalStatus;
}

const execFileAsync = promisify(execFile);

export interface PromotionMetadata {
  readonly terminalId: string;
  readonly shell: TerminalShell;
  readonly cwd: string;
  readonly state: TerminalState;
  readonly outputOffset: number;
  readonly promoted: false;
  readonly reason: "durable_job_runtime_not_attached";
}

export class TerminalService {
  readonly #database: OperationalDatabase;
  readonly #allowedShells: ReadonlySet<TerminalShell>;
  readonly #maxBufferBytes: number;
  readonly #now: () => Date;
  readonly #redactOutput: (value: string) => string;
  readonly #live = new Map<string, LiveTerminal>();

  public constructor(options: TerminalServiceOptions) {
    this.#database = options.database;
    this.#allowedShells = new Set(options.allowedShells);
    this.#maxBufferBytes = options.maxBufferBytes ?? 4 * 1024 * 1024;
    this.#now = options.now ?? (() => new Date());
    this.#redactOutput = options.redactOutput ?? ((value) => value);
    this.reconcileOrphans();
  }

  public async create(input: CreateTerminalInput): Promise<{ readonly terminalId: string }> {
    if (!this.#allowedShells.has(input.shell)) throw new Error(`Shell is not allowed: ${input.shell}`);
    const cwdStat = await stat(input.cwd);
    if (!cwdStat.isDirectory()) throw new Error(`Terminal cwd is not a directory: ${input.cwd}`);
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 30;
    if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
      throw new Error("Terminal dimensions are invalid");
    }
    const terminalId = randomUUID();
    const pty = spawnPty({
      shell: input.shell,
      cwd: input.cwd,
      cols,
      rows,
      ...(input.env === undefined ? {} : { env: input.env })
    });
    const now = this.#now().toISOString();
    const output = new OutputBuffer(this.#maxBufferBytes);
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const live: LiveTerminal = {
      pty,
      output,
      exited,
      resolveExited,
      status: {
        terminalId,
        shell: input.shell,
        cwd: input.cwd,
        cols,
        rows,
        pid: pty.pid,
        state: "running",
        exitCode: null,
        signal: null,
        outputOffset: 0,
        createdAt: now,
        updatedAt: now
      }
    };
    this.#live.set(terminalId, live);
    this.persist(live.status);
    pty.onData((data) => {
      output.append(this.#redactOutput(data));
      live.status = { ...live.status, outputOffset: output.nextOffset, updatedAt: this.#now().toISOString() };
    });
    pty.onExit(({ exitCode, signal }) => {
      if (live.status.state === "closed") {
        live.resolveExited();
        return;
      }
      live.status = {
        ...live.status,
        state: "exited",
        exitCode,
        signal: signal ?? null,
        pid: null,
        outputOffset: output.nextOffset,
        updatedAt: this.#now().toISOString()
      };
      this.persist(live.status);
      live.resolveExited();
    });
    return { terminalId };
  }

  public send(terminalId: string, data: string): void {
    const live = this.requireRunning(terminalId);
    live.pty.write(data);
  }

  public sendControl(terminalId: string, control: TerminalControl): void {
    const sequences: Record<TerminalControl, string> = {
      ctrl_c: "\u0003",
      ctrl_break: "\u001c",
      eof: "\u001a"
    };
    this.send(terminalId, sequences[control]);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
      throw new Error("Terminal dimensions are invalid");
    }
    const live = this.requireRunning(terminalId);
    live.pty.resize(cols, rows);
    live.status = { ...live.status, cols, rows, updatedAt: this.#now().toISOString() };
    this.persist(live.status);
  }

  public read(terminalId: string, offset: number, limit: number): OutputPage {
    const live = this.#live.get(terminalId);
    if (!live) {
      this.loadPersisted(terminalId);
      return { data: "", nextOffset: 0, truncated: false, truncatedBefore: 0 };
    }
    return live.output.read(offset, limit);
  }

  public status(terminalId: string): TerminalStatus {
    return this.#live.get(terminalId)?.status ?? this.loadPersisted(terminalId);
  }

  public async close(terminalId: string): Promise<void> {
    const live = this.#live.get(terminalId);
    if (!live) {
      const persisted = this.loadPersisted(terminalId);
      if (persisted.state !== "closed") this.persist({ ...persisted, state: "closed", updatedAt: this.#now().toISOString() });
      return;
    }
    const wasRunning = live.status.state === "running";
    live.status = {
      ...live.status,
      state: "closed",
      pid: null,
      outputOffset: live.output.nextOffset,
      updatedAt: this.#now().toISOString()
    };
    this.persist(live.status);
    if (wasRunning) {
      await execFileAsync("taskkill.exe", ["/PID", String(live.pty.pid), "/T", "/F"], {
        windowsHide: true
      }).catch(() => undefined);
      await Promise.race([
        live.exited,
        new Promise<void>((resolve) => setTimeout(resolve, 500))
      ]);
    }
  }

  public promoteToJob(terminalId: string): PromotionMetadata {
    const current = this.status(terminalId);
    return {
      terminalId,
      shell: current.shell,
      cwd: current.cwd,
      state: current.state,
      outputOffset: current.outputOffset,
      promoted: false,
      reason: "durable_job_runtime_not_attached"
    };
  }

  private requireRunning(terminalId: string): LiveTerminal {
    const live = this.#live.get(terminalId);
    if (!live || live.status.state !== "running") throw new Error(`Terminal is not running: ${terminalId}`);
    return live;
  }

  private persist(status: TerminalStatus): void {
    this.#database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO operational_state(namespace, key, value_json, updated_at)
         VALUES ('terminal', ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      ).run(status.terminalId, JSON.stringify(status), status.updatedAt);
    });
  }

  private loadPersisted(terminalId: string): TerminalStatus {
    const row = this.#database.read((connection) =>
      connection.prepare(
        "SELECT value_json FROM operational_state WHERE namespace = 'terminal' AND key = ?"
      ).get(terminalId) as { value_json: string } | undefined
    );
    if (!row) throw new Error(`Unknown terminal: ${terminalId}`);
    return JSON.parse(row.value_json) as TerminalStatus;
  }

  private reconcileOrphans(): void {
    const rows = this.#database.read((connection) =>
      connection.prepare(
        "SELECT key, value_json FROM operational_state WHERE namespace = 'terminal'"
      ).all() as Array<{ key: string; value_json: string }>
    );
    for (const row of rows) {
      const status = JSON.parse(row.value_json) as TerminalStatus;
      if (status.state === "running") {
        this.persist({
          ...status,
          state: "orphaned",
          pid: null,
          exitCode: null,
          signal: null,
          updatedAt: this.#now().toISOString()
        });
      }
    }
  }
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  return new TerminalService(options);
}

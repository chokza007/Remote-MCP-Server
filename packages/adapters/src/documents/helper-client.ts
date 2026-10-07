import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";

export interface DocumentProgress {
  readonly progress: number;
  readonly message: string;
}

export interface HelperRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (event: DocumentProgress) => void;
}

export interface DocumentHelperClientOptions {
  readonly helperRoot: string;
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxLineBytes?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly onProgress?: (event: DocumentProgress) => void;
}

interface HelperFrame {
  readonly v?: unknown;
  readonly id?: unknown;
  readonly type?: unknown;
  readonly result?: unknown;
  readonly progress?: unknown;
  readonly message?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly retryable?: unknown;
    readonly suggestedAction?: unknown;
    readonly target?: unknown;
  };
}

export class DocumentHelperClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;
  private stderr = "";
  private closed = false;

  public constructor(options: DocumentHelperClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
    this.child = spawn(options.pythonExecutable ?? "python", ["-m", "remote_mcp_docs"], {
      cwd: resolve(options.helperRoot),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-this.maxLineBytes);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.acceptLine(line));
    this.child.once("error", (cause) => this.failAll(this.error(
      (cause as NodeJS.ErrnoException).code === "ENOENT" ? "CAPABILITY_UNAVAILABLE" : "DOCUMENT_HELPER_FAILED",
      "The document helper could not be started.",
      cause
    )));
    this.child.once("exit", (code) => {
      if (!this.closed) this.failAll(this.error("DOCUMENT_HELPER_FAILED", `The document helper exited with code ${code ?? -1}.`, this.stderr));
    });
  }

  public request<T>(method: string, params: Readonly<Record<string, unknown>>, options: HelperRequestOptions = {}): Promise<T> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(this.error("DOCUMENT_HELPER_FAILED", "The document helper is not running."));
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.error("DOCUMENT_CANCELLED", "The document operation was cancelled."));
    }
    const id = randomUUID();
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const remove = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        remove();
        rejectRequest(this.error("DOCUMENT_TIMEOUT", `Document operation exceeded ${options.timeoutMs ?? this.timeoutMs} ms.`));
      }, options.timeoutMs ?? this.timeoutMs);
      timer.unref();
      const abort = options.signal === undefined ? undefined : (): void => {
        remove();
        rejectRequest(this.error("DOCUMENT_CANCELLED", "The document operation was cancelled."));
      };
      const pending: PendingRequest = {
        resolve: (value) => { remove(); resolveRequest(value as T); },
        reject: (error) => { remove(); rejectRequest(error); },
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abort === undefined ? {} : { abort }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress })
      };
      this.pending.set(id, pending);
      options.signal?.addEventListener("abort", abort!, { once: true });
      this.child.stdin.write(`${JSON.stringify({ v: "1", id, method, params })}\n`, "utf8", (error) => {
        if (error) pending.reject(this.error("DOCUMENT_HELPER_FAILED", "Unable to send a request to the document helper.", error));
      });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      if (this.child.exitCode !== null) {
        resolveClose();
        return;
      }
      const timer = setTimeout(() => { this.child.kill(); resolveClose(); }, 1_000);
      timer.unref();
      this.child.once("exit", () => { clearTimeout(timer); resolveClose(); });
    });
    this.failAll(this.error("DOCUMENT_HELPER_FAILED", "The document helper was closed."));
  }

  private acceptLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      this.failAll(this.error("DOCUMENT_OUTPUT_LIMIT", "A document helper response exceeded the output limit."));
      this.child.kill();
      return;
    }
    let frame: HelperFrame;
    try {
      frame = JSON.parse(line) as HelperFrame;
    } catch (cause) {
      this.failAll(this.error("DOCUMENT_PROTOCOL_INVALID", "The document helper returned malformed JSON.", cause));
      this.child.kill();
      return;
    }
    if (frame.v !== "1" || typeof frame.id !== "string" || typeof frame.type !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === "progress") {
      if (typeof frame.progress === "number" && typeof frame.message === "string") {
        pending.onProgress?.({ progress: frame.progress, message: frame.message });
      }
      return;
    }
    if (frame.type === "result") {
      pending.resolve(frame.result);
      return;
    }
    if (frame.type === "error") {
      const remote = frame.error ?? {};
      pending.reject(new RemoteMcpError({
        errorCode: typeof remote.code === "string" ? remote.code : "DOCUMENT_HELPER_FAILED",
        message: typeof remote.message === "string" ? remote.message : "Document helper request failed.",
        retryable: remote.retryable === true,
        suggestedAction: typeof remote.suggestedAction === "string" ? remote.suggestedAction : "Inspect the input and helper capabilities.",
        target: typeof remote.target === "string" ? remote.target : "document-helper"
      }));
    }
  }

  private failAll(error: RemoteMcpError): void {
    for (const request of [...this.pending.values()]) request.reject(error);
  }

  private error(errorCode: string, message: string, cause?: unknown): RemoteMcpError {
    return new RemoteMcpError({
      errorCode,
      message,
      retryable: errorCode === "DOCUMENT_TIMEOUT",
      suggestedAction: "Check the pinned Python helper dependencies and document validity before retrying.",
      target: "document-helper",
      cause
    });
  }
}

export function createDocumentHelperClient(options: DocumentHelperClientOptions): DocumentHelperClient {
  return new DocumentHelperClient(options);
}

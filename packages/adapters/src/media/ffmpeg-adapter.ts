import { spawn } from "node:child_process";

import { RemoteMcpError } from "@remote-mcp/contracts";

export interface MediaCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface MediaCommandControl {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface MediaCommandResult {
  readonly command: MediaCommand;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface FfmpegAdapterOptions {
  readonly ffmpegExecutable?: string;
  readonly ffprobeExecutable?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class FfmpegAdapter {
  public readonly ffmpegExecutable: string;
  public readonly ffprobeExecutable: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(options: FfmpegAdapterOptions = {}) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
    this.ffprobeExecutable = options.ffprobeExecutable ?? "ffprobe";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  }

  public ffmpeg(arguments_: readonly string[], control: MediaCommandControl = {}): Promise<MediaCommandResult> {
    return this.run(this.ffmpegExecutable, arguments_, control);
  }

  public ffprobe(arguments_: readonly string[], control: MediaCommandControl = {}): Promise<MediaCommandResult> {
    return this.run(this.ffprobeExecutable, arguments_, control);
  }

  private run(executable: string, arguments_: readonly string[], control: MediaCommandControl): Promise<MediaCommandResult> {
    const command = { executable, arguments: [...arguments_] } satisfies MediaCommand;
    const outputLimit = control.maxOutputBytes ?? this.maxOutputBytes;
    const timeoutMs = control.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      if (control.signal?.aborted) {
        reject(this.error("MEDIA_CANCELLED", "The media operation was cancelled.", executable));
        return;
      }

      const child = spawn(executable, [...arguments_], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;

      const finish = (error?: unknown, result?: MediaCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        control.signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.byteLength > outputLimit) {
          child.kill();
          finish(this.error("MEDIA_OUTPUT_LIMIT", "The media command exceeded its diagnostic output limit.", executable));
        }
        return next.subarray(0, outputLimit);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });

      const abort = (): void => {
        child.kill();
        finish(this.error("MEDIA_CANCELLED", "The media operation was cancelled.", executable));
      };
      control.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        child.kill();
        finish(this.error("MEDIA_TIMEOUT", `The media command exceeded ${timeoutMs} ms.`, executable));
      }, timeoutMs);
      timer.unref();

      child.once("error", (cause) => {
        const unavailable = (cause as NodeJS.ErrnoException).code === "ENOENT";
        finish(this.error(
          unavailable ? "CAPABILITY_UNAVAILABLE" : "MEDIA_EXECUTION_FAILED",
          unavailable ? `${executable} is not installed or is not on PATH.` : `Unable to start ${executable}.`,
          executable,
          cause
        ));
      });
      child.once("close", (exitCode) => {
        const result = {
          command,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          exitCode: exitCode ?? -1
        };
        if (result.exitCode !== 0) {
          finish(this.error(
            executable.toLowerCase().includes("probe") ? "MEDIA_INVALID" : "MEDIA_EXECUTION_FAILED",
            `${executable} failed with exit code ${result.exitCode}.`,
            executable,
            result.stderr
          ));
          return;
        }
        finish(undefined, result);
      });
    });
  }

  private error(errorCode: string, message: string, target: string, cause?: unknown): RemoteMcpError {
    return new RemoteMcpError({
      errorCode,
      message,
      retryable: errorCode === "MEDIA_TIMEOUT",
      suggestedAction: "Inspect the input, available codecs, and the bounded command diagnostics before retrying.",
      target,
      cause
    });
  }
}

export function createFfmpegAdapter(options: FfmpegAdapterOptions = {}): FfmpegAdapter {
  return new FfmpegAdapter(options);
}

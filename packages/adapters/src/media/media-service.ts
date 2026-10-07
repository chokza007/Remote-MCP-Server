import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";

import {
  createFfmpegAdapter,
  type FfmpegAdapter,
  type FfmpegAdapterOptions,
  type MediaCommand,
  type MediaCommandControl
} from "./ffmpeg-adapter.js";
import {
  verifyMediaProbe,
  type MediaVerificationExpectation,
  type MediaVerificationResult
} from "./media-verifier.js";

export interface MediaStream {
  readonly index: number;
  readonly codecType: string;
  readonly codecName: string;
  readonly width?: number;
  readonly height?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly colorPrimaries?: string;
  readonly colorTransfer?: string;
  readonly colorSpace?: string;
  readonly rotation?: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface MediaProbe {
  readonly path: string;
  readonly durationSeconds: number;
  readonly format: {
    readonly name: string;
    readonly sizeBytes: number;
    readonly bitRate?: number;
    readonly tags: Readonly<Record<string, string>>;
  };
  readonly streams: readonly MediaStream[];
}

export interface MediaMutationInput {
  readonly input: string;
  readonly output: string;
  readonly overwrite?: boolean;
  readonly control?: MediaCommandControl;
}

export interface MediaMutationResult {
  readonly output: string;
  readonly verified: true;
  readonly probe: MediaProbe;
  readonly command: MediaCommand;
}

export interface TranscodeInput extends MediaMutationInput {
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly videoBitrate?: string;
  readonly audioBitrate?: string;
}

export interface TrimInput extends MediaMutationInput {
  readonly startSeconds?: number;
  readonly durationSeconds: number;
}

export interface ConcatInput {
  readonly inputs: readonly string[];
  readonly output: string;
  readonly overwrite?: boolean;
  readonly control?: MediaCommandControl;
}

export interface ExtractFramesInput {
  readonly input: string;
  readonly outputDirectory: string;
  readonly timestampsSeconds: readonly number[];
  readonly control?: MediaCommandControl;
}

export interface ExtractFramesResult {
  readonly outputs: readonly string[];
  readonly commands: readonly MediaCommand[];
}

export interface MediaServiceOptions extends FfmpegAdapterOptions {
  readonly adapter?: FfmpegAdapter;
}

interface RawProbe {
  readonly format?: { readonly format_name?: string; readonly duration?: string; readonly size?: string; readonly bit_rate?: string; readonly tags?: Record<string, unknown> };
  readonly streams?: readonly Record<string, unknown>[];
}

function tags(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rotation(stream: Record<string, unknown>): number | undefined {
  const streamTags = tags(stream.tags);
  const tagged = number(streamTags.rotate);
  if (tagged !== undefined) return tagged;
  if (Array.isArray(stream.side_data_list)) {
    for (const item of stream.side_data_list) {
      if (typeof item === "object" && item !== null) {
        const value = number((item as Record<string, unknown>).rotation);
        if (value !== undefined) return value;
      }
    }
  }
  return undefined;
}

async function ensureSource(path: string): Promise<string> {
  const normalized = resolve(path);
  const info = await stat(normalized).catch(() => undefined);
  if (!info?.isFile()) {
    throw new RemoteMcpError({
      errorCode: "MEDIA_INVALID",
      message: "The media input does not exist or is not a regular file.",
      retryable: false,
      suggestedAction: "Choose an existing regular media file.",
      target: normalized
    });
  }
  return normalized;
}

export class MediaService {
  private readonly adapter: FfmpegAdapter;

  public constructor(options: MediaServiceOptions = {}) {
    this.adapter = options.adapter ?? createFfmpegAdapter(options);
  }

  public async probe(path: string, control: MediaCommandControl = {}): Promise<MediaProbe> {
    const input = await ensureSource(path);
    const result = await this.adapter.ffprobe([
      "-v", "error", "-show_format", "-show_streams", "-of", "json", input
    ], control);
    let raw: RawProbe;
    try {
      raw = JSON.parse(result.stdout) as RawProbe;
    } catch (cause) {
      throw new RemoteMcpError({
        errorCode: "MEDIA_INVALID",
        message: "ffprobe returned malformed media information.",
        retryable: false,
        suggestedAction: "Check that the input is a supported, non-corrupt media file.",
        target: input,
        cause
      });
    }
    const format = raw.format ?? {};
    const durationSeconds = number(format.duration);
    if (durationSeconds === undefined || !Array.isArray(raw.streams)) {
      throw new RemoteMcpError({
        errorCode: "MEDIA_INVALID",
        message: "The input does not contain valid media streams or duration information.",
        retryable: false,
        suggestedAction: "Use a supported, non-corrupt media file.",
        target: input
      });
    }
    return {
      path: input,
      durationSeconds,
      format: {
        name: String(format.format_name ?? "unknown"),
        sizeBytes: number(format.size) ?? 0,
        ...(number(format.bit_rate) === undefined ? {} : { bitRate: number(format.bit_rate)! }),
        tags: tags(format.tags)
      },
      streams: raw.streams.map((stream, index) => {
        const width = number(stream.width);
        const height = number(stream.height);
        const sampleRate = number(stream.sample_rate);
        const channels = number(stream.channels);
        const streamRotation = rotation(stream);
        return {
          index: number(stream.index) ?? index,
          codecType: String(stream.codec_type ?? "unknown"),
          codecName: String(stream.codec_name ?? "unknown"),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(sampleRate === undefined ? {} : { sampleRate }),
          ...(channels === undefined ? {} : { channels }),
          ...(stream.color_primaries === undefined ? {} : { colorPrimaries: String(stream.color_primaries) }),
          ...(stream.color_transfer === undefined ? {} : { colorTransfer: String(stream.color_transfer) }),
          ...(stream.color_space === undefined ? {} : { colorSpace: String(stream.color_space) }),
          ...(streamRotation === undefined ? {} : { rotation: streamRotation }),
          tags: tags(stream.tags)
        };
      })
    };
  }

  public async verify(path: string, expectation: MediaVerificationExpectation = {}, control: MediaCommandControl = {}): Promise<MediaVerificationResult> {
    return verifyMediaProbe(await this.probe(path, control), expectation);
  }

  public remux(input: MediaMutationInput): Promise<MediaMutationResult> {
    return this.mutate(input, ["-map", "0", "-c", "copy", "-map_metadata", "0"], {});
  }

  public transcode(input: TranscodeInput): Promise<MediaMutationResult> {
    const args = ["-map", "0"];
    if (input.videoCodec) args.push("-c:v", input.videoCodec);
    if (input.audioCodec) args.push("-c:a", input.audioCodec);
    if (input.videoBitrate) args.push("-b:v", input.videoBitrate);
    if (input.audioBitrate) args.push("-b:a", input.audioBitrate);
    args.push("-map_metadata", "0");
    return this.mutate(input, args, {});
  }

  public trim(input: TrimInput): Promise<MediaMutationResult> {
    if (!(input.durationSeconds > 0) || (input.startSeconds ?? 0) < 0) {
      return Promise.reject(new RemoteMcpError({
        errorCode: "MEDIA_INVALID_ARGUMENT",
        message: "Trim duration must be positive and start must not be negative.",
        retryable: false,
        suggestedAction: "Provide a non-negative start and a positive duration.",
        target: input.input
      }));
    }
    const args = [
      "-ss", String(input.startSeconds ?? 0), "-t", String(input.durationSeconds),
      "-map", "0", "-c:v", "libx264", "-c:a", "aac", "-map_metadata", "0", "-avoid_negative_ts", "make_zero"
    ];
    return this.mutate(input, args, { durationSeconds: input.durationSeconds, durationToleranceSeconds: 0.12 });
  }

  public async concat(input: ConcatInput): Promise<MediaMutationResult> {
    if (input.inputs.length < 1) {
      throw new RemoteMcpError({
        errorCode: "MEDIA_INVALID_ARGUMENT", message: "At least one input is required for concatenation.", retryable: false,
        suggestedAction: "Provide one or more compatible media paths.", target: input.output
      });
    }
    const sources = await Promise.all(input.inputs.map(ensureSource));
    const expectedDuration = (await Promise.all(sources.map((source) => this.probe(source, input.control))))
      .reduce((sum, probe) => sum + probe.durationSeconds, 0);
    const listPath = join(dirname(resolve(input.output)), `.remote-mcp-concat-${randomUUID()}.ffconcat`);
    await mkdir(dirname(listPath), { recursive: true });
    const escape = (path: string): string => path.replaceAll("\\", "/").replaceAll("'", "'\\''");
    await writeFile(listPath, `ffconcat version 1.0\n${sources.map((source) => `file '${escape(source)}'`).join("\n")}\n`, "utf8");
    try {
      return await this.mutate(
        {
          input: listPath,
          output: input.output,
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
          ...(input.control === undefined ? {} : { control: input.control })
        },
        ["-c", "copy", "-map_metadata", "0"],
        { durationSeconds: expectedDuration, durationToleranceSeconds: 0.15 },
        ["-f", "concat", "-safe", "0"]
      );
    } finally {
      await rm(listPath, { force: true });
    }
  }

  public removeMetadata(input: MediaMutationInput): Promise<MediaMutationResult> {
    return this.mutate(input, ["-map", "0", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1"], { metadataAbsent: ["title"] });
  }

  public extractAudio(input: MediaMutationInput): Promise<MediaMutationResult> {
    return this.mutate(input, ["-map", "0:a:0", "-vn", "-c:a", "copy", "-map_metadata", "0"], { audioStreams: 1, videoStreams: 0 });
  }

  public async extractFrames(input: ExtractFramesInput): Promise<ExtractFramesResult> {
    const source = await ensureSource(input.input);
    await mkdir(input.outputDirectory, { recursive: true });
    const outputs: string[] = [];
    const commands: MediaCommand[] = [];
    for (let index = 0; index < input.timestampsSeconds.length; index += 1) {
      const timestamp = input.timestampsSeconds[index]!;
      if (timestamp < 0) throw new RemoteMcpError({
        errorCode: "MEDIA_INVALID_ARGUMENT", message: "Frame timestamps must not be negative.", retryable: false,
        suggestedAction: "Provide timestamps at or after zero seconds.", target: source
      });
      const output = resolve(input.outputDirectory, `frame-${String(index + 1).padStart(4, "0")}.png`);
      const result = await this.adapter.ffmpeg([
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(timestamp), "-i", source,
        "-frames:v", "1", "-map_metadata", "-1", output
      ], input.control);
      await ensureSource(output);
      outputs.push(output);
      commands.push(result.command);
    }
    return { outputs, commands };
  }

  private async mutate(
    input: MediaMutationInput,
    outputArguments: readonly string[],
    expectation: MediaVerificationExpectation,
    inputArguments: readonly string[] = []
  ): Promise<MediaMutationResult> {
    const source = await ensureSource(input.input);
    const output = resolve(input.output);
    const existing = await stat(output).catch(() => undefined);
    if (existing && !input.overwrite) {
      throw new RemoteMcpError({
        errorCode: "MEDIA_OUTPUT_EXISTS", message: "The media destination already exists.", retryable: false,
        suggestedAction: "Choose a new destination or explicitly allow overwrite.", target: output
      });
    }
    await mkdir(dirname(output), { recursive: true });
    const extension = extname(output);
    const temporary = join(dirname(output), `.${basename(output, extension)}.${randomUUID()}.tmp${extension}`);
    let command: MediaCommand | undefined;
    try {
      const result = await this.adapter.ffmpeg([
        "-hide_banner", "-loglevel", "error", "-y", ...inputArguments, "-i", source,
        ...outputArguments, temporary
      ], input.control);
      command = result.command;
      const verification = await this.verify(temporary, expectation, input.control);
      await rename(temporary, output);
      return { output, verified: true, probe: { ...verification.probe, path: output }, command };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export function createMediaService(options: MediaServiceOptions = {}): MediaService {
  return new MediaService(options);
}

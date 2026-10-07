import { z } from "zod";

import type { MediaService, MediaVerificationExpectation } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const path = z.string().min(1);
const overwrite = z.boolean().optional();

function mutationDescriptor(name: string, title: string, description: string) {
  return {
    ...coreDescriptor(name, title, description, 2),
    defaultTimeoutMs: 120_000,
    cancellable: true
  };
}

export function registerMediaTools(registry: ToolRegistry, media: MediaService): void {
  registry.register(
    coreDescriptor("media_probe", "Probe media", "Reads stream, duration, rotation, color, audio, and format metadata with ffprobe.", 0),
    async (args) => ({ schemaVersion: 1, probe: await media.probe(String(args.path)) }),
    { inputSchema: { path } }
  );

  registry.register(
    mutationDescriptor("media_remux", "Remux media", "Copies all compatible streams into a new container and verifies the output."),
    async (args) => ({ schemaVersion: 1, ...(await media.remux({
      input: String(args.input), output: String(args.output),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    { inputSchema: { input: path, output: path, overwrite } }
  );

  registry.register(
    mutationDescriptor("media_transcode", "Transcode media", "Transcodes media with explicit codecs and verifies the output before atomic publication."),
    async (args) => ({ schemaVersion: 1, ...(await media.transcode({
      input: String(args.input), output: String(args.output),
      ...(args.videoCodec === undefined ? {} : { videoCodec: String(args.videoCodec) }),
      ...(args.audioCodec === undefined ? {} : { audioCodec: String(args.audioCodec) }),
      ...(args.videoBitrate === undefined ? {} : { videoBitrate: String(args.videoBitrate) }),
      ...(args.audioBitrate === undefined ? {} : { audioBitrate: String(args.audioBitrate) }),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    {
      inputSchema: {
        input: path, output: path, overwrite,
        videoCodec: z.string().min(1).max(128).optional(),
        audioCodec: z.string().min(1).max(128).optional(),
        videoBitrate: z.string().min(1).max(32).optional(),
        audioBitrate: z.string().min(1).max(32).optional()
      }
    }
  );

  registry.register(
    mutationDescriptor("media_trim", "Trim media", "Creates an exact re-encoded time range and verifies its duration."),
    async (args) => ({ schemaVersion: 1, ...(await media.trim({
      input: String(args.input), output: String(args.output),
      startSeconds: Number(args.startSeconds ?? 0), durationSeconds: Number(args.durationSeconds),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    {
      inputSchema: {
        input: path, output: path, overwrite,
        startSeconds: z.number().nonnegative().optional(), durationSeconds: z.number().positive()
      }
    }
  );

  registry.register(
    mutationDescriptor("media_concat", "Concatenate media", "Concatenates compatible media inputs and verifies the combined duration."),
    async (args) => ({ schemaVersion: 1, ...(await media.concat({
      inputs: args.inputs as string[], output: String(args.output),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    { inputSchema: { inputs: z.array(path).min(1).max(1_000), output: path, overwrite } }
  );

  registry.register(
    mutationDescriptor("media_extract_frames", "Extract media frames", "Extracts lossless PNG frames at explicit timestamps."),
    async (args) => ({ schemaVersion: 1, ...(await media.extractFrames({
      input: String(args.input), outputDirectory: String(args.outputDirectory),
      timestampsSeconds: args.timestampsSeconds as number[]
    })) }),
    {
      inputSchema: {
        input: path, outputDirectory: path,
        timestampsSeconds: z.array(z.number().nonnegative()).min(1).max(10_000)
      }
    }
  );

  registry.register(
    mutationDescriptor("media_remove_metadata", "Remove media metadata", "Copies media streams while removing global metadata and chapters."),
    async (args) => ({ schemaVersion: 1, ...(await media.removeMetadata({
      input: String(args.input), output: String(args.output),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    { inputSchema: { input: path, output: path, overwrite } }
  );

  registry.register(
    mutationDescriptor("media_extract_audio", "Extract media audio", "Copies the first audio stream to a verified standalone output."),
    async (args) => ({ schemaVersion: 1, ...(await media.extractAudio({
      input: String(args.input), output: String(args.output),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    { inputSchema: { input: path, output: path, overwrite } }
  );

  registry.register(
    coreDescriptor("media_verify", "Verify media", "Checks media duration, stream counts, codecs, and absent metadata against expectations.", 0),
    async (args) => ({ schemaVersion: 1, ...(await media.verify(String(args.path), args.expectation as MediaVerificationExpectation)) }),
    {
      inputSchema: {
        path,
        expectation: z.object({
          durationSeconds: z.number().nonnegative().optional(),
          durationToleranceSeconds: z.number().nonnegative().optional(),
          videoStreams: z.number().int().nonnegative().optional(),
          audioStreams: z.number().int().nonnegative().optional(),
          codecs: z.array(z.string().min(1)).optional(),
          metadataAbsent: z.array(z.string().min(1)).optional()
        }).optional()
      }
    }
  );
}

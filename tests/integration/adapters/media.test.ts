import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createMediaService, type MediaService } from "@remote-mcp/adapters";

const execFileAsync = promisify(execFile);

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("media adapter", () => {
  let root: string;
  let source: string;
  let service: MediaService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-media-"));
    const plain = join(root, "plain.mp4");
    source = join(root, "ต้นฉบับ media source.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=2",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-c:a", "aac", "-ac", "2", "-metadata", "title=MEDIA_METADATA_CANARY", "-shortest", plain
    ]);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-display_rotation:v:0", "90", "-i", plain,
      "-map", "0", "-c", "copy", "-map_metadata", "0", source
    ]);
    service = createMediaService();
  }, 30_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("probes video, audio, rotation, color, and format metadata without changing the source", async () => {
    const original = await sha256(source);
    const probe = await service.probe(source);
    expect(probe.durationSeconds).toBeCloseTo(2, 1);
    expect(probe.format.tags.title).toBe("MEDIA_METADATA_CANARY");
    expect(probe.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codecType: "video", width: 160, height: 120, colorPrimaries: "bt709", rotation: 90 }),
      expect.objectContaining({ codecType: "audio", sampleRate: 48_000, channels: 2 })
    ]));
    expect(await sha256(source)).toBe(original);
  });

  test("remuxes with stream properties preserved and removes metadata without touching the original", async () => {
    const original = await sha256(source);
    const remuxed = join(root, "remuxed output.mp4");
    const remux = await service.remux({ input: source, output: remuxed });
    expect(remux).toMatchObject({ verified: true, output: remuxed, command: { executable: expect.stringMatching(/ffmpeg/i) } });
    const sourceProbe = await service.probe(source);
    const remuxProbe = await service.probe(remuxed);
    expect(remuxProbe.streams.map((stream) => stream.codecName)).toEqual(sourceProbe.streams.map((stream) => stream.codecName));
    expect(remuxProbe.streams.find((stream) => stream.codecType === "audio")).toMatchObject({ sampleRate: 48_000, channels: 2 });

    const cleaned = join(root, "metadata removed.mp4");
    await service.removeMetadata({ input: source, output: cleaned });
    expect((await service.probe(cleaned)).format.tags.title).toBeUndefined();
    expect(await sha256(source)).toBe(original);
  }, 30_000);

  test("trims and concatenates to verified duration tolerances", async () => {
    const trimmed = join(root, "trimmed.mp4");
    await service.trim({ input: source, output: trimmed, startSeconds: 0.4, durationSeconds: 0.75 });
    expect((await service.probe(trimmed)).durationSeconds).toBeCloseTo(0.75, 1);

    const concatenated = join(root, "concatenated.mp4");
    await service.concat({ inputs: [source, source], output: concatenated });
    expect((await service.probe(concatenated)).durationSeconds).toBeCloseTo(4, 1);
    await expect(service.verify(concatenated, { durationSeconds: 4, durationToleranceSeconds: 0.12, videoStreams: 1, audioStreams: 1 }))
      .resolves.toMatchObject({ valid: true });
  }, 30_000);

  test("transcodes, extracts audio and frames, rejects corrupt input, and preserves originals", async () => {
    const original = await sha256(source);
    const transcoded = join(root, "transcoded.mp4");
    await service.transcode({ input: source, output: transcoded, videoCodec: "libx264", audioCodec: "aac" });
    expect((await service.probe(transcoded)).streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codecType: "video", codecName: "h264" }),
      expect.objectContaining({ codecType: "audio", codecName: "aac" })
    ]));

    const audio = join(root, "extracted audio.m4a");
    await service.extractAudio({ input: source, output: audio });
    const audioProbe = await service.probe(audio);
    expect(audioProbe.streams.some((stream) => stream.codecType === "audio")).toBe(true);
    expect(audioProbe.streams.some((stream) => stream.codecType === "video")).toBe(false);

    const frames = await service.extractFrames({ input: source, outputDirectory: join(root, "frames"), timestampsSeconds: [0.25, 1.25] });
    expect(frames.outputs).toHaveLength(2);
    await expect(Promise.all(frames.outputs.map((path) => readFile(path)))).resolves.toHaveLength(2);

    const corrupt = join(root, "corrupt.mp4");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(corrupt, "not media", "utf8"));
    await expect(service.probe(corrupt)).rejects.toMatchObject({ errorCode: "MEDIA_INVALID" });
    expect(await sha256(source)).toBe(original);
  }, 30_000);
});

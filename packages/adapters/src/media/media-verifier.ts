import { RemoteMcpError } from "@remote-mcp/contracts";

import type { MediaProbe, MediaStream } from "./media-service.js";

export interface MediaVerificationExpectation {
  readonly durationSeconds?: number;
  readonly durationToleranceSeconds?: number;
  readonly videoStreams?: number;
  readonly audioStreams?: number;
  readonly codecs?: readonly string[];
  readonly metadataAbsent?: readonly string[];
}

export interface MediaVerificationResult {
  readonly valid: true;
  readonly checks: readonly string[];
  readonly probe: MediaProbe;
}

function count(streams: readonly MediaStream[], type: string): number {
  return streams.filter((stream) => stream.codecType === type).length;
}

export function verifyMediaProbe(probe: MediaProbe, expectation: MediaVerificationExpectation = {}): MediaVerificationResult {
  const failures: string[] = [];
  const checks: string[] = [];
  if (expectation.durationSeconds !== undefined) {
    const tolerance = expectation.durationToleranceSeconds ?? 0.1;
    if (Math.abs(probe.durationSeconds - expectation.durationSeconds) > tolerance) {
      failures.push(`duration ${probe.durationSeconds} differs from ${expectation.durationSeconds} by more than ${tolerance}`);
    }
    checks.push("duration");
  }
  if (expectation.videoStreams !== undefined) {
    if (count(probe.streams, "video") !== expectation.videoStreams) failures.push("video stream count mismatch");
    checks.push("videoStreams");
  }
  if (expectation.audioStreams !== undefined) {
    if (count(probe.streams, "audio") !== expectation.audioStreams) failures.push("audio stream count mismatch");
    checks.push("audioStreams");
  }
  if (expectation.codecs !== undefined) {
    const codecs = probe.streams.map((stream) => stream.codecName);
    for (const codec of expectation.codecs) if (!codecs.includes(codec)) failures.push(`missing codec ${codec}`);
    checks.push("codecs");
  }
  if (expectation.metadataAbsent !== undefined) {
    for (const key of expectation.metadataAbsent) {
      if (Object.keys(probe.format.tags).some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
        failures.push(`metadata ${key} is still present`);
      }
    }
    checks.push("metadataAbsent");
  }
  if (failures.length > 0) {
    throw new RemoteMcpError({
      errorCode: "MEDIA_VERIFICATION_FAILED",
      message: `Media verification failed: ${failures.join("; ")}.`,
      retryable: false,
      suggestedAction: "Review the requested transformation and codec support, then retry with compatible settings.",
      target: probe.path
    });
  }
  return { valid: true, checks, probe };
}

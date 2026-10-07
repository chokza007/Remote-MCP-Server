import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createOperationalStateService,
  createRuntimeCheckpointService,
  type OperationalStateService,
  type RuntimeCheckpointService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("namespaced operational state and runtime checkpoints", () => {
  let root: string;
  let database: OperationalDatabase;
  let state: OperationalStateService;
  let checkpoints: RuntimeCheckpointService;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-state-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T00:00:00.000Z");
    state = createOperationalStateService({ database, now: () => new Date(nowMs) });
    checkpoints = createRuntimeCheckpointService({ database, now: () => new Date(nowMs) });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("isolates operational keys by namespace and supports deletion", () => {
    state.set({ namespace: "owner-a/workspace-a", key: "active-render", value: { jobId: "job-1", offset: 4 } });
    state.set({ namespace: "owner-a/workspace-b", key: "active-render", value: { jobId: "job-2" } });
    expect(state.get("owner-a/workspace-a", "active-render")).toMatchObject({ value: { jobId: "job-1", offset: 4 } });
    expect(state.list("owner-a/workspace-b")).toEqual([expect.objectContaining({ value: { jobId: "job-2" } })]);
    expect(state.delete("owner-a/workspace-a", "active-render")).toBe(true);
    expect(state.get("owner-a/workspace-a", "active-render")).toBeNull();
  });

  test("resumes runtime checkpoints after service restart and completes them durably", () => {
    const saved = checkpoints.save({
      namespace: "owner-a/workspace-a",
      operation: "media.transcode",
      state: { inputArtifactId: "artifact-1", outputOffset: 123 },
      verification: { expectedCodec: "h264" }
    });
    nowMs += 5_000;
    const restarted = createRuntimeCheckpointService({ database, now: () => new Date(nowMs) });
    expect(restarted.load(saved.checkpointId, "owner-a/workspace-a")).toMatchObject({
      state: "active", operation: "media.transcode", data: { inputArtifactId: "artifact-1", outputOffset: 123 }
    });
    expect(() => restarted.load(saved.checkpointId, "owner-a/workspace-b")).toThrow(/not exist/i);
    expect(restarted.list("owner-a/workspace-a")).toHaveLength(1);
    expect(restarted.complete(saved.checkpointId, "owner-a/workspace-a", { outputHash: "abc" })).toMatchObject({
      state: "completed", verification: { expectedCodec: "h264", outputHash: "abc" }, completedAt: expect.any(String)
    });
  });
});

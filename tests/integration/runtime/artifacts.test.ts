import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createArtifactService, type ArtifactService } from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

describe("artifact registry and content-addressed store", () => {
  let root: string;
  let database: OperationalDatabase;
  let artifacts: ArtifactService;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-artifacts-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    nowMs = Date.parse("2026-10-07T00:00:00.000Z");
    artifacts = createArtifactService({ database, storeRoot: join(root, "store"), now: () => new Date(nowMs) });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("stores managed content by SHA-256, verifies it, records lineage, and isolates workspaces", async () => {
    const source = join(root, "result.bin");
    await writeFile(source, "artifact payload", "utf8");
    const expectedHash = createHash("sha256").update("artifact payload", "utf8").digest("hex");
    const first = await artifacts.register({
      namespace: "owner-a", workspaceId: "workspace-a", sourcePath: source, kind: "result", storage: "managed"
    });
    const second = await artifacts.register({
      namespace: "owner-a", workspaceId: "workspace-a", sourcePath: source, kind: "derived", storage: "managed"
    });
    expect(first).toMatchObject({ contentHash: expectedHash, validationState: "valid", storage: "managed" });
    expect(first.canonicalLocation).toBe(second.canonicalLocation);
    expect(await readFile(first.canonicalLocation, "utf8")).toBe("artifact payload");
    expect(await artifacts.verify(first.artifactId, "owner-a", "workspace-a")).toMatchObject({ validationState: "valid" });

    const relation = artifacts.relate({
      namespace: "owner-a", workspaceId: "workspace-a",
      parentArtifactId: first.artifactId, childArtifactId: second.artifactId, relation: "produced"
    });
    expect(relation).toMatchObject({ parentArtifactId: first.artifactId, childArtifactId: second.artifactId });
    expect(artifacts.lineage(second.artifactId, "owner-a", "workspace-a").parents).toEqual([relation]);
    expect(artifacts.list("owner-a", "workspace-b")).toHaveLength(0);
    expect(() => artifacts.get(first.artifactId, "owner-b", "workspace-a")).toThrow(/not exist/i);

    const restarted = createArtifactService({ database, storeRoot: join(root, "store"), now: () => new Date(nowMs) });
    expect(restarted.get(first.artifactId, "owner-a", "workspace-a").contentHash).toBe(expectedHash);
  });

  test("detects missing references, relocates by verified hash, and enforces retention", async () => {
    const original = join(root, "referenced.txt");
    const moved = join(root, "moved.txt");
    await writeFile(original, "reference payload", "utf8");
    const artifact = await artifacts.register({
      namespace: "owner-a", workspaceId: "workspace-a", sourcePath: original, kind: "reference", storage: "reference"
    });
    await rename(original, moved);
    expect(await artifacts.verify(artifact.artifactId, "owner-a", "workspace-a")).toMatchObject({ validationState: "missing" });
    expect(await artifacts.verify(artifact.artifactId, "owner-a", "workspace-a", [moved])).toMatchObject({
      validationState: "valid", canonicalLocation: moved, relocated: true
    });

    const retained = artifacts.retain(artifact.artifactId, "owner-a", "workspace-a", {
      pinned: true, retainUntil: "2099-01-01T00:00:00.000Z"
    });
    expect(retained.retention).toMatchObject({ pinned: true });
    await expect(artifacts.delete(artifact.artifactId, "owner-a", "workspace-a")).rejects.toThrow(/retention/i);
    expect((await artifacts.delete(artifact.artifactId, "owner-a", "workspace-a", { force: true })).deleted).toBe(true);
  });

  test("does not remove shared managed bytes until the last registry reference is deleted", async () => {
    const source = join(root, "shared.bin");
    await writeFile(source, "shared", "utf8");
    const first = await artifacts.register({ namespace: "owner", workspaceId: "one", sourcePath: source, kind: "one", storage: "managed" });
    const second = await artifacts.register({ namespace: "owner", workspaceId: "two", sourcePath: source, kind: "two", storage: "managed" });
    await artifacts.delete(first.artifactId, "owner", "one", { force: true });
    await expect(access(first.canonicalLocation)).resolves.toBeUndefined();
    await artifacts.delete(second.artifactId, "owner", "two", { force: true });
    await expect(access(first.canonicalLocation)).rejects.toThrow();
  });
});

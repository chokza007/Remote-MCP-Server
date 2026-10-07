import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createFilesystemAdapter, createProjectCheckpointHelper } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createArtifactService } from "@remote-mcp/runtime";

describe("project-owned checkpoint boundary", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("discovers, reads, and atomically updates a project checkpoint without copying its body into MCP state", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-project-boundary-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const checkpointPath = join(root, "WORK_CHECKPOINT.md");
    const overviewCanary = "PROJECT_OVERVIEW_BODY_MUST_STAY_HERE_73f0";
    const checkpointCanary = "CHECKPOINT_BODY_MUST_STAY_HERE_91ac";
    const updatedCanary = "UPDATED_CHECKPOINT_BODY_MUST_STAY_HERE_112e";
    await writeFile(join(root, "PROJECT_OVERVIEW.md"), overviewCanary, "utf8");
    await writeFile(checkpointPath, checkpointCanary, "utf8");

    const database = openDatabase({ filename: join(root, "operational.db") });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const artifacts = createArtifactService({ database, storeRoot: join(root, ".artifact-store") });
    const helper = createProjectCheckpointHelper({
      filesystem: createFilesystemAdapter({ allowedRoots: [root] }),
      artifacts
    });

    expect(await helper.discover(root)).toEqual([expect.objectContaining({ path: checkpointPath, kind: "checkpoint" })]);
    expect(await helper.read({ projectRoot: root, path: checkpointPath })).toMatchObject({ content: checkpointCanary });
    const update = await helper.update({
      namespace: "owner-a", workspaceId: "workspace-a", projectRoot: root,
      path: checkpointPath, content: updatedCanary
    });
    expect(await readFile(checkpointPath, "utf8")).toBe(updatedCanary);
    expect(update).toMatchObject({ path: checkpointPath, artifact: { storage: "reference", validationState: "valid" } });

    const serializedRows = database.read((connection) => {
      const tableNames = (connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>).map((row) => row.name);
      return tableNames.flatMap((name) => connection.prepare(`SELECT * FROM \"${name.replaceAll('"', '""')}\"`).all())
        .map((row) => JSON.stringify(row));
    }).join("\n");
    expect(serializedRows).not.toContain(overviewCanary);
    expect(serializedRows).not.toContain(checkpointCanary);
    expect(serializedRows).not.toContain(updatedCanary);
    expect(database.read((connection) => connection.prepare(
      "SELECT canonical_location FROM artifacts WHERE id = ?"
    ).get(update.artifact!.artifactId))).toEqual({ canonical_location: checkpointPath });
  });

  test("rejects a checkpoint path that escapes through a directory link", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-project-root-"));
    const outside = await mkdtemp(join(tmpdir(), "remote-mcp-project-outside-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "WORK_CHECKPOINT.md"), "outside", "utf8");
    await symlink(outside, join(root, "linked"), "junction");
    const helper = createProjectCheckpointHelper({
      filesystem: createFilesystemAdapter(),
    });
    await expect(helper.read({ projectRoot: root, path: join(root, "linked", "WORK_CHECKPOINT.md") }))
      .rejects.toThrow(/outside the project root/i);
  });
});

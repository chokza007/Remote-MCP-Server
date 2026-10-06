import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { discoverProjectGuidance } from "@remote-mcp/adapters";

describe("project guidance discovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-project-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns project-owned references without copying file contents", async () => {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "README.md"), "readme-secret-content", "utf8");
    await writeFile(join(root, "PROJECT_OVERVIEW.md"), "overview", "utf8");
    await writeFile(join(root, "WORK_CHECKPOINT.md"), "checkpoint", "utf8");
    await writeFile(join(root, "AGENTS.md"), "rules", "utf8");
    await writeFile(join(root, "docs", "workflow.md"), "workflow", "utf8");
    await writeFile(join(root, ".github", "workflows", "release.yml"), "name: release", "utf8");
    await writeFile(join(root, "unrelated.txt"), "ignore", "utf8");

    const references = await discoverProjectGuidance(root);

    expect(references.map((reference) => reference.relativePath)).toEqual([
      ".github\\workflows\\release.yml",
      "AGENTS.md",
      "docs\\workflow.md",
      "PROJECT_OVERVIEW.md",
      "README.md",
      "WORK_CHECKPOINT.md"
    ]);
    for (const reference of references) {
      expect(reference).not.toHaveProperty("content");
      expect(reference.projectRoot).toBe(root);
    }
    expect(await readFile(join(root, "WORK_CHECKPOINT.md"), "utf8")).toBe("checkpoint");
  });

  test("does not follow project links or scan excluded dependency directories", async () => {
    const outside = await mkdtemp(join(tmpdir(), "remote-mcp-guidance-outside-"));
    try {
      await writeFile(join(outside, "README.md"), "outside", "utf8");
      await symlink(outside, join(root, "linked-project"), "junction");
      await mkdir(join(root, "node_modules", "package"), { recursive: true });
      await writeFile(join(root, "node_modules", "package", "README.md"), "dependency", "utf8");

      expect(await discoverProjectGuidance(root)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

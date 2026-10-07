import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createArchiveService, type ArchiveService } from "@remote-mcp/adapters";

describe("archive adapter", () => {
  let root: string;
  let archive: string;
  let service: ArchiveService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-archive-"));
    archive = join(root, "fixture.zip");
    await writeFile(archive, zipSync({ "folder/hello.txt": Buffer.from("hello"), "ไทย.txt": Buffer.from("สวัสดี") }));
    service = createArchiveService();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists, dry-runs, extracts, and verifies a ZIP without changing the original", async () => {
    const original = await readFile(archive);
    expect(await service.list(archive)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "folder/hello.txt", uncompressedSize: 5 }),
        expect.objectContaining({ path: "ไทย.txt" })
      ])
    );
    const destination = join(root, "output");
    expect(await service.extract({ archive, destination, dryRun: true })).toMatchObject({ dryRun: true, changed: false });
    await expect(readFile(join(destination, "folder", "hello.txt"))).rejects.toThrow();
    expect(await service.extract({ archive, destination })).toMatchObject({ dryRun: false, changed: true, entries: 2 });
    expect(await readFile(join(destination, "folder", "hello.txt"), "utf8")).toBe("hello");
    expect(await service.verify(archive)).toMatchObject({ valid: true, entries: 2 });
    expect(await readFile(archive)).toEqual(original);
  });

  test("creates an archive from explicit sources and refuses unexpected overwrite", async () => {
    const source = join(root, "source.txt");
    await writeFile(source, "source", "utf8");
    const created = join(root, "created.zip");
    await service.create({ archive: created, entries: [{ source, path: "nested/source.txt" }] });
    expect(await service.list(created)).toEqual([expect.objectContaining({ path: "nested/source.txt" })]);
    await expect(service.create({ archive: created, entries: [{ source, path: "source.txt" }] })).rejects.toMatchObject({
      code: "DESTINATION_EXISTS"
    });

    const destination = join(root, "collision");
    await service.extract({ archive, destination });
    await expect(service.extract({ archive, destination })).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  });
});

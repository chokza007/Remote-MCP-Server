import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createSearchService, type SearchService, type SearchStatus } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

async function waitForTerminal(service: SearchService, searchId: string): Promise<SearchStatus> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = service.status(searchId);
    if (["completed", "cancelled", "failed"].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Search did not finish: ${searchId}`);
}

describe("durable streaming search", () => {
  let root: string;
  let database: OperationalDatabase;
  let service: SearchService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-search-"));
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    service = createSearchService({ database, allowedRoots: [root] });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("finds Unicode filenames and content while skipping binary files", async () => {
    await writeFile(join(root, "สวัสดี-世界.txt"), "ก่อนหน้า เข็มทิศสีทอง หลังจากนั้น", "utf8");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 0, 255]));

    const { searchId } = await service.start({
      roots: [root],
      name: "世界",
      content: "เข็มทิศสีทอง",
      maxFiles: 100,
      maxResults: 100,
      maxBytes: 1_000_000
    });
    expect(await waitForTerminal(service, searchId)).toMatchObject({
      state: "completed",
      matchedResults: 1,
      skippedBinary: 0
    });
    expect(service.page(searchId, 0, 10).items).toEqual([
      expect.objectContaining({ path: join(root, "สวัสดี-世界.txt"), kind: "file" })
    ]);
  });

  test("rejects invalid regular expressions before creating work", async () => {
    await expect(
      service.start({
        roots: [root],
        content: "[",
        regex: true,
        maxFiles: 10,
        maxResults: 10,
        maxBytes: 1000
      })
    ).rejects.toThrow(/regular expression|regex/i);
  });

  test("applies date, size, include, and exclude filters deterministically", async () => {
    const oldFile = join(root, "old.log");
    const keep = join(root, "keep.txt");
    const excluded = join(root, "ignore.txt");
    await writeFile(oldFile, "needle old", "utf8");
    await writeFile(keep, "needle and enough bytes", "utf8");
    await writeFile(excluded, "needle and enough bytes", "utf8");
    await utimes(oldFile, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));

    const { searchId } = await service.start({
      roots: [root],
      content: "needle",
      include: ["*.txt"],
      exclude: ["ignore*"],
      minSize: 15,
      modifiedAfter: "2025-01-01T00:00:00Z",
      maxFiles: 100,
      maxResults: 100,
      maxBytes: 1_000_000
    });
    await waitForTerminal(service, searchId);
    expect(service.page(searchId, 0, 10).items.map((item) => item.path)).toEqual([keep]);
  });

  test("skips symlink loops, records inaccessible roots, and scans archive members", async () => {
    await mkdir(join(root, "nested"));
    await symlink(root, join(root, "nested", "loop"), "junction");
    await writeFile(
      join(root, "bundle.zip"),
      Buffer.from(zipSync({ "inside/บันทึก.txt": strToU8("archive needle") }))
    );

    const { searchId } = await service.start({
      roots: [root, join(root, "missing")],
      content: "archive needle",
      archives: true,
      maxFiles: 100,
      maxResults: 100,
      maxBytes: 1_000_000
    });
    expect(await waitForTerminal(service, searchId)).toMatchObject({ state: "completed", issues: 1 });
    expect(service.page(searchId, 0, 10).items).toEqual([
      expect.objectContaining({
        kind: "archive_member",
        archivePath: join(root, "bundle.zip"),
        memberPath: "inside/บันทึก.txt"
      })
    ]);
  });

  test("paginates stored results and reads them after service restart", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, `result-${index}.txt`), `needle ${index}`, "utf8");
    }
    const { searchId } = await service.start({
      roots: [root],
      content: "needle",
      maxFiles: 100,
      maxResults: 100,
      maxBytes: 1_000_000
    });
    await waitForTerminal(service, searchId);

    const first = service.page(searchId, 0, 2);
    const second = service.page(searchId, first.nextCursor!, 2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.path)).size).toBe(4);

    const restarted = createSearchService({ database, allowedRoots: [root] });
    expect(restarted.status(searchId)).toMatchObject({ state: "completed", matchedResults: 5 });
    expect(restarted.page(searchId, 0, 10).items).toHaveLength(5);
  });

  test("cancels and resumes a durable search without duplicate results", async () => {
    for (let index = 0; index < 150; index += 1) {
      await writeFile(join(root, `many-${String(index).padStart(3, "0")}.txt`), "resume needle", "utf8");
    }
    const { searchId } = await service.start({
      roots: [root],
      content: "resume needle",
      maxFiles: 500,
      maxResults: 500,
      maxBytes: 10_000_000
    });
    service.cancel(searchId);
    expect(await waitForTerminal(service, searchId)).toMatchObject({ state: "cancelled" });

    await service.resume(searchId);
    expect(await waitForTerminal(service, searchId)).toMatchObject({
      state: "completed",
      matchedResults: 150
    });
    expect(service.page(searchId, 0, 200).items).toHaveLength(150);
  });

  test("stops a runaway scan at explicit file and result limits", async () => {
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(root, `bounded-${index}.txt`), "bounded needle", "utf8");
    }
    const { searchId } = await service.start({
      roots: [root],
      content: "needle",
      maxFiles: 3,
      maxResults: 2,
      maxBytes: 1_000_000
    });
    expect(await waitForTerminal(service, searchId)).toMatchObject({
      state: "completed",
      scannedFiles: 3,
      matchedResults: 2,
      truncated: true
    });
  });
});

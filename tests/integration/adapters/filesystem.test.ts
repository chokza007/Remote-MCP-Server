import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFilesystemAdapter, type FilesystemAdapter } from "@remote-mcp/adapters";

describe("FilesystemAdapter", () => {
  let root: string;
  let recycleDirectory: string;
  let adapter: FilesystemAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-filesystem-"));
    recycleDirectory = join(root, ".recycle-fixture");
    adapter = createFilesystemAdapter({ allowedRoots: [root], recycleDirectory, maxReadBytes: 64 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("lists, stats, reads bounded ranges, hashes, and reports permissions", async () => {
    const file = join(root, "hello.txt");
    await writeFile(file, "hello world", "utf8");

    expect(await adapter.list({ path: root })).toEqual([
      expect.objectContaining({ name: "hello.txt", kind: "file", path: file })
    ]);
    expect(await adapter.stat({ path: file })).toMatchObject({ kind: "file", size: 11 });
    expect(await adapter.readRange({ path: file, offset: 6, length: 5 })).toMatchObject({
      data: "world",
      bytesRead: 5,
      eof: true
    });
    expect(await adapter.hash({ path: file, algorithm: "sha256" })).toEqual({
      algorithm: "sha256",
      digest: createHash("sha256").update("hello world").digest("hex")
    });
    expect(await adapter.permissions({ path: file })).toMatchObject({ readable: true, writable: true });
    await expect(adapter.readRange({ path: file, offset: 0, length: 65 })).rejects.toThrow(/bounded|64/i);
  });

  test("writes atomically, supports exact patches, and leaves no temporary files", async () => {
    const file = join(root, "atomic.txt");
    await adapter.write({ path: file, data: "alpha beta", overwrite: false });
    await adapter.applyPatch({
      path: file,
      edits: [{ search: "beta", replace: "gamma", expectedOccurrences: 1 }]
    });

    expect(await readFile(file, "utf8")).toBe("alpha gamma");
    expect((await readdir(root)).some((name) => name.includes(".remote-mcp-tmp-"))).toBe(false);
    await expect(adapter.write({ path: file, data: "overwrite denied" })).rejects.toThrow(/exists/i);
  });

  test("preserves the original when an atomic commit hook fails", async () => {
    const file = join(root, "recover.txt");
    await writeFile(file, "original", "utf8");
    const failing = createFilesystemAdapter({
      allowedRoots: [root],
      recycleDirectory,
      beforeAtomicCommit: () => {
        throw new Error("fixture commit failure");
      }
    });

    await expect(failing.write({ path: file, data: "replacement", overwrite: true })).rejects.toThrow(
      /fixture commit failure/i
    );
    expect(await readFile(file, "utf8")).toBe("original");
    expect((await readdir(root)).some((name) => name.includes(".remote-mcp-tmp-"))).toBe(false);
  });

  test("copies, moves, and renames without overwriting existing destinations", async () => {
    const source = join(root, "source.txt");
    const copied = join(root, "copied.txt");
    const moved = join(root, "moved.txt");
    const renamed = join(root, "renamed.txt");
    await writeFile(source, "payload", "utf8");

    await adapter.copy({ source, destination: copied });
    await adapter.move({ source: copied, destination: moved });
    await adapter.rename({ path: moved, newName: basename(renamed) });
    expect(await readFile(renamed, "utf8")).toBe("payload");
    await expect(adapter.copy({ source, destination: renamed })).rejects.toThrow(/exists/i);
  });

  test("distinguishes recoverable recycle from explicit permanent removal", async () => {
    const recycled = join(root, "recycle-me.txt");
    const removed = join(root, "remove-me.txt");
    await writeFile(recycled, "recoverable", "utf8");
    await writeFile(removed, "permanent", "utf8");

    const recycleResult = await adapter.recycle({ path: recycled });
    expect(recycleResult.recoverable).toBe(true);
    expect(await readFile(recycleResult.recycledPath!, "utf8")).toBe("recoverable");
    await adapter.remove({ path: removed, permanent: true });
    await expect(readFile(removed)).rejects.toThrow();
  });

  test("dry-run and cancellation never mutate the fixture", async () => {
    const target = join(root, "noop.txt");
    expect(await adapter.write({ path: target, data: "nope", dryRun: true })).toMatchObject({
      dryRun: true,
      changed: false
    });
    await expect(readFile(target)).rejects.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.write({ path: target, data: "nope", signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(target)).rejects.toThrow();
  });

  test("rejects ADS, filesystem roots, and case-colliding destinations", async () => {
    const existing = join(root, "Example.txt");
    await writeFile(existing, "case", "utf8");

    await expect(adapter.write({ path: `${existing}:hidden`, data: "secret" })).rejects.toThrow(/ADS|stream/i);
    await expect(adapter.remove({ path: parse(root).root, permanent: true })).rejects.toThrow(/root/i);
    await expect(
      adapter.write({ path: join(root, "example.txt"), data: "collision" })
    ).rejects.toThrow(/case|exists/i);
  });

  test("understands extended-length paths and blocks links that escape allowed roots", async () => {
    const file = join(root, "long-path.txt");
    await writeFile(file, "long", "utf8");
    const extended = `\\\\?\\${file}`;
    expect(await adapter.stat({ path: extended })).toMatchObject({ kind: "file", size: 4 });

    const outside = await mkdtemp(join(tmpdir(), "remote-mcp-outside-"));
    try {
      await writeFile(join(outside, "outside.txt"), "outside", "utf8");
      const link = join(root, "escape-link");
      await symlink(outside, link, "junction");
      expect(await adapter.links({ path: link })).toMatchObject({
        isLink: true,
        escapesAllowedRoots: true
      });
      await expect(adapter.readRange({ path: join(link, "outside.txt"), offset: 0, length: 7 })).rejects.toThrow(
        /allowed root|escape/i
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("handles recursive directory copy and refuses a missing destination parent", async () => {
    const source = join(root, "tree");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "file.txt"), "tree", "utf8");
    const copy = join(root, "tree-copy");

    await adapter.copy({ source, destination: copy, recursive: true });
    expect(await readFile(join(copy, "nested", "file.txt"), "utf8")).toBe("tree");
    await expect(
      adapter.copy({ source, destination: join(root, "missing", "tree"), recursive: true })
    ).rejects.toThrow(/parent/i);
  });
});

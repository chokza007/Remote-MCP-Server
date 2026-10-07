import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createArchiveService } from "@remote-mcp/adapters";

function markFirstEntryAsSymlink(data: Uint8Array): Uint8Array {
  const output = Buffer.from(data);
  for (let offset = 0; offset <= output.length - 46; offset += 1) {
    if (output.readUInt32LE(offset) !== 0x02014b50) continue;
    output.writeUInt16LE(3 << 8, offset + 4);
    output.writeUInt32LE(0xa1ff0000, offset + 38);
    return output;
  }
  throw new Error("Central directory not found");
}

function duplicateEqualLengthEntry(data: Uint8Array): Uint8Array {
  const output = Buffer.from(data);
  const search = Buffer.from("two.txt");
  const replacement = Buffer.from("one.txt");
  let cursor = 0;
  while ((cursor = output.indexOf(search, cursor)) >= 0) {
    replacement.copy(output, cursor);
    cursor += replacement.length;
  }
  return output;
}

describe("secure archive extraction", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-archive-security-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each([
    ["traversal", { "../escape.txt": Buffer.from("escape") }, "PATH_TRAVERSAL"],
    ["absolute", { "C:/escape.txt": Buffer.from("escape") }, "ABSOLUTE_PATH"],
    ["case collision", { "Folder/A.txt": Buffer.from("a"), "folder/a.txt": Buffer.from("b") }, "CASE_COLLISION"]
  ])("rejects %s entries before writing anything", async (_name, entries, code) => {
    const archive = join(root, `${_name}.zip`);
    await writeFile(archive, zipSync(entries));
    const destination = join(root, "output");
    await expect(createArchiveService().extract({ archive, destination })).rejects.toMatchObject({ code });
    await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
  });

  test("rejects unsafe links and compression bombs before extraction", async () => {
    const linkArchive = join(root, "link.zip");
    await writeFile(linkArchive, markFirstEntryAsSymlink(zipSync({ link: Buffer.from("../target") })));
    await expect(createArchiveService().extract({ archive: linkArchive, destination: join(root, "links") })).rejects.toMatchObject({
      code: "UNSAFE_LINK"
    });

    const bombArchive = join(root, "bomb.zip");
    await writeFile(bombArchive, zipSync({ "zeros.bin": new Uint8Array(100_000) }, { level: 9 }));
    await expect(
      createArchiveService({ maxCompressionRatio: 2 }).extract({ archive: bombArchive, destination: join(root, "bomb") })
    ).rejects.toMatchObject({ code: "COMPRESSION_RATIO" });
  });

  test("rejects a file that is also the parent of another entry", async () => {
    const archive = join(root, "prefix-collision.zip");
    await writeFile(archive, zipSync({ parent: Buffer.from("file"), "parent/child.txt": Buffer.from("child") }));
    await expect(createArchiveService().extract({ archive, destination: join(root, "prefix") })).rejects.toMatchObject({
      code: "CASE_COLLISION"
    });
  });

  test("rejects duplicate entries and explicit entry or expanded-size limit violations", async () => {
    const duplicate = join(root, "duplicate.zip");
    await writeFile(duplicate, duplicateEqualLengthEntry(zipSync({ "one.txt": Buffer.from("one"), "two.txt": Buffer.from("two") })));
    await expect(createArchiveService().list(duplicate)).rejects.toMatchObject({ code: "DUPLICATE_ENTRY" });

    const limits = join(root, "limits.zip");
    await writeFile(limits, zipSync({ "one.txt": Buffer.from("1234"), "two.txt": Buffer.from("5678") }, { level: 0 }));
    await expect(createArchiveService({ maxEntries: 1 }).list(limits)).rejects.toMatchObject({ code: "ENTRY_LIMIT" });
    await expect(createArchiveService({ maxExpandedBytes: 7 }).list(limits)).rejects.toMatchObject({ code: "EXPANDED_SIZE_LIMIT" });
  });
});

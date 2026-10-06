import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

interface CanonicalTarget {
  readonly kind: string;
  readonly canonical: string;
  readonly display: string;
  readonly identityKey: string;
}

interface TargetInput {
  readonly kind: "path" | "url" | "process" | "service" | "port" | "opaque";
  readonly value: string;
  readonly followSymlinks?: boolean;
}

interface ContractsModule {
  canonicalizeTarget?: (input: TargetInput | string) => Promise<CanonicalTarget>;
}

describe("canonical Windows targets", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "remote-mcp-targets-"));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test("normalizes drive-letter case and dot segments", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    expect(typeof contracts.canonicalizeTarget).toBe("function");

    const target = await contracts.canonicalizeTarget!({
      kind: "path",
      value: "c:\\Temp\\folder\\..\\File.txt"
    });

    expect(target).toEqual({
      kind: "path",
      canonical: "C:\\Temp\\File.txt",
      display: "C:\\Temp\\File.txt",
      identityKey: "path:c:\\temp\\file.txt"
    });
  });

  test("preserves a UNC share while resolving parent segments", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const target = await contracts.canonicalizeTarget?.({
      kind: "path",
      value: "\\\\Server\\Share\\folder\\..\\Report.docx"
    });

    expect(target).toEqual({
      kind: "path",
      canonical: "\\\\Server\\Share\\Report.docx",
      display: "\\\\Server\\Share\\Report.docx",
      identityKey: "path:\\\\server\\share\\report.docx"
    });
  });

  test("treats extended-length and ordinary drive paths as one identity", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const ordinary = await contracts.canonicalizeTarget?.("C:\\Very Long\\file.bin");
    const extended = await contracts.canonicalizeTarget?.({
      kind: "path",
      value: "\\\\?\\C:\\Very Long\\file.bin"
    });

    expect(extended?.canonical).toBe("C:\\Very Long\\file.bin");
    expect(extended?.identityKey).toBe(ordinary?.identityKey);
  });

  test("keeps drive roots canonical and distinct", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const target = await contracts.canonicalizeTarget?.({ kind: "path", value: "d:\\" });

    expect(target).toEqual({
      kind: "path",
      canonical: "D:\\",
      display: "D:\\",
      identityKey: "path:d:\\"
    });
  });

  test("preserves alternate data stream names as distinct identities", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const file = await contracts.canonicalizeTarget?.("C:\\Data\\report.txt");
    const stream = await contracts.canonicalizeTarget?.("C:\\Data\\report.txt:review");

    expect(stream?.canonical).toBe("C:\\Data\\report.txt:review");
    expect(stream?.identityKey).toBe("path:c:\\data\\report.txt:review");
    expect(stream?.identityKey).not.toBe(file?.identityKey);
  });

  test("can bind a junction and its destination to the same physical identity", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;
    const realDirectory = join(fixtureRoot, "real");
    const junctionDirectory = join(fixtureRoot, "junction");
    await mkdir(realDirectory);
    await symlink(realDirectory, junctionDirectory, "junction");

    const physicalPath = await realpath(realDirectory);
    const realTarget = await contracts.canonicalizeTarget?.({
      kind: "path",
      value: physicalPath,
      followSymlinks: true
    });
    const junctionTarget = await contracts.canonicalizeTarget?.({
      kind: "path",
      value: junctionDirectory,
      followSymlinks: true
    });

    expect(junctionTarget?.identityKey).toBe(realTarget?.identityKey);
    expect(junctionTarget?.canonical).toBe(win32.normalize(physicalPath));
  });
});

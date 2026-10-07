import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";

import {
  createDocumentService,
  createFilesystemAdapter,
  createSearchService,
  createTerminalService
} from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const execFileAsync = promisify(execFile);

async function waitForSearch(search: ReturnType<typeof createSearchService>, searchId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = search.status(searchId).state;
    if (state === "completed") return;
    if (state === "failed") throw new Error(search.status(searchId).error ?? "search failed");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("search did not complete");
}

describe("Master Spec A-L acceptance", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("A, B, C, and G: whole-machine filesystem, mutations, interactive shells, and progressive search", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-master-abg-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = openDatabase({ filename: ":memory:" });
    cleanups.push(() => database.close());
    migrateDatabase(database);

    const filesystem = createFilesystemAdapter({ allowedRoots: [root], recycleDirectory: join(root, ".recycle") });
    const source = join(root, "source.txt");
    const copy = join(root, "copy.txt");
    await filesystem.write({ path: source, data: "needle one", overwrite: false });
    await filesystem.applyPatch({ path: source, edits: [{ search: "one", replace: "two", expectedOccurrences: 1 }] });
    await filesystem.copy({ source, destination: copy });
    expect(await filesystem.hash({ path: source, algorithm: "sha256" })).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(await readFile(copy, "utf8")).toBe("needle two");

    const search = createSearchService({ database, allowedRoots: [root] });
    const { searchId } = await search.start({ roots: [root], content: "needle", maxFiles: 100, maxResults: 20, maxBytes: 1_000_000 });
    await waitForSearch(search, searchId);
    expect(search.page(searchId).items.map((item) => item.path)).toEqual(expect.arrayContaining([source, copy]));

    const terminal = createTerminalService({ database, allowedShells: ["powershell", "python"] });
    const created = await terminal.create({ shell: "powershell", cwd: root });
    cleanups.push(() => terminal.close(created.terminalId));
    terminal.send(created.terminalId, "Write-Output 'MASTER_C_OK'\r");
    const deadline = Date.now() + 5_000;
    let output = "";
    while (!output.includes("MASTER_C_OK") && Date.now() < deadline) {
      output = terminal.read(created.terminalId, 0, 64 * 1024).data;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(output).toContain("MASTER_C_OK");
  }, 20_000);

  test("F: reads and safely updates DOCX and XLSX while preserving the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-master-f-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const docx = join(root, "source.docx");
    const updatedDocx = join(root, "updated.docx");
    const xlsx = join(root, "source.xlsx");
    const updatedXlsx = join(root, "updated.xlsx");
    await writeFile(docx, zipSync({
      "[Content_Types].xml": Buffer.from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>", "utf8"),
      "word/document.xml": Buffer.from("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>OLD</w:t></w:r><w:r><w:t> TEXT</w:t></w:r></w:p></w:body></w:document>", "utf8")
    }));
    await execFileAsync("python", ["-c", "from openpyxl import Workbook; import sys; w=Workbook(); w.active['A1']='old'; w.save(sys.argv[1])", xlsx]);
    const documents = createDocumentService({ helperRoot: resolve("helpers/python"), pythonExecutable: "python" });
    cleanups.push(() => documents.close());

    await documents.updateDocx({ input: docx, output: updatedDocx, replacements: [{ search: "OLD TEXT", replace: "NEW & TEXT" }] });
    await documents.updateXlsx({ input: xlsx, output: updatedXlsx, updates: [{ sheet: "Sheet", cell: "A1", value: "new" }] });
    expect(await documents.extract(updatedDocx)).toMatchObject({ text: "NEW & TEXT" });
    expect(JSON.stringify(await documents.extract(updatedXlsx))).toContain("new");
    expect(await documents.extract(docx)).toMatchObject({ text: "OLD TEXT" });
  }, 30_000);
});

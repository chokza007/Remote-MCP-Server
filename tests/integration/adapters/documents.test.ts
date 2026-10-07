import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDocumentService, type DocumentService } from "@remote-mcp/adapters";

const execFileAsync = promisify(execFile);
const helperRoot = resolve("helpers/python");

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("rich-document adapter and Python JSONL helper", () => {
  let root: string;
  let service: DocumentService;
  let workbook: string;
  let pdf: string;
  let image: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-documents-"));
    workbook = join(root, "ตาราง formula merged.xlsx");
    pdf = join(root, "scanned and text.pdf");
    image = join(root, "source image.png");
    const fixtureScript = [
      "from openpyxl import Workbook",
      "from PIL import Image, ImageDraw, ImageFont",
      "import fitz, sys",
      "xlsx,pdf,image=sys.argv[1:4]",
      "wb=Workbook(); ws=wb.active; ws.title='Data'; ws['A1']='Merged'; ws.merge_cells('A1:B1'); ws['A2']=2; ws['B2']=3; ws['C2']='=SUM(A2:B2)'; wb.save(xlsx)",
      "im=Image.new('RGB',(1000,300),'white'); d=ImageDraw.Draw(im); f=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',72); d.text((80,90),'SCAN 123',font=f,fill='black'); im.save(image)",
      "doc=fitz.open(); p=doc.new_page(width=1000,height=300); p.insert_text((72,100),'TEXT PAGE',fontsize=40); p=doc.new_page(width=1000,height=300); p.insert_image(p.rect,filename=image); doc.save(pdf)"
    ].join("; ");
    await execFileAsync("python", ["-c", fixtureScript, workbook, pdf, image]);
    service = createDocumentService({ helperRoot, pythonExecutable: "python" });
  }, 30_000);

  afterEach(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  test("frames concurrent helper requests by ID and preserves formulas and merged ranges", async () => {
    const text = join(root, "notes.md");
    await writeFile(text, "# Heading\n\nHello document", "utf8");
    const [textInfo, sheetInfo] = await Promise.all([service.inspect(text), service.inspect(workbook)]);
    expect(textInfo).toMatchObject({ kind: "markdown", valid: true });
    expect(sheetInfo).toMatchObject({ kind: "xlsx", sheets: 1, valid: true });

    const extracted = await service.extract(workbook);
    expect(extracted).toMatchObject({
      kind: "xlsx",
      sheets: [expect.objectContaining({ name: "Data", mergedRanges: ["A1:B1"], formulaCells: 1 })]
    });
    expect(JSON.stringify(extracted)).toContain("=SUM(A2:B2)");
  });

  test("extracts Unicode plain text and DOCX OpenXML without requiring an office installation", async () => {
    const text = join(root, "บันทึก.txt");
    const docx = join(root, "เอกสาร.docx");
    await writeFile(text, "สวัสดี plain text", "utf8");
    await writeFile(docx, zipSync({
      "[Content_Types].xml": Buffer.from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>", "utf8"),
      "word/document.xml": Buffer.from(
        "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>DOCX TEXT</w:t></w:r></w:p></w:body></w:document>",
        "utf8"
      )
    }));
    await expect(service.extract(text)).resolves.toMatchObject({ kind: "text", text: "สวัสดี plain text" });
    await expect(service.extract(docx)).resolves.toMatchObject({ kind: "docx", text: "DOCX TEXT" });
  });

  test("extracts and renders PDF pages, OCRs a scanned page, and leaves the source unchanged", async () => {
    const original = await sha256(pdf);
    const extracted = await service.extract(pdf);
    expect(JSON.stringify(extracted)).toContain("TEXT PAGE");

    const rendered = await service.render({ input: pdf, outputDirectory: join(root, "rendered") });
    expect(rendered.outputs).toHaveLength(2);
    const ocr = await service.ocr(pdf);
    expect(String(ocr.text).replace(/\s+/gu, " ")).toMatch(/SCAN\s*123/i);
    expect(await sha256(pdf)).toBe(original);
  }, 60_000);

  test("converts images to validated PNG and validates structured formats", async () => {
    const original = await sha256(image);
    const converted = join(root, "converted.png");
    const conversion = await service.convert({ input: image, output: converted, format: "png" });
    expect(conversion).toMatchObject({ valid: true, output: converted });
    expect(await service.validate(converted)).toMatchObject({ valid: true, kind: "image" });

    const json = join(root, "data.json");
    const csv = join(root, "data.csv");
    const xml = join(root, "data.xml");
    await writeFile(json, JSON.stringify({ ok: true }), "utf8");
    await writeFile(csv, "name,value\nalpha,1\n", "utf8");
    await writeFile(xml, "<root><value>1</value></root>", "utf8");
    await expect(Promise.all([service.validate(json), service.validate(csv), service.validate(xml)]))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ valid: true })]));
    expect(await sha256(image)).toBe(original);
  });

  test("reports structured capability or validation failures for corrupt and unsupported inputs", async () => {
    const corrupt = join(root, "corrupt.pdf");
    await writeFile(corrupt, "not a pdf", "utf8");
    await expect(service.validate(corrupt)).rejects.toMatchObject({ errorCode: expect.stringMatching(/DOCUMENT_INVALID|CAPABILITY_UNAVAILABLE/) });

    const unsupported = join(root, "unknown.bin");
    await writeFile(unsupported, "unknown", "utf8");
    await expect(service.inspect(unsupported)).rejects.toMatchObject({ errorCode: "CAPABILITY_UNAVAILABLE" });
  });
});

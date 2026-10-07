import { z } from "zod";

import type { DocumentService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const path = z.string().min(1);
const outputOptions = { output: path, overwrite: z.boolean().optional() };

export function registerDocumentTools(registry: ToolRegistry, documents: DocumentService): void {
  for (const operation of ["inspect", "extract", "validate"] as const) {
    registry.register(
      coreDescriptor(`document_${operation}`, `${operation} document`, `${operation}s a supported image or rich document through the isolated helper.`, 0),
      async (args) => ({ schemaVersion: 1, ...(await documents[operation](String(args.path))) }),
      { inputSchema: { path } }
    );
  }

  registry.register(
    { ...coreDescriptor("document_ocr", "OCR document", "Recognizes text in an image or rendered PDF pages.", 1), defaultTimeoutMs: 120_000, cancellable: true },
    async (args) => ({ schemaVersion: 1, ...(await documents.ocr(String(args.path))) }),
    { inputSchema: { path } }
  );

  registry.register(
    { ...coreDescriptor("document_render", "Render document", "Renders every PDF page to a verified PNG image.", 2), defaultTimeoutMs: 120_000, cancellable: true },
    async (args) => ({ schemaVersion: 1, ...(await documents.render({
      input: String(args.input), outputDirectory: String(args.outputDirectory)
    })) }),
    { inputSchema: { input: path, outputDirectory: path } }
  );

  registry.register(
    { ...coreDescriptor("document_convert", "Convert document", "Converts a supported document to an explicit output format and validates the output.", 2), defaultTimeoutMs: 120_000, cancellable: true },
    async (args) => ({ schemaVersion: 1, ...(await documents.convert({
      input: String(args.input), output: String(args.output), format: String(args.format),
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    {
      inputSchema: {
        input: path, output: path,
        format: z.enum(["png", "jpeg", "jpg", "webp", "tiff"]),
        overwrite: z.boolean().optional()
      }
    }
  );

  registry.register(
    { ...coreDescriptor("document_docx_replace", "Replace DOCX text", "Writes a new DOCX with exact text replacements while preserving the source document.", 2), defaultTimeoutMs: 120_000, cancellable: true },
    async (args) => ({ schemaVersion: 1, ...(await documents.updateDocx({
      input: String(args.input), output: String(args.output),
      replacements: args.replacements as Array<{ search: string; replace: string }>,
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    {
      inputSchema: {
        input: path, ...outputOptions,
        replacements: z.array(z.object({ search: z.string().min(1), replace: z.string() })).min(1)
      }
    }
  );

  registry.register(
    { ...coreDescriptor("document_xlsx_update", "Update XLSX cells", "Writes a new XLSX with explicit A1 cell updates while preserving the source workbook.", 2), defaultTimeoutMs: 120_000, cancellable: true },
    async (args) => ({ schemaVersion: 1, ...(await documents.updateXlsx({
      input: String(args.input), output: String(args.output),
      updates: args.updates as Array<{ sheet: string; cell: string; value: string | number | boolean | null }>,
      ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) })
    })) }),
    {
      inputSchema: {
        input: path, ...outputOptions,
        updates: z.array(z.object({
          sheet: z.string().min(1), cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]*$/iu),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()])
        })).min(1)
      }
    }
  );
}

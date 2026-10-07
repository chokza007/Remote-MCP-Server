import { z } from "zod";

import type { DocumentService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const path = z.string().min(1);

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
}

import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";

import {
  createDocumentHelperClient,
  type DocumentHelperClient,
  type DocumentHelperClientOptions,
  type HelperRequestOptions
} from "./helper-client.js";

export type DocumentResult = Readonly<Record<string, unknown>>;

export interface DocumentRenderInput {
  readonly input: string;
  readonly outputDirectory: string;
  readonly options?: HelperRequestOptions;
}

export interface DocumentConvertInput {
  readonly input: string;
  readonly output: string;
  readonly format: string;
  readonly overwrite?: boolean;
  readonly options?: HelperRequestOptions;
}

export interface DocumentServiceOptions extends DocumentHelperClientOptions {
  readonly client?: DocumentHelperClient;
}

async function requireDocument(path: string): Promise<string> {
  const normalized = resolve(path);
  const info = await stat(normalized).catch(() => undefined);
  if (!info?.isFile()) {
    throw new RemoteMcpError({
      errorCode: "DOCUMENT_INVALID", message: "The document does not exist or is not a regular file.", retryable: false,
      suggestedAction: "Choose an existing regular document file.", target: normalized
    });
  }
  return normalized;
}

export class DocumentService {
  private client: DocumentHelperClient | undefined;
  private readonly options: DocumentServiceOptions;

  public constructor(options: DocumentServiceOptions) {
    this.options = options;
    this.client = options.client;
  }

  public async inspect(path: string, options: HelperRequestOptions = {}): Promise<DocumentResult> {
    return this.helper().request("inspect", { path: await requireDocument(path) }, options);
  }

  public async extract(path: string, options: HelperRequestOptions = {}): Promise<DocumentResult> {
    return this.helper().request("extract", { path: await requireDocument(path) }, options);
  }

  public async validate(path: string, options: HelperRequestOptions = {}): Promise<DocumentResult> {
    return this.helper().request("validate", { path: await requireDocument(path) }, options);
  }

  public async ocr(path: string, options: HelperRequestOptions = {}): Promise<DocumentResult> {
    return this.helper().request("ocr", { path: await requireDocument(path) }, options);
  }

  public async render(input: DocumentRenderInput): Promise<DocumentResult & { readonly outputs: readonly string[] }> {
    const source = await requireDocument(input.input);
    const outputDirectory = resolve(input.outputDirectory);
    await mkdir(outputDirectory, { recursive: true });
    return this.helper().request("render", { input: source, outputDirectory }, input.options);
  }

  public async convert(input: DocumentConvertInput): Promise<DocumentResult & { readonly output: string; readonly valid: true }> {
    const source = await requireDocument(input.input);
    const output = resolve(input.output);
    if (!input.overwrite && await stat(output).catch(() => undefined)) {
      throw new RemoteMcpError({
        errorCode: "DOCUMENT_OUTPUT_EXISTS", message: "The document destination already exists.", retryable: false,
        suggestedAction: "Choose a new destination or explicitly allow overwrite.", target: output
      });
    }
    await mkdir(dirname(output), { recursive: true });
    const result = await this.helper().request<DocumentResult & { readonly valid: true }>(
      "convert",
      { input: source, output, format: input.format },
      input.options
    );
    return { ...result, output };
  }

  public close(): Promise<void> {
    return this.client?.close() ?? Promise.resolve();
  }

  private helper(): DocumentHelperClient {
    this.client ??= createDocumentHelperClient(this.options);
    return this.client;
  }
}

export function createDocumentService(options: DocumentServiceOptions): DocumentService {
  return new DocumentService(options);
}

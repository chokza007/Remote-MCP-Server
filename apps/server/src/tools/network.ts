import { z } from "zod";

import type { DownloadService, HttpService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface NetworkToolDependencies {
  readonly http: HttpService;
  readonly downloads: DownloadService;
}

function namespace(context: { readonly identity: { readonly principalId: string; readonly clientId: string } }): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

function safeHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const headers = value as Record<string, string>;
  const forbidden = Object.keys(headers).find((name) => ["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase()));
  if (forbidden) throw new Error(`Sensitive HTTP header ${forbidden} must be supplied by credential reference`);
  return headers;
}

export function registerNetworkTools(registry: ToolRegistry, dependencies: NetworkToolDependencies): void {
  registry.register(
    coreDescriptor("http_request", "HTTP request", "Performs a bounded GET or HEAD request with redirect and SSRF checks.", 1),
    async (args) => {
      const headers = safeHeaders(args.headers);
      const result = await dependencies.http.request({
        url: String(args.url),
        method: (args.method as "GET" | "HEAD" | undefined) ?? "GET",
        ...(headers === undefined ? {} : { headers }),
        ...(args.credentialReference === undefined ? {} : { credentialReference: String(args.credentialReference) }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
        ...(args.maxResponseBytes === undefined ? {} : { maxResponseBytes: Number(args.maxResponseBytes) }),
        ...(args.maxRedirects === undefined ? {} : { maxRedirects: Number(args.maxRedirects) })
      });
      const encoding = (args.encoding as "utf8" | "base64" | undefined) ?? "utf8";
      return {
        schemaVersion: 1,
        status: result.status,
        headers: result.headers,
        finalUrl: result.finalUrl,
        redirects: result.redirects,
        bodyBytes: result.body.length,
        body: Buffer.from(result.body).toString(encoding)
      };
    },
    {
      inputSchema: {
        url: z.url(),
        method: z.enum(["GET", "HEAD"]).optional(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        timeoutMs: z.number().int().positive().max(3_600_000).optional(),
        maxResponseBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
        maxRedirects: z.number().int().nonnegative().max(20).optional(),
        headers: z.record(z.string().min(1), z.string().max(16 * 1024)).optional(),
        credentialReference: z.string().min(1).max(256).optional()
      },
      openWorld: true,
      auditResult: (output) => ({
        ...output,
        body: `[OMITTED ${String(output.bodyBytes ?? "unknown")} bytes]`
      })
    }
  );

  registry.register(
    coreDescriptor("download_start", "Start download", "Starts a bounded atomic download with optional SHA-256 verification.", 2),
    async (args, context) => ({
      schemaVersion: 1,
      ...(await dependencies.downloads.start({
        url: String(args.url),
        destination: String(args.destination),
        ...(args.expectedSha256 === undefined ? {} : { expectedSha256: String(args.expectedSha256) }),
        ...(args.overwrite === undefined ? {} : { overwrite: Boolean(args.overwrite) }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
        ...(args.maxBytes === undefined ? {} : { maxBytes: Number(args.maxBytes) }),
        ...(args.credentialReference === undefined ? {} : { credentialReference: String(args.credentialReference) }),
        namespace: namespace(context)
      }))
    }),
    {
      inputSchema: {
        url: z.url(),
        destination: z.string().min(1),
        expectedSha256: z.string().regex(/^[0-9a-f]{64}$/iu).optional(),
        overwrite: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(86_400_000).optional(),
        maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        credentialReference: z.string().min(1).max(256).optional()
      },
      openWorld: true
    }
  );

  for (const operation of ["status", "cancel", "resume", "verify"] as const) {
    const tier = operation === "resume" ? 2 : operation === "cancel" ? 1 : 0;
    registry.register(
      coreDescriptor(`download_${operation}`, `Download ${operation}`, `${operation}s or inspects a download job.`, tier),
      async (args, context) => ({ schemaVersion: 1, ...(await dependencies.downloads[operation](String(args.jobId), namespace(context))) }),
      { inputSchema: { jobId: z.string().uuid() }, openWorld: operation === "resume" }
    );
  }
}

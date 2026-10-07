import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createDownloadService,
  createHttpService,
  createUrlPolicy,
  type DownloadService,
  type HttpService
} from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const payload = Buffer.from("bounded resumable payload\n", "utf8");

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(downloads: DownloadService, jobId: string): Promise<Awaited<ReturnType<DownloadService["status"]>>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await downloads.status(jobId);
    if (["completed", "failed", "cancelled"].includes(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Download fixture timed out");
}

describe("HTTP and download adapters", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let http: HttpService;
  let crossOriginTarget: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-network-"));
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      if (url.pathname === "/redirect") {
        response.writeHead(302, { location: "/payload" }).end();
        return;
      }
      if (url.pathname === "/loop") {
        response.writeHead(302, { location: "/loop" }).end();
        return;
      }
      if (url.pathname === "/mismatch") {
        response.writeHead(200, { "content-length": payload.length + 10 });
        response.end(payload);
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => response.writeHead(200, { "content-length": payload.length }).end(payload), 250);
        return;
      }
      if (url.pathname === "/authorized") {
        const authorized = request.headers.authorization === "Bearer fixture-secret";
        response.writeHead(authorized ? 200 : 401, { "content-length": authorized ? 10 : 12 });
        response.end(authorized ? "authorized" : "unauthorized");
        return;
      }
      if (url.pathname === "/redirect-cross" && crossOriginTarget) {
        response.writeHead(302, { location: crossOriginTarget }).end();
        return;
      }
      if (url.pathname === "/wrong-range") {
        response.writeHead(206, {
          "content-length": payload.length - 1,
          "content-range": `bytes 1-${payload.length - 1}/${payload.length}`
        });
        response.end(payload.subarray(1));
        return;
      }
      const range = request.headers.range;
      if (range) {
        const start = Number(/^bytes=(\d+)-$/u.exec(range)?.[1] ?? 0);
        response.writeHead(206, {
          "content-length": payload.length - start,
          "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`
        });
        response.end(payload.subarray(start));
        return;
      }
      response.writeHead(200, { "content-length": payload.length, "content-type": "application/octet-stream" });
      response.end(payload);
    });
    const port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
    http = createHttpService({ urlPolicy: createUrlPolicy({ allowPrivateNetwork: true }) });
  });

  afterEach(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
  });

  test("follows validated redirects and enforces response size and content length", async () => {
    const response = await http.request({ url: `${baseUrl}/redirect`, maxResponseBytes: 1024 });
    expect(response).toMatchObject({ status: 200, redirects: 1, finalUrl: `${baseUrl}/payload` });
    expect(Buffer.from(response.body)).toEqual(payload);
    const head = await http.request({ url: `${baseUrl}/payload`, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);

    await expect(http.request({ url: `${baseUrl}/payload`, maxResponseBytes: 4 })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE"
    });
    await expect(http.request({ url: `${baseUrl}/mismatch` })).rejects.toMatchObject({
      code: "CONTENT_LENGTH_MISMATCH"
    });
    await expect(http.request({ url: `${baseUrl}/loop`, maxRedirects: 2 })).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS"
    });
  });

  test("supports timeout, cancellation, redacted credential rejection, and TLS failure", async () => {
    await expect(http.request({ url: `${baseUrl}/slow`, timeoutMs: 20 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController();
    const pending = http.request({ url: `${baseUrl}/slow`, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await expect(http.request({ url: baseUrl.replace("http://", "http://user:NETWORK_TOKEN_CANARY@") })).rejects.toSatisfy(
      (error: unknown) => !JSON.stringify(error).includes("NETWORK_TOKEN_CANARY")
    );
    await expect(http.request({ url: baseUrl.replace("http://", "https://"), timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "TLS_ERROR"
    });
  });

  test("resolves authentication by opaque reference without putting secrets in request arguments", async () => {
    const authenticated = createHttpService({
      urlPolicy: createUrlPolicy({ allowPrivateNetwork: true }),
      credentialProvider: {
        resolve: async (reference) => reference === "fixture-auth"
          ? { authorization: "Bearer fixture-secret" }
          : {}
      }
    });
    await expect(authenticated.request({ url: `${baseUrl}/authorized`, credentialReference: "fixture-auth" })).resolves.toMatchObject({
      status: 200,
      body: Buffer.from("authorized")
    });

    const observer = createServer((request, response) => {
      const leaked = request.headers.authorization !== undefined;
      const body = Buffer.from(leaked ? "leaked" : "clean");
      response.writeHead(200, { "content-length": body.length }).end(body);
    });
    try {
      crossOriginTarget = `http://127.0.0.1:${await listen(observer)}/observe`;
      const redirected = await authenticated.request({ url: `${baseUrl}/redirect-cross`, credentialReference: "fixture-auth" });
      expect(Buffer.from(redirected.body).toString("utf8")).toBe("clean");
    } finally {
      await close(observer);
    }
  });

  test("downloads atomically, resumes a partial file with ranges, verifies hashes, and cancels", async () => {
    const downloads = createDownloadService({ http });
    const destination = join(root, "payload.bin");
    await writeFile(`${destination}.remote-mcp.part`, payload.subarray(0, 8));
    const started = await downloads.start({
      url: `${baseUrl}/payload`,
      destination,
      expectedSha256: createHash("sha256").update(payload).digest("hex")
    });
    expect(await waitFor(downloads, started.jobId)).toMatchObject({ state: "completed", bytesDownloaded: payload.length });
    expect(await readFile(destination)).toEqual(payload);
    await expect(downloads.verify(started.jobId)).resolves.toMatchObject({ valid: true });

    const bad = await downloads.start({
      url: `${baseUrl}/payload`,
      destination: join(root, "bad.bin"),
      expectedSha256: "0".repeat(64)
    });
    expect(await waitFor(downloads, bad.jobId)).toMatchObject({ state: "failed" });

    const invalidRangeDestination = join(root, "invalid-range.bin");
    await writeFile(`${invalidRangeDestination}.remote-mcp.part`, payload.subarray(0, 8));
    const invalidRange = await downloads.start({ url: `${baseUrl}/wrong-range`, destination: invalidRangeDestination });
    expect(await waitFor(downloads, invalidRange.jobId)).toMatchObject({ state: "failed", error: expect.stringMatching(/range/i) });

    const cancelled = await downloads.start({ url: `${baseUrl}/slow`, destination: join(root, "cancelled.bin") });
    await downloads.cancel(cancelled.jobId);
    expect(await waitFor(downloads, cancelled.jobId)).toMatchObject({ state: "cancelled" });
    await downloads.resume(cancelled.jobId);
    expect(await waitFor(downloads, cancelled.jobId)).toMatchObject({ state: "completed", bytesDownloaded: payload.length });
  });

  test("persists download job state across service reconstruction", async () => {
    const database = openDatabase({ filename: join(root, "downloads.sqlite") });
    migrateDatabase(database);
    try {
      const first = createDownloadService({ http, database });
      const started = await first.start({ url: `${baseUrl}/payload`, destination: join(root, "durable.bin") });
      expect(await waitFor(first, started.jobId)).toMatchObject({ state: "completed" });

      const reconstructed = createDownloadService({ http, database });
      expect(await reconstructed.status(started.jobId)).toMatchObject({ state: "completed", bytesDownloaded: payload.length });
      await expect(reconstructed.verify(started.jobId)).resolves.toMatchObject({ valid: true });

      const destination = join(root, "durable.bin");
      await rm(destination);
      await writeFile(`${destination}.remote-mcp.part`, payload.subarray(0, 8));
      database.writeTransaction((connection) => {
        connection.prepare(
          "UPDATE download_jobs SET state = 'running', bytes_downloaded = 8, total_bytes = NULL, sha256 = NULL, error = NULL WHERE id = ?"
        ).run(started.jobId);
      });
      const recovered = createDownloadService({ http, database, authorizeResume: () => true });
      expect(await waitFor(recovered, started.jobId)).toMatchObject({ state: "completed", bytesDownloaded: payload.length });
      expect(await readFile(destination)).toEqual(payload);
    } finally {
      database.close();
    }
  });
});

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";
import { createHttpServer, type HttpServerHandle } from "../../../apps/server/src/http-server.js";

const publicOrigin = "https://remote.example.test";
const ownerToken = "OWNER_CONSOLE_ACCESS_TOKEN_123456789";
const signingKeys = [{ keyId: "integration-key", secret: Buffer.alloc(32, 0x73) }];
const proxyHeaders = {
  "x-forwarded-proto": "https",
  "x-forwarded-host": "remote.example.test"
};
const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x5a),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x5a)
};

async function authorize(handle: HttpServerHandle): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const authorization = new URL("/oauth/authorize", handle.url);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: "chatgpt-web",
    client_name: "ChatGPT Web",
    subject: "chatgpt-account-1",
    redirect_uri: "http://127.0.0.1/callback",
    state: "state-value-with-high-entropy",
    nonce: "nonce-value-with-high-entropy",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "computer:*"
  }).toString();
  const consent = await fetch(authorization, { headers: proxyHeaders });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("color-scheme:dark");
  expect(html).not.toMatch(/background\s*:\s*(?:white|#fff(?:fff)?)/iu);
  const requestId = /name="request_id" value="([^"]+)"/u.exec(html)?.[1];
  expect(requestId).toBeTruthy();

  const decision = await fetch(new URL("/oauth/authorize/decision", handle.url), {
    method: "POST",
    redirect: "manual",
    headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, owner_token: ownerToken, decision: "approve" })
  });
  expect(decision.status).toBe(303);
  const redirect = new URL(decision.headers.get("location")!);
  expect(redirect.searchParams.get("state")).toBe("state-value-with-high-entropy");
  const code = redirect.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await fetch(new URL("/oauth/token", handle.url), {
    method: "POST",
    headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1/callback",
      client_id: "chatgpt-web"
    })
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function connect(handle: HttpServerHandle, accessToken: string): Promise<Client> {
  const client = new Client({ name: "oauth-integration", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(handle.url, {
    requestInit: { headers: { ...proxyHeaders, authorization: `Bearer ${accessToken}` } }
  }));
  return client;
}

describe("OAuth HTTPS MCP integration", () => {
  let root: string;
  let database: OperationalDatabase;
  let handle: HttpServerHandle;
  const clients: Client[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-oauth-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    handle = await createHttpServer({
      database,
      protector,
      host: "127.0.0.1",
      port: 0,
      remoteAuth: { publicOrigin, ownerToken, signingKeys }
    });
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await handle.close().catch(() => undefined);
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("publishes metadata and rejects insecure or spoofed proxy requests", async () => {
    const landing = await fetch(new URL("/", handle.url));
    const landingHtml = await landing.text();
    expect(landing.status).toBe(200);
    expect(landingHtml).toContain("color-scheme:dark");
    expect(landingHtml).not.toMatch(/#fff(?:fff)?|background\s*:\s*white/iu);
    const unauthorizedOwner = await fetch(new URL("/owner", handle.url), { headers: proxyHeaders });
    const unauthorizedHtml = await unauthorizedOwner.text();
    expect(unauthorizedOwner.status).toBe(401);
    expect(unauthorizedHtml).toContain("color-scheme:dark");
    expect(unauthorizedHtml).not.toMatch(/#fff(?:fff)?|background\s*:\s*white/iu);
    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource", handle.url), { headers: proxyHeaders });
    expect(await metadata.json()).toMatchObject({
      resource: `${publicOrigin}/mcp`,
      authorization_servers: [publicOrigin]
    });
    expect((await fetch(new URL("/.well-known/oauth-protected-resource", handle.url))).status).toBe(400);
    expect((await fetch(new URL("/.well-known/oauth-protected-resource", handle.url), {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "attacker.example" }
    })).status).toBe(400);
    await expect(createHttpServer({ database, protector, host: "0.0.0.0", port: 0 }))
      .rejects.toThrow(/non-loopback|OAuth/i);
    expect((await fetch(new URL("/oauth/token", handle.url), {
      method: "POST",
      headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${"x".repeat(40 * 1024)}`
    })).status).toBe(413);
  });

  test("authorizes once, reconnects in a new MCP client, survives server restart, and revokes immediately", async () => {
    const issued = await authorize(handle);
    const first = await connect(handle, issued.accessToken);
    clients.push(first);
    const status = await first.callTool({ name: "authorization_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ state: "granted", mode: "full_access" });
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await connect(handle, issued.accessToken);
    clients.push(second);
    expect((await second.listTools()).tools.length).toBeGreaterThan(20);
    await second.close();
    clients.splice(clients.indexOf(second), 1);

    await handle.close();
    database.close();
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    handle = await createHttpServer({
      database,
      protector,
      host: "127.0.0.1",
      port: 0,
      remoteAuth: { publicOrigin, ownerToken, signingKeys }
    });
    const afterRestart = await connect(handle, issued.accessToken);
    clients.push(afterRestart);
    expect((await afterRestart.callTool({ name: "authorization_status", arguments: {} })).structuredContent)
      .toMatchObject({ state: "granted" });

    const revoke = await fetch(new URL("/oauth/revoke", handle.url), {
      method: "POST",
      headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: issued.accessToken })
    });
    expect(revoke.status).toBe(200);
    await expect(afterRestart.listTools()).rejects.toThrow();
  }, 30_000);

  test("refresh maps to the same grant and owner console is dark without exposing credentials", async () => {
    const issued = await authorize(handle);
    const refresh = await fetch(new URL("/oauth/token", handle.url), {
      method: "POST",
      headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refreshToken })
    });
    const refreshed = await refresh.json() as { access_token: string };
    const client = await connect(handle, refreshed.access_token);
    clients.push(client);
    expect((await client.callTool({ name: "authorization_status", arguments: {} })).structuredContent)
      .toMatchObject({ state: "granted" });

    const consoleResponse = await fetch(new URL("/owner", handle.url), {
      headers: { ...proxyHeaders, authorization: `Bearer ${ownerToken}` }
    });
    const html = await consoleResponse.text();
    expect(consoleResponse.status).toBe(200);
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("ChatGPT Web");
    expect(html).not.toContain(ownerToken);
    expect(html).not.toContain(issued.accessToken);
    const clientKey = /name="client_key" value="([^"]+)"/u.exec(html)?.[1];
    expect(clientKey).toBeTruthy();
    const disconnected = await fetch(new URL("/owner/disconnect", handle.url), {
      method: "POST",
      headers: { ...proxyHeaders, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: clientKey!, owner_token: ownerToken })
    });
    expect(disconnected.status).toBe(200);
    await expect(client.listTools()).rejects.toThrow();
  }, 30_000);
});

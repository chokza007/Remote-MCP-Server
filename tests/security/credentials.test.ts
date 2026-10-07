import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createCredentialService,
  createRedactor,
  type CredentialVault,
  type VaultCredential
} from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createHttpServer } from "../../apps/server/src/http-server.js";

class DisposableVault implements CredentialVault {
  readonly values = new Map<string, VaultCredential>();
  async write(target: string, value: VaultCredential): Promise<void> { this.values.set(target, { ...value, secret: Buffer.from(value.secret) }); }
  async read(target: string): Promise<VaultCredential | null> {
    const value = this.values.get(target);
    return value ? { ...value, secret: Buffer.from(value.secret) } : null;
  }
  async delete(target: string): Promise<boolean> { return this.values.delete(target); }
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("credential MCP security boundary", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  test("never exports credential plaintext, redacts audit, and blocks use after grant revoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-credential-security-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = openDatabase({ filename: join(root, "operational.db") });
    cleanups.push(() => database.close());
    migrateDatabase(database);
    const credentials = createCredentialService({
      database,
      vault: new DisposableVault(),
      redactor: createRedactor()
    });
    const handle = await createHttpServer({
      database,
      credentials,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x53),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x53)
      },
      host: "127.0.0.1",
      port: 0,
      artifactStoreRoot: join(root, "artifacts"),
      recoveryRoot: join(root, "recovery")
    });
    cleanups.push(() => handle.close());
    const client = new Client({ name: "credential-client", version: "1.0.0" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(handle.url, { requestInit: { headers: {
      authorization: `Bearer ${handle.localDevelopmentToken}`,
      "x-remote-mcp-principal": "credential-principal",
      "x-remote-mcp-client": "credential-client"
    } } }));
    const request = structured(await client.callTool({ name: "request_full_access", arguments: { scopes: ["computer:*"] } }));
    const grant = handle.grantPending(String(request.requestId), "fixture-owner");
    const secret = "MCP_CREDENTIAL_CANARY_ed91!";
    const created = structured(await client.callTool({
      name: "credential_create",
      arguments: { workspaceId: "workspace-a", credentialType: "api_token", secret, metadata: { note: secret } }
    }));
    expect(JSON.stringify(created)).not.toContain(secret);
    const credentialId = String((created.credential as { credentialId: string }).credentialId);
    expect(structured(await client.callTool({
      name: "credential_validate", arguments: { workspaceId: "workspace-a", credentialId }
    }))).toMatchObject({ available: true });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("credential_export");

    const rows = database.read((connection) => [
      ...connection.prepare("SELECT * FROM credential_refs").all(),
      ...connection.prepare("SELECT * FROM audit_events").all()
    ]).map((row) => JSON.stringify(row)).join("\n");
    expect(rows).not.toContain(secret);

    await client.callTool({ name: "revoke_full_access", arguments: { grantId: grant.id, reason: "fixture revoke" } });
    const denied = structured(await client.callTool({
      name: "credential_validate", arguments: { workspaceId: "workspace-a", credentialId }
    }));
    expect(denied).toMatchObject({ ok: false, error: { error_code: "AUTHORIZATION_REQUIRED" } });
  }, 30_000);
});

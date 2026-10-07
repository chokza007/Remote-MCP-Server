import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createCredentialService,
  createRedactor,
  createWindowsCredentialManager,
  type CredentialService,
  type CredentialVault,
  type VaultCredential
} from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

class MemoryCredentialVault implements CredentialVault {
  readonly entries = new Map<string, VaultCredential>();

  public async write(target: string, value: VaultCredential): Promise<void> {
    this.entries.set(target, { ...value, secret: Buffer.from(value.secret) });
  }

  public async read(target: string): Promise<VaultCredential | null> {
    const value = this.entries.get(target);
    return value ? { ...value, secret: Buffer.from(value.secret) } : null;
  }

  public async delete(target: string): Promise<boolean> {
    return this.entries.delete(target);
  }
}

describe("non-exporting credential service", () => {
  let root: string;
  let database: OperationalDatabase;
  let vault: MemoryCredentialVault;
  let service: CredentialService;
  let authorized: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-credentials-"));
    database = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(database);
    vault = new MemoryCredentialVault();
    authorized = true;
    service = createCredentialService({
      database,
      vault,
      redactor: createRedactor(),
      authorizeUse: async () => authorized
    });
  });

  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test("creates, lists, updates, uses, and deletes scoped credentials without persisting plaintext", async () => {
    const secret = "CREDENTIAL_CANARY_7f3a!";
    const created = await service.create({
      namespace: "owner-a/workspace-a",
      credentialType: "api_token",
      secret,
      username: "fixture-user",
      metadata: { label: "fixture", note: secret, password: secret }
    });
    expect(created).toMatchObject({ credentialType: "api_token", metadata: { label: "fixture", note: "[REDACTED]", password: "[REDACTED]" } });
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(service.listMetadata("owner-a/workspace-b")).toHaveLength(0);
    expect(() => service.getMetadata(created.credentialId, "owner-b/workspace-a")).toThrow(/not exist/i);

    const used = await service.use(created.credentialId, "owner-a/workspace-a", async (credential) => {
      expect(process.env.REMOTE_MCP_TEST_SECRET).toBeUndefined();
      const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.REMOTE_MCP_TEST_SECRET || 'missing')"], {
        encoding: "utf8"
      });
      expect(child.stdout).toBe("missing");
      return { echoed: credential.secret, username: credential.username };
    });
    expect(used).toEqual({ echoed: "[REDACTED]", username: "fixture-user" });

    await expect(service.use(created.credentialId, "owner-a/workspace-a", async (credential) => {
      throw new Error(`adapter failed with ${credential.secret}`);
    })).rejects.toThrow("adapter failed with [REDACTED]");

    await service.update(created.credentialId, "owner-a/workspace-a", {
      secret: "UPDATED_CREDENTIAL_CANARY_81c2!",
      username: "updated-user"
    });
    expect(await service.use(created.credentialId, "owner-a/workspace-a", async (credential) => credential.username))
      .toBe("updated-user");

    const persisted = database.read((connection) => connection.prepare(
      "SELECT * FROM credential_refs WHERE id = ?"
    ).get(created.credentialId));
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(JSON.stringify(persisted)).not.toContain("UPDATED_CREDENTIAL_CANARY_81c2!");
    expect(await service.delete(created.credentialId, "owner-a/workspace-a")).toMatchObject({ deleted: true });
    expect(service.listMetadata("owner-a/workspace-a")).toHaveLength(0);
    expect("export" in service).toBe(false);
  });

  test("fails closed for missing vault entries and authorization revoked immediately before use", async () => {
    const created = await service.create({
      namespace: "owner/workspace", credentialType: "password", secret: "missing-secret"
    });
    await vault.delete(created.vaultTarget);
    await expect(service.use(created.credentialId, "owner/workspace", async () => "unused"))
      .rejects.toThrow(/vault item is missing/i);
    await service.update(created.credentialId, "owner/workspace", { secret: "restored-secret" });
    authorized = false;
    await expect(service.use(created.credentialId, "owner/workspace", async () => "unused"))
      .rejects.toThrow(/authorization.*revoked/i);
  });

  test.runIf(process.platform === "win32")("round-trips and cleans a disposable Windows Credential Manager entry", async () => {
    const manager = createWindowsCredentialManager({
      modulePath: join(process.cwd(), "helpers", "powershell", "RemoteMcp.Credentials.psm1")
    });
    const target = `RemoteMCP/Test/${randomUUID()}`;
    try {
      await manager.write(target, { secret: Buffer.from("windows-vault-fixture", "utf8"), username: "fixture-user" });
      const value = await manager.read(target);
      expect(value?.username).toBe("fixture-user");
      expect(Buffer.from(value!.secret).toString("utf8")).toBe("windows-vault-fixture");
      expect(await manager.delete(target)).toBe(true);
      expect(await manager.read(target)).toBeNull();
    } finally {
      await manager.delete(target).catch(() => false);
    }
  }, 30_000);
});

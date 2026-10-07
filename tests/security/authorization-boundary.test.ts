import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createFilesystemAdapter } from "@remote-mcp/adapters";
import {
  assertUnambiguousWindowsPath,
  createGrantService,
  createSsrfGuard
} from "@remote-mcp/control-plane";
import { asClientId, asPrincipalId } from "@remote-mcp/contracts";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { ClientRegistry } from "../../apps/server/src/auth/client-registry.js";
import { TokenValidator } from "../../apps/server/src/auth/token-validator.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("authorization boundary revalidation", () => {
  test("rejects Unicode path components that normalize into traversal syntax", () => {
    expect(() => assertUnambiguousWindowsPath("C:\\safe\\．．\\target.txt")).toThrow(/unicode|ambiguous/i);
    expect(() => assertUnambiguousWindowsPath("C:\\งานเพลง\\ไฟล์.txt")).not.toThrow();
  });

  test("pins the validated public address and rejects a rebound connection address", async () => {
    const guard = createSsrfGuard({
      resolver: async () => [{ address: "93.184.216.34", family: 4 }]
    });
    const allowed = await guard.authorize("https://example.test/resource");
    expect(allowed.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(() => guard.assertConnectionAddress(allowed, "127.0.0.1")).toThrow(/rebind|address/i);
    expect(() => guard.assertConnectionAddress(allowed, "93.184.216.34")).not.toThrow();
  });

  test("revalidates a destination after a symlink swap before atomic commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-auth-root-"));
    const outside = await mkdtemp(join(tmpdir(), "remote-mcp-auth-outside-"));
    cleanup.push(root, outside);
    const parent = join(root, "parent");
    const displaced = join(root, "parent-original");
    await mkdir(parent);
    await writeFile(join(outside, "target.txt"), "outside-original", "utf8");
    const adapter = createFilesystemAdapter({
      allowedRoots: [root],
      beforeAtomicCommit: async () => {
        await rename(parent, displaced);
        await symlink(outside, parent, "junction");
      }
    });

    await expect(adapter.write({
      path: join(parent, "target.txt"),
      data: "attacker-controlled",
      overwrite: true
    })).rejects.toThrow(/allowed root|changed|revalidate|escape/i);
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside-original");
  });

  test("security reset rotates the epoch and invalidates grants, tokens, sessions, and approvals", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-security-reset-"));
    cleanup.push(root);
    const filename = join(root, "operational.db");
    const database = openDatabase({ filename });
    migrateDatabase(database);
    const grants = createGrantService({
      database,
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0xa5),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0xa5)
      }
    });
    const identity = {
      principalId: asPrincipalId("principal-reset"),
      clientId: asClientId("client-reset"),
      deviceId: grants.serverIdentity().deviceId
    };
    const request = grants.request({
      identity,
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: "principal-reset"
    });
    grants.grant(request.id, { kind: "local_owner", id: "owner" });
    const clients = new ClientRegistry({ database });
    const client = clients.registerPending({
      issuer: "https://remote.example.test",
      subject: "subject-reset",
      oauthClientId: "oauth-reset",
      displayName: "Reset Client"
    });
    clients.approve(client.clientKey);
    const tokens = new TokenValidator({
      database,
      issuer: "https://remote.example.test",
      audience: "https://remote.example.test/mcp",
      signingKeys: [{ keyId: "reset", secret: Buffer.alloc(32, 0x41) }]
    });
    tokens.issue(client, { nonce: "nonce-reset", scope: "computer:*" });
    database.writeTransaction((connection) => {
      connection.prepare(`
        INSERT INTO sessions(id, principal_id, client_id, device_id, connected_at, disconnected_at, last_seen_at)
        VALUES ('session-reset', ?, ?, ?, ?, NULL, ?)
      `).run(identity.principalId, identity.clientId, identity.deviceId, new Date().toISOString(), new Date().toISOString());
      connection.prepare(`
        INSERT INTO approvals(
          id, action_name, action_version, payload_hash, targets_json, principal_id, client_id,
          session_id, risk_tier, action_class, nonce, preview_json, recovery_json, created_at, expires_at, decision
        ) VALUES ('approval-reset', 'fixture', '1', 'hash', '[]', ?, ?, 'session-reset', 3,
          'system', 'nonce-reset', '{}', '{}', ?, ?, 'pending')
      `).run(identity.principalId, identity.clientId, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    });
    database.close();

    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve("scripts/operations/security-reset.ps1"),
      "-DataRoot", root, "-Force"
    ], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0);

    const reopened = openDatabase({ filename });
    const state = reopened.read((connection) => ({
      epoch: (connection.prepare("SELECT security_epoch AS value FROM server_identity WHERE id = 1").get() as { value: number }).value,
      activeGrants: (connection.prepare("SELECT COUNT(*) AS value FROM trusted_grants WHERE revoked_at IS NULL").get() as { value: number }).value,
      activeTokens: (connection.prepare("SELECT COUNT(*) AS value FROM oauth_tokens WHERE revoked_at IS NULL").get() as { value: number }).value,
      trustedClients: (connection.prepare("SELECT COUNT(*) AS value FROM oauth_clients WHERE status = 'trusted'").get() as { value: number }).value,
      connectedSessions: (connection.prepare("SELECT COUNT(*) AS value FROM sessions WHERE disconnected_at IS NULL").get() as { value: number }).value,
      pendingApprovals: (connection.prepare("SELECT COUNT(*) AS value FROM approvals WHERE decision = 'pending'").get() as { value: number }).value
    }));
    reopened.close();
    expect(state).toEqual({
      epoch: 2,
      activeGrants: 0,
      activeTokens: 0,
      trustedClients: 0,
      connectedSessions: 0,
      pendingApprovals: 0
    });
  });
});

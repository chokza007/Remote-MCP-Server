import { createPrivateKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { asClientId, asPrincipalId, asSessionId } from "@remote-mcp/contracts";
import {
  migrateDatabase,
  openDatabase,
  type OperationalDatabase
} from "@remote-mcp/persistence";

interface GrantServiceContract {
  serverIdentity(): { readonly deviceId: string; readonly publicKey: string };
  request(input: {
    readonly identity: {
      readonly principalId: string;
      readonly clientId: string;
      readonly deviceId: string;
      readonly sessionId: string;
    };
    readonly mode: "full_access";
    readonly scopes: readonly string[];
    readonly requestedBy: string;
  }): { readonly id: string };
  grant(
    requestId: string,
    actor: { readonly id: string; readonly kind: "local_owner" }
  ): { readonly id: string };
  resolve(identity: {
    readonly principalId: string;
    readonly clientId: string;
    readonly deviceId: string;
    readonly sessionId: string;
  }): { readonly state: string; readonly grant?: { readonly id: string } };
}

interface ControlPlaneModule {
  createGrantService?: (options: { database: OperationalDatabase }) => GrantServiceContract;
}

describe("trusted grant persistence", () => {
  let fixtureRoot: string;
  const databases: OperationalDatabase[] = [];

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "remote-mcp-grants-"));
  });

  afterEach(async () => {
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  function track(database: OperationalDatabase): OperationalDatabase {
    databases.push(database);
    return database;
  }

  test("recognizes the same persistent grant after closing and reopening SQLite", async () => {
    const controlPlane = (await import("@remote-mcp/control-plane")) as ControlPlaneModule;
    expect(typeof controlPlane.createGrantService).toBe("function");
    const filename = join(fixtureRoot, "operational.db");
    const firstDatabase = track(openDatabase({ filename }));
    migrateDatabase(firstDatabase);
    const firstService = controlPlane.createGrantService!({ database: firstDatabase });
    const deviceId = firstService.serverIdentity().deviceId;
    const identity = {
      principalId: asPrincipalId("principal-persistent"),
      clientId: asClientId("client-persistent"),
      deviceId,
      sessionId: asSessionId("session-before-restart")
    };
    const request = firstService.request({
      identity,
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: "principal-persistent"
    });
    const grant = firstService.grant(request.id, { id: "local-owner", kind: "local_owner" });

    const stored = firstDatabase.read((connection) => ({
      identity: connection
        .prepare("SELECT protected_private_key FROM server_identity WHERE id = 1")
        .get() as { protected_private_key: Buffer },
      grant: connection
        .prepare("SELECT integrity_tag FROM trusted_grants WHERE id = ?")
        .get(grant.id) as { integrity_tag: string },
      events: connection
        .prepare("SELECT event_type FROM grant_events WHERE grant_id = ? ORDER BY id")
        .all(grant.id) as Array<{ event_type: string }>
    }));
    expect(stored.grant.integrity_tag.length).toBeGreaterThan(40);
    expect(stored.events).toEqual([{ event_type: "granted" }]);
    expect(() =>
      createPrivateKey({ key: stored.identity.protected_private_key, format: "der", type: "pkcs8" })
    ).toThrow();

    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);

    const reopenedDatabase = track(openDatabase({ filename }));
    migrateDatabase(reopenedDatabase);
    const reopenedService = controlPlane.createGrantService!({ database: reopenedDatabase });
    expect(reopenedService.serverIdentity().deviceId).toBe(deviceId);
    expect(
      reopenedService.resolve({ ...identity, sessionId: asSessionId("session-after-restart") })
    ).toEqual({ state: "granted", grant: expect.objectContaining({ id: grant.id }) });
  });
});

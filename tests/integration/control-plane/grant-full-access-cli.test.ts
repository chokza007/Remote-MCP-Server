import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { asClientId, asPrincipalId, asSessionId } from "@remote-mcp/contracts";
import { createGrantService } from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const execFileAsync = promisify(execFile);

describe("local Full Access owner command", () => {
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("grants a pending computer-wide request and persists it", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-owner-grant-"));
    fixtureRoots.push(root);
    const filename = join(root, "operational.db");
    let database = openDatabase({ filename });
    migrateDatabase(database);
    let grants = createGrantService({ database });
    const identity = {
      principalId: asPrincipalId("chatgpt-owner"),
      clientId: asClientId("remote-mcp-server"),
      deviceId: grants.serverIdentity().deviceId,
      sessionId: asSessionId("first-connection")
    };
    const request = grants.request({
      identity,
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: identity.principalId
    });
    database.close();

    const result = await execFileAsync(process.execPath, [
      resolve("scripts/operations/grant-full-access.mjs"),
      filename,
      request.id,
      "fixture-owner"
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "granted",
      principalId: identity.principalId,
      clientId: identity.clientId,
      scopes: ["computer:*"],
      expiresAt: null
    });

    database = openDatabase({ filename });
    try {
      migrateDatabase(database);
      grants = createGrantService({ database });
      expect(grants.resolve({ ...identity, sessionId: asSessionId("later-connection") }))
        .toMatchObject({ state: "granted" });
    } finally {
      database.close();
    }
  });
});

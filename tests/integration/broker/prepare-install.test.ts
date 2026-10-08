import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { asClientId, asDeviceId, asPrincipalId } from "@remote-mcp/contracts";
import { createEmergencyStopService, createGrantService, verifyPrivilegedRequest, createNonceStore } from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("production broker signing preparation", () => {
  test.skipIf(process.platform !== "win32")("exports a valid signed snapshot and stable public key without private key exposure", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-broker-stage-"));
    dirs.push(root);
    const db = openDatabase({ filename: join(root, "operational.db") });
    migrateDatabase(db);
    const grants = createGrantService({ database: db });
    const identity = {
      principalId: asPrincipalId("test-owner"),
      clientId: asClientId("test-client"),
      deviceId: asDeviceId(grants.serverIdentity().deviceId)
    };
    const request = grants.request({ identity, scopes: ["computer:*"], mode: "full_access", requestedBy: "test" });
    grants.grant(request.id, { kind: "local_owner", id: "test" });
    db.close();

    const script = resolve("scripts/broker/prepare-install.mjs");
    const first = JSON.parse((await execFileAsync("node", [script,root], { windowsHide: true })).stdout) as {
      publicKeyPath: string; authorizationStatePath: string; grantCount: number
    };
    expect(first.grantCount).toBe(1);
    const publicKey = await readFile(first.publicKeyPath, "utf8");
    const snapshot = JSON.parse(await readFile(first.authorizationStatePath, "utf8")) as {
      state: { grants: { active: boolean }[] }; signature: string
    };
    expect(publicKey.length).toBeGreaterThan(40);
    expect(snapshot.signature.length).toBeGreaterThan(40);
    expect(snapshot.state.grants.some((g) => g.active)).toBe(true);

    const second = JSON.parse((await execFileAsync("node", [script,root], { windowsHide: true })).stdout) as {publicKeyPath:string};
    expect(await readFile(second.publicKeyPath, "utf8")).toBe(publicKey);

    const check = openDatabase({ filename: join(root, "operational.db") });
    try {
      const state = createEmergencyStopService({ database: check });
      state.activate({kind:"local_owner",id:"test"}, "test-stop");
    } finally { check.close(); }
    await expect(execFileAsync("node", [script,root], { windowsHide: true })).rejects.toThrow(/Emergency Stop/);
  }, 40_000);
});

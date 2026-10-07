import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { asClientId, asDeviceId, asPrincipalId } from "@remote-mcp/contracts";
import { createEmergencyStopService, createGrantService } from "@remote-mcp/control-plane";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x47),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x47)
};
const execFileAsync = promisify(execFile);

describe("persistent Full Access lifecycle", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup())));

  test("one grant survives reconnect/restart, Emergency Stop is durable, and revoke blocks the next action", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-grant-lifecycle-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, "operational.db");
    let database = openDatabase({ filename });
    migrateDatabase(database);
    let grants = createGrantService({ database, protector });
    const identity = {
      principalId: asPrincipalId("chatgpt-principal"),
      clientId: asClientId("chatgpt-client"),
      deviceId: asDeviceId(grants.serverIdentity().deviceId)
    };
    const request = grants.request({ identity, mode: "full_access", scopes: ["computer:*"], requestedBy: "acceptance" });
    const grant = grants.grant(request.id, { id: "owner", kind: "authenticated_owner" });
    expect(grant.expiresAt).toBeNull();
    expect(grants.resolve(identity)).toMatchObject({ state: "granted", grant: { id: grant.id } });
    database.close();

    database = openDatabase({ filename });
    migrateDatabase(database);
    cleanups.push(() => database.close());
    grants = createGrantService({ database, protector });
    expect(grants.resolve(identity)).toMatchObject({ state: "granted" });
    const statePath = join(root, "signed-reboot-state.json");
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      resolve("scripts/system-acceptance/reboot-persistence.ps1"),
      "-DataRoot", root, "-ProjectRoot", resolve("."), "-StatePath", statePath, "-PrepareOnly"
    ]);
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      resolve("scripts/system-acceptance/continue-after-reboot.ps1"),
      "-StatePath", statePath, "-Simulate"
    ]);
    expect(JSON.parse(await readFile(join(root, "reboot-acceptance-result.json"), "utf8")))
      .toMatchObject({ result: "PASS", simulated: true, deviceId: identity.deviceId });
    const emergency = createEmergencyStopService({ database });
    emergency.activate({ id: "owner", kind: "authenticated_owner" }, "acceptance drill");
    expect(createEmergencyStopService({ database }).isActive()).toBe(true);
    emergency.clear({ id: "owner", kind: "authenticated_owner" });
    grants.revoke(grant.id, { id: "owner", kind: "authenticated_owner" }, "acceptance revoke");
    expect(grants.resolve(identity)).toMatchObject({ state: "restricted", reason: "revoked" });
  });
});

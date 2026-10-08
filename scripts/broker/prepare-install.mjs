import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { createCapabilityTokenService, createEmergencyStopService, createGrantService, DpapiSecretProtector } from "@remote-mcp/control-plane";
import { openDatabase } from "@remote-mcp/persistence";

const dataRoot = process.argv[2];
if (!dataRoot) {
  throw new Error("usage: node scripts/broker/prepare-install.mjs <existing-data-root>");
}
const root = resolve(dataRoot);
const databaseFile = join(root, "operational.db");
if (!existsSync(databaseFile)) throw new Error("Operational database missing: broker preparation cannot initialize a new machine");
const database = openDatabase({ filename: databaseFile });
try {
  const grants = createGrantService({ database });
  const emergencyStop = createEmergencyStopService({ database });
  if (emergencyStop.isActive()) {
    throw new Error("Emergency Stop is active; owner recovery is required before broker preparation");
  }
  const capabilities = createCapabilityTokenService({
    database, grants, protector: new DpapiSecretProtector(),
    isEmergencyStopActive: () => emergencyStop.isActive()
  });
  const staging = join(root, "broker-install-staging");
  await mkdir(staging, { recursive: true });
  const publicKey = join(staging, "public-key.txt");
  const authorizationState = join(staging, "authorization.json");
  await writeFile(publicKey, capabilities.publicKey(), { encoding: "utf8", mode: 0o600 });
  const snapshot = await capabilities.writeAuthorizationSnapshot(authorizationState);
  process.stdout.write(JSON.stringify({
    prepared: true,
    publicKeyPath: publicKey,
    authorizationStatePath: authorizationState,
    grantCount: snapshot.state.grants.filter((grant) => grant.active && grant.mode === "full_access").length
  }) + "\n");
} finally {
  database.close();
}

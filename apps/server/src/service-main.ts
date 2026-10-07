import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

import { createHttpServer, type RemoteAuthOptions } from "./http-server.js";
import type { OAuthSigningKey } from "./auth/token-validator.js";

async function requiredSecret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32) throw new Error(`Secret file is too short: ${path}`);
  return value;
}

async function localToken(dataRoot: string): Promise<string> {
  const path = join(dataRoot, "local-development-token.txt");
  try {
    return await requiredSecret(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = randomBytes(48).toString("base64url");
    await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return value;
  }
}

function parseSigningKeys(content: string): readonly OAuthSigningKey[] {
  if (content.startsWith("[")) {
    const parsed = JSON.parse(content) as Array<{ readonly keyId: string; readonly secret: string }>;
    return parsed.map((key) => ({ keyId: key.keyId, secret: Buffer.from(key.secret, "base64") }));
  }
  const secret = Buffer.from(content, "base64");
  return [{ keyId: createHash("sha256").update(secret).digest("hex").slice(0, 16), secret }];
}

async function main(): Promise<void> {
  const dataRoot = resolve(process.env.REMOTE_MCP_DATA_ROOT ?? "var");
  await mkdir(dataRoot, { recursive: true });
  const database = openDatabase({ filename: join(dataRoot, "operational.db") });
  migrateDatabase(database);
  const publicOrigin = process.env.REMOTE_MCP_PUBLIC_ORIGIN;
  let remoteAuth: RemoteAuthOptions | undefined;
  if (publicOrigin !== undefined) {
    const ownerTokenPath = resolve(process.env.REMOTE_MCP_OWNER_TOKEN_FILE ?? join(dataRoot, "owner-token.txt"));
    const signingKeyPath = resolve(process.env.REMOTE_MCP_SIGNING_KEY_FILE ?? join(dataRoot, "oauth-signing-key.txt"));
    remoteAuth = {
      publicOrigin,
      ownerToken: await requiredSecret(ownerTokenPath),
      signingKeys: parseSigningKeys(await requiredSecret(signingKeyPath))
    };
  }
  const handle = await createHttpServer({
    database,
    host: process.env.REMOTE_MCP_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.REMOTE_MCP_PORT ?? "7331", 10),
    localDevelopmentToken: await localToken(dataRoot),
    artifactStoreRoot: join(dataRoot, "artifacts"),
    recoveryRoot: join(dataRoot, "recovery"),
    browserProfileRoot: join(dataRoot, "browser", "profiles"),
    browserArtifactRoot: join(dataRoot, "artifacts", "browser"),
    guiArtifactRoot: join(dataRoot, "artifacts", "screenshots"),
    ...(remoteAuth === undefined ? {} : { remoteAuth })
  });
  process.stdout.write(`Remote MCP listening at ${handle.url.href}\n`);
  const shutdown = async (): Promise<void> => {
    await handle.close();
    database.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

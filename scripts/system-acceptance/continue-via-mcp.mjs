import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";

const [databasePath, tokenPath, endpoint, artifactPath] = process.argv.slice(2);
if (!databasePath || !tokenPath || !endpoint || !artifactPath) {
  throw new Error("Usage: node continue-via-mcp.mjs <db> <token-file> <endpoint> <artifact-path>");
}
const endpointUrl = new URL(endpoint);
if (endpointUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpointUrl.hostname)) {
  throw new Error("Reboot continuation verification only connects to a loopback MCP endpoint");
}
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
let identity;
try {
  identity = database.prepare(
    `SELECT principal_id AS principalId, client_id AS clientId, id AS grantId
     FROM trusted_grants WHERE revoked_at IS NULL AND mode = 'full_access' ORDER BY created_at, id LIMIT 1`
  ).get();
} finally {
  database.close();
}
if (!identity) throw new Error("No active persistent grant exists for MCP continuation");
const token = (await readFile(tokenPath, "utf8")).trim();
const client = new Client({ name: "reboot-continuation", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(endpointUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        "x-remote-mcp-principal": identity.principalId,
        "x-remote-mcp-client": identity.clientId
      }
    }
  }));
  const authorization = await client.callTool({ name: "authorization_status", arguments: {} });
  if (authorization.isError || authorization.structuredContent?.state !== "granted") {
    throw new Error(`Persistent authorization was not recognized: ${JSON.stringify(authorization.structuredContent)}`);
  }
  const mutation = await client.callTool({
    name: "filesystem_write",
    arguments: {
      path: artifactPath,
      data: `MCP_REBOOT_CONTINUATION_PASS ${new Date().toISOString()}`,
      overwrite: true
    }
  });
  if (mutation.isError || mutation.structuredContent?.changed !== true) {
    throw new Error(`Post-reboot MCP mutation failed: ${JSON.stringify(mutation.structuredContent)}`);
  }
  process.stdout.write(JSON.stringify({ result: "PASS", grantId: identity.grantId, artifactPath }) + "\n");
} finally {
  await client.close().catch(() => undefined);
}

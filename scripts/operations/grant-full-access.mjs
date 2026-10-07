import { createGrantService } from "@remote-mcp/control-plane";
import { openDatabase } from "@remote-mcp/persistence";

const [databasePath, requestId, actor] = process.argv.slice(2);

if (!databasePath || !requestId || !actor) {
  throw new Error("usage: grant-full-access.mjs <database> <request-id> <actor>");
}

const database = openDatabase({ filename: databasePath });
try {
  const grants = createGrantService({ database });
  const grant = grants.grant(requestId, { kind: "authenticated_owner", id: actor });
  process.stdout.write(`${JSON.stringify({
    status: "granted",
    grantId: grant.id,
    principalId: grant.principalId,
    clientId: grant.clientId,
    scopes: grant.scopes,
    expiresAt: grant.expiresAt
  }, null, 2)}\n`);
} finally {
  database.close();
}

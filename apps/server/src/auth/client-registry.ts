import { createHash, randomUUID } from "node:crypto";

import { asClientId, asPrincipalId, type ClientId, type PrincipalId } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export type RegisteredClientStatus = "pending" | "trusted" | "disconnected";

export interface RegisteredClient {
  readonly clientKey: string;
  readonly issuer: string;
  readonly subject: string;
  readonly oauthClientId: string;
  readonly principalId: PrincipalId;
  readonly clientId: ClientId;
  readonly displayName: string;
  readonly status: RegisteredClientStatus;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly disconnectedAt: string | null;
}

export interface RegisterClientInput {
  readonly issuer: string;
  readonly subject: string;
  readonly oauthClientId: string;
  readonly displayName: string;
}

interface ClientRow {
  readonly client_key: string;
  readonly issuer: string;
  readonly subject: string;
  readonly oauth_client_id: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly display_name: string;
  readonly status: RegisteredClientStatus;
  readonly created_at: string;
  readonly approved_at: string | null;
  readonly disconnected_at: string | null;
}

function mapRow(row: ClientRow): RegisteredClient {
  return {
    clientKey: row.client_key,
    issuer: row.issuer,
    subject: row.subject,
    oauthClientId: row.oauth_client_id,
    principalId: asPrincipalId(row.principal_id),
    clientId: asClientId(row.client_id),
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    disconnectedAt: row.disconnected_at
  };
}

export class ClientRegistry {
  readonly #database: OperationalDatabase;
  readonly #now: () => Date;

  public constructor(options: { readonly database: OperationalDatabase; readonly now?: () => Date }) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  public registerPending(input: RegisterClientInput): RegisteredClient {
    for (const value of [input.issuer, input.subject, input.oauthClientId, input.displayName]) {
      if (value.trim().length === 0) throw new Error("OAuth client identity fields must not be empty");
    }
    const existing = this.find(input.issuer, input.subject, input.oauthClientId);
    if (existing) return existing;
    const clientKey = createHash("sha256")
      .update(`${input.issuer}\0${input.subject}\0${input.oauthClientId}`, "utf8")
      .digest("hex");
    const createdAt = this.#now().toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(`
      INSERT INTO oauth_clients(
        client_key, issuer, subject, oauth_client_id, principal_id, client_id,
        display_name, status, created_at, approved_at, disconnected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
    `).run(
      clientKey,
      input.issuer,
      input.subject,
      input.oauthClientId,
      `oauth:${randomUUID()}`,
      `oauth-client:${randomUUID()}`,
      input.displayName,
      createdAt
    ));
    return this.get(clientKey);
  }

  public approve(clientKey: string): RegisteredClient {
    const client = this.get(clientKey);
    if (client.status === "disconnected") throw new Error("OAuth client was disconnected");
    if (client.status === "trusted") return client;
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(`
      UPDATE oauth_clients SET status = 'trusted', approved_at = ?, disconnected_at = NULL
      WHERE client_key = ? AND status = 'pending'
    `).run(now, clientKey));
    return this.get(clientKey);
  }

  public disconnect(clientKey: string): RegisteredClient {
    this.get(clientKey);
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(`
      UPDATE oauth_clients SET status = 'disconnected', disconnected_at = ? WHERE client_key = ?
    `).run(now, clientKey));
    return this.get(clientKey);
  }

  public get(clientKey: string): RegisteredClient {
    const row = this.#database.read((connection) => connection.prepare(
      "SELECT * FROM oauth_clients WHERE client_key = ?"
    ).get(clientKey) as ClientRow | undefined);
    if (!row) throw new Error(`OAuth client was not found: ${clientKey}`);
    return mapRow(row);
  }

  public find(issuer: string, subject: string, oauthClientId: string): RegisteredClient | undefined {
    const row = this.#database.read((connection) => connection.prepare(`
      SELECT * FROM oauth_clients WHERE issuer = ? AND subject = ? AND oauth_client_id = ?
    `).get(issuer, subject, oauthClientId) as ClientRow | undefined);
    return row === undefined ? undefined : mapRow(row);
  }

  public list(): readonly RegisteredClient[] {
    return this.#database.read((connection) => (connection.prepare(
      "SELECT * FROM oauth_clients ORDER BY created_at DESC"
    ).all() as ClientRow[]).map(mapRow));
  }
}

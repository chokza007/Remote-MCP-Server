import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import { ClientRegistry, type RegisteredClient } from "./client-registry.js";
import { TokenValidator, type IssuedTokens } from "./token-validator.js";

export interface AuthorizationRequestInput {
  readonly issuer: string;
  readonly subject: string;
  readonly oauthClientId: string;
  readonly displayName: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly scope: string;
}

export interface PendingAuthorization {
  readonly requestId: string;
  readonly clientKey: string;
  readonly displayName: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly expiresAt: string;
}

export interface ApprovedAuthorization {
  readonly code: string;
  readonly redirectUri: string;
  readonly client: RegisteredClient;
}

interface RequestRow {
  readonly request_id: string;
  readonly client_key: string;
  readonly redirect_uri: string;
  readonly state: string;
  readonly nonce: string;
  readonly code_challenge: string;
  readonly scope: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
}

interface CodeRow {
  readonly code_hash: string;
  readonly request_id: string;
  readonly client_key: string;
  readonly redirect_uri: string;
  readonly nonce: string;
  readonly code_challenge: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateRedirect(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !loopback) throw new Error("OAuth redirect URI must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.hash) throw new Error("OAuth redirect URI is invalid");
  return url;
}

export class OwnerConsentService {
  readonly #database: OperationalDatabase;
  readonly #clients: ClientRegistry;
  readonly #tokens: TokenValidator;
  readonly #ownerToken: string;
  readonly #now: () => Date;
  readonly #onApproved: ((client: RegisteredClient) => void | Promise<void>) | undefined;

  public constructor(options: {
    readonly database: OperationalDatabase;
    readonly clients: ClientRegistry;
    readonly tokens: TokenValidator;
    readonly ownerToken: string;
    readonly now?: () => Date;
    readonly onApproved?: (client: RegisteredClient) => void | Promise<void>;
  }) {
    if (options.ownerToken.length < 32) throw new Error("Owner authentication token must contain at least 32 characters");
    this.#database = options.database;
    this.#clients = options.clients;
    this.#tokens = options.tokens;
    this.#ownerToken = options.ownerToken;
    this.#now = options.now ?? (() => new Date());
    this.#onApproved = options.onApproved;
  }

  public begin(input: AuthorizationRequestInput): PendingAuthorization {
    if (input.state.length < 16) throw new Error("OAuth state requires sufficient entropy");
    if (input.nonce.length < 16) throw new Error("OAuth nonce requires sufficient entropy");
    if (input.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) {
      throw new Error("OAuth PKCE S256 code challenge is invalid");
    }
    if (input.scope !== "computer:*") throw new Error("Requested OAuth scope is unsupported");
    const redirectUri = validateRedirect(input.redirectUri).href;
    const client = this.#clients.registerPending(input);
    if (client.status === "disconnected") throw new Error("OAuth client was disconnected");
    const requestId = randomUUID();
    const createdAt = this.#now();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1_000).toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(`
      INSERT INTO oauth_authorization_requests(
        request_id, client_key, redirect_uri, state, nonce, code_challenge,
        code_challenge_method, scope, created_at, expires_at, decided_at, decision
      ) VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?, NULL, NULL)
    `).run(
      requestId, client.clientKey, redirectUri, input.state, input.nonce,
      input.codeChallenge, input.scope, createdAt.toISOString(), expiresAt
    ));
    return { requestId, clientKey: client.clientKey, displayName: client.displayName, redirectUri, scope: input.scope, expiresAt };
  }

  public async approve(requestId: string, ownerToken: string): Promise<ApprovedAuthorization> {
    if (!constantEqual(ownerToken, this.#ownerToken)) throw new Error("Owner authentication failed");
    const request = this.#request(requestId);
    if (request.decided_at !== null) throw new Error("Authorization request was already decided");
    if (request.expires_at <= this.#now().toISOString()) throw new Error("Authorization request expired");
    const client = this.#clients.approve(request.client_key);
    await this.#onApproved?.(client);
    const code = randomBytes(32).toString("base64url");
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => {
      connection.prepare(`
        UPDATE oauth_authorization_requests SET decided_at = ?, decision = 'approved' WHERE request_id = ?
      `).run(now, requestId);
      connection.prepare(`
        INSERT INTO oauth_authorization_codes(
          code_hash, request_id, client_key, redirect_uri, nonce, code_challenge, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(hash(code), requestId, request.client_key, request.redirect_uri, request.nonce, request.code_challenge,
        new Date(this.#now().getTime() + 5 * 60 * 1_000).toISOString());
    });
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", request.state);
    return { code, redirectUri: redirect.href, client };
  }

  public deny(requestId: string, ownerToken: string): string {
    if (!constantEqual(ownerToken, this.#ownerToken)) throw new Error("Owner authentication failed");
    const request = this.#request(requestId);
    if (request.decided_at !== null) throw new Error("Authorization request was already decided");
    this.#database.writeTransaction((connection) => connection.prepare(`
      UPDATE oauth_authorization_requests SET decided_at = ?, decision = 'denied' WHERE request_id = ?
    `).run(this.#now().toISOString(), requestId));
    const redirect = new URL(request.redirect_uri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", request.state);
    return redirect.href;
  }

  public exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly oauthClientId: string;
  }): IssuedTokens {
    const codeHash = hash(input.code);
    const row = this.#database.read((connection) => connection.prepare(
      "SELECT * FROM oauth_authorization_codes WHERE code_hash = ?"
    ).get(codeHash) as CodeRow | undefined);
    if (!row || row.consumed_at !== null) throw new Error("Authorization code is invalid or already consumed");
    if (row.expires_at <= this.#now().toISOString()) throw new Error("Authorization code expired");
    if (validateRedirect(input.redirectUri).href !== row.redirect_uri) throw new Error("OAuth redirect URI mismatch");
    const client = this.#clients.get(row.client_key);
    if (client.oauthClientId !== input.oauthClientId) throw new Error("OAuth client mismatch");
    const computed = createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url");
    if (!constantEqual(computed, row.code_challenge)) throw new Error("OAuth PKCE verification failed");
    const consumedAt = this.#now().toISOString();
    const result = this.#database.writeTransaction((connection) => connection.prepare(`
      UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL
    `).run(consumedAt, codeHash));
    if (result.changes !== 1) throw new Error("Authorization code replay detected");
    const request = this.#request(row.request_id);
    return this.#tokens.issue(client, { nonce: row.nonce, scope: request.scope });
  }

  public pending(requestId: string): PendingAuthorization {
    const row = this.#request(requestId);
    const client = this.#clients.get(row.client_key);
    return {
      requestId,
      clientKey: row.client_key,
      displayName: client.displayName,
      redirectUri: row.redirect_uri,
      scope: row.scope,
      expiresAt: row.expires_at
    };
  }

  #request(requestId: string): RequestRow {
    const row = this.#database.read((connection) => connection.prepare(
      "SELECT * FROM oauth_authorization_requests WHERE request_id = ?"
    ).get(requestId) as RequestRow | undefined);
    if (!row) throw new Error("Authorization request was not found");
    return row;
  }
}

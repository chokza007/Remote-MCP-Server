import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { RegisteredClient } from "./client-registry.js";

export interface OAuthSigningKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

interface TokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly client_id: string;
  readonly client_key: string;
  readonly jti: string;
  readonly token_type: "access" | "refresh";
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
  readonly scope: string;
}

interface TokenRow {
  readonly jti: string;
  readonly client_key: string;
  readonly token_type: "access" | "refresh";
  readonly token_hash: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

export interface ValidatedAccessToken {
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly scope: string;
  readonly jti: string;
  readonly clientKey: string;
  readonly identity: {
    readonly principalId: string;
    readonly clientId: string;
  };
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly scope: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class TokenValidator {
  readonly #database: OperationalDatabase;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #keys = new Map<string, Buffer>();
  readonly #now: () => Date;
  #currentKeyId: string;

  public constructor(options: {
    readonly database: OperationalDatabase;
    readonly issuer: string;
    readonly audience: string;
    readonly signingKeys: readonly OAuthSigningKey[];
    readonly now?: () => Date;
  }) {
    if (options.signingKeys.length === 0) throw new Error("At least one OAuth signing key is required");
    this.#database = options.database;
    this.#issuer = new URL(options.issuer).origin;
    this.#audience = options.audience;
    this.#now = options.now ?? (() => new Date());
    for (const key of options.signingKeys) this.#addKey(key);
    this.#currentKeyId = options.signingKeys[0]!.keyId;
  }

  public rotateSigningKey(key: OAuthSigningKey): void {
    this.#addKey(key);
    this.#currentKeyId = key.keyId;
  }

  public issue(client: RegisteredClient, input: { readonly nonce: string; readonly scope: string }): IssuedTokens {
    const currentClient = this.#client(client.clientKey);
    if (currentClient.status !== "trusted") throw new Error("OAuth client is not trusted");
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    const accessLifetime = 15 * 60;
    const refreshLifetime = 30 * 24 * 60 * 60;
    const accessClaims = this.#claims(currentClient, "access", input, nowSeconds, accessLifetime);
    const refreshClaims = this.#claims(currentClient, "refresh", input, nowSeconds, refreshLifetime);
    const accessToken = this.#sign(accessClaims);
    const refreshToken = this.#sign(refreshClaims);
    this.#database.writeTransaction((connection) => {
      const insert = connection.prepare(`
        INSERT INTO oauth_tokens(jti, client_key, token_type, token_hash, issued_at, expires_at, revoked_at, replaced_by)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `);
      insert.run(accessClaims.jti, currentClient.clientKey, "access", tokenHash(accessToken),
        new Date(accessClaims.iat * 1_000).toISOString(), new Date(accessClaims.exp * 1_000).toISOString());
      insert.run(refreshClaims.jti, currentClient.clientKey, "refresh", tokenHash(refreshToken),
        new Date(refreshClaims.iat * 1_000).toISOString(), new Date(refreshClaims.exp * 1_000).toISOString());
    });
    return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: accessLifetime, scope: input.scope };
  }

  public validateAccessToken(token: string): ValidatedAccessToken {
    const claims = this.#validate(token, "access");
    return {
      issuer: claims.iss,
      audience: claims.aud,
      nonce: claims.nonce,
      scope: claims.scope,
      jti: claims.jti,
      clientKey: claims.client_key,
      identity: { principalId: claims.sub, clientId: claims.client_id }
    };
  }

  public refresh(refreshToken: string): IssuedTokens {
    const claims = this.#validate(refreshToken, "refresh");
    const client = this.#client(claims.client_key);
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => {
      const result = connection.prepare(`
        UPDATE oauth_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL
      `).run(now, claims.jti);
      if (result.changes !== 1) throw new Error("Refresh token replay or revocation detected");
    });
    return this.issue(client, { nonce: claims.nonce, scope: claims.scope });
  }

  public revokeToken(token: string): void {
    const claims = this.#decodeAndVerify(token);
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(
      "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE jti = ?"
    ).run(now, claims.jti));
  }

  public revokeClient(clientKey: string): void {
    const now = this.#now().toISOString();
    this.#database.writeTransaction((connection) => connection.prepare(
      "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE client_key = ?"
    ).run(now, clientKey));
  }

  #claims(
    client: RegisteredClient,
    tokenType: "access" | "refresh",
    input: { readonly nonce: string; readonly scope: string },
    nowSeconds: number,
    lifetime: number
  ): TokenClaims {
    return {
      iss: this.#issuer,
      aud: this.#audience,
      sub: client.principalId,
      client_id: client.clientId,
      client_key: client.clientKey,
      jti: randomUUID(),
      token_type: tokenType,
      iat: nowSeconds,
      exp: nowSeconds + lifetime,
      nonce: input.nonce,
      scope: input.scope
    };
  }

  #sign(claims: TokenClaims): string {
    const header = encode({ alg: "HS256", typ: "JWT", kid: this.#currentKeyId });
    const payload = encode(claims);
    const key = this.#keys.get(this.#currentKeyId)!;
    const signature = createHmac("sha256", key).update(`${header}.${payload}`, "ascii").digest("base64url");
    return `${header}.${payload}.${signature}`;
  }

  #validate(token: string, expectedType: "access" | "refresh"): TokenClaims {
    const claims = this.#decodeAndVerify(token);
    if (claims.iss !== this.#issuer) throw new Error("OAuth token issuer is invalid");
    if (claims.aud !== this.#audience) throw new Error("OAuth token audience is invalid");
    if (claims.token_type !== expectedType) throw new Error(`OAuth token type is not ${expectedType}`);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (claims.iat > nowSeconds + 60) throw new Error("OAuth token issued-at time is invalid");
    if (claims.exp <= nowSeconds) throw new Error("OAuth token expired");
    const row = this.#database.read((connection) => connection.prepare(
      "SELECT jti, client_key, token_type, token_hash, expires_at, revoked_at FROM oauth_tokens WHERE jti = ?"
    ).get(claims.jti) as TokenRow | undefined);
    if (!row || row.token_hash !== tokenHash(token) || row.token_type !== expectedType || row.client_key !== claims.client_key) {
      throw new Error("OAuth token is invalid or unknown");
    }
    if (row.revoked_at !== null) throw new Error("OAuth token was revoked or replayed");
    const client = this.#client(claims.client_key);
    if (client.status !== "trusted") throw new Error("OAuth client was disconnected");
    return claims;
  }

  #decodeAndVerify(token: string): TokenClaims {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("OAuth token format is invalid");
    const [encodedHeader, encodedPayload, presentedSignature] = parts as [string, string, string];
    const header = decodeJson<{ readonly alg?: string; readonly kid?: string }>(encodedHeader);
    if (header.alg !== "HS256" || !header.kid) throw new Error("OAuth token algorithm is invalid");
    const key = this.#keys.get(header.kid);
    if (!key) throw new Error("OAuth token signing key is unknown");
    const expected = Buffer.from(createHmac("sha256", key)
      .update(`${encodedHeader}.${encodedPayload}`, "ascii").digest("base64url"), "ascii");
    const presented = Buffer.from(presentedSignature, "ascii");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new Error("OAuth token signature is invalid");
    }
    return decodeJson<TokenClaims>(encodedPayload);
  }

  #client(clientKey: string): RegisteredClient {
    const row = this.#database.read((connection) => connection.prepare(
      "SELECT * FROM oauth_clients WHERE client_key = ?"
    ).get(clientKey) as Record<string, unknown> | undefined);
    if (!row) throw new Error("OAuth client is unknown");
    return {
      clientKey: String(row.client_key),
      issuer: String(row.issuer),
      subject: String(row.subject),
      oauthClientId: String(row.oauth_client_id),
      principalId: String(row.principal_id) as RegisteredClient["principalId"],
      clientId: String(row.client_id) as RegisteredClient["clientId"],
      displayName: String(row.display_name),
      status: String(row.status) as RegisteredClient["status"],
      createdAt: String(row.created_at),
      approvedAt: row.approved_at === null ? null : String(row.approved_at),
      disconnectedAt: row.disconnected_at === null ? null : String(row.disconnected_at)
    };
  }

  #addKey(key: OAuthSigningKey): void {
    if (key.keyId.trim().length === 0 || key.secret.byteLength < 32) {
      throw new Error("OAuth signing keys require an ID and at least 32 bytes");
    }
    this.#keys.set(key.keyId, Buffer.from(key.secret));
  }
}

export function generateOAuthSigningKey(keyId = randomBytes(8).toString("hex")): OAuthSigningKey {
  return { keyId, secret: randomBytes(32) };
}

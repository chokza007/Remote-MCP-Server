import { createHash, randomBytes } from "node:crypto";

import { beforeEach, describe, expect, test } from "vitest";

import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";
import { ClientRegistry } from "../../apps/server/src/auth/client-registry.js";
import { OwnerConsentService } from "../../apps/server/src/auth/owner-consent.js";
import { LocalOAuthProvider } from "../../apps/server/src/auth/oauth-provider.js";
import { TokenValidator } from "../../apps/server/src/auth/token-validator.js";

const issuer = "https://remote.example.test";
const audience = "https://remote.example.test/mcp";
const ownerToken = "OWNER_AUTHENTICATION_TOKEN_1234567890";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("remote OAuth trust boundary", () => {
  let database: OperationalDatabase;
  let clients: ClientRegistry;
  let tokens: TokenValidator;
  let consent: OwnerConsentService;
  let provider: LocalOAuthProvider;

  beforeEach(() => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    clients = new ClientRegistry({ database });
    tokens = new TokenValidator({
      database,
      issuer,
      audience,
      signingKeys: [{ keyId: "key-1", secret: Buffer.alloc(32, 0x41) }]
    });
    consent = new OwnerConsentService({ database, clients, tokens, ownerToken });
    provider = new LocalOAuthProvider({ issuer, audience, consent, tokens });
  });

  test("requires PKCE, state, nonce, and authenticated owner consent for a new client", async () => {
    const verifier = randomBytes(48).toString("base64url");
    await expect(provider.beginAuthorization({
      issuer,
      subject: "chatgpt-user-1",
      oauthClientId: "chatgpt-web",
      displayName: "ChatGPT Web",
      redirectUri: "https://chatgpt.com/oauth/callback",
      state: "short",
      nonce: "short",
      codeChallenge: challenge(verifier),
      codeChallengeMethod: "S256",
      scope: "computer:*"
    })).rejects.toThrow(/state|nonce/i);

    const pending = await provider.beginAuthorization({
      issuer,
      subject: "chatgpt-user-1",
      oauthClientId: "chatgpt-web",
      displayName: "ChatGPT Web",
      redirectUri: "https://chatgpt.com/oauth/callback",
      state: "state-value-with-sufficient-entropy",
      nonce: "nonce-value-with-sufficient-entropy",
      codeChallenge: challenge(verifier),
      codeChallengeMethod: "S256",
      scope: "computer:*"
    });
    expect(clients.get(pending.clientKey)).toMatchObject({ status: "pending" });
    await expect(consent.approve(pending.requestId, "wrong-owner-token")).rejects.toThrow(/owner/i);

    const approved = await consent.approve(pending.requestId, ownerToken);
    expect(approved.redirectUri).toContain("code=");
    expect(approved.redirectUri).toContain("state=state-value-with-sufficient-entropy");
    expect(clients.get(pending.clientKey)).toMatchObject({ status: "trusted" });

    await expect(provider.exchangeCode({
      code: approved.code,
      codeVerifier: `${verifier}wrong`,
      redirectUri: "https://chatgpt.com/oauth/callback",
      oauthClientId: "chatgpt-web"
    })).rejects.toThrow(/PKCE/i);
    const issued = await provider.exchangeCode({
      code: approved.code,
      codeVerifier: verifier,
      redirectUri: "https://chatgpt.com/oauth/callback",
      oauthClientId: "chatgpt-web"
    });
    expect(tokens.validateAccessToken(issued.accessToken)).toMatchObject({
      issuer,
      audience,
      nonce: "nonce-value-with-sufficient-entropy",
      identity: { principalId: expect.any(String), clientId: expect.any(String) }
    });
    await expect(provider.exchangeCode({
      code: approved.code,
      codeVerifier: verifier,
      redirectUri: "https://chatgpt.com/oauth/callback",
      oauthClientId: "chatgpt-web"
    })).rejects.toThrow(/consumed|invalid/i);
  });

  test("rejects wrong issuer/audience, rotates refresh tokens, and preserves stable identity", async () => {
    const client = clients.registerPending({ issuer, subject: "subject-2", oauthClientId: "client-2", displayName: "Client 2" });
    clients.approve(client.clientKey);
    const first = tokens.issue(client, { nonce: "nonce-2", scope: "computer:*" });
    const identity = tokens.validateAccessToken(first.accessToken).identity;

    const wrongAudience = new TokenValidator({
      database,
      issuer,
      audience: "https://wrong.example/mcp",
      signingKeys: [{ keyId: "key-1", secret: Buffer.alloc(32, 0x41) }]
    });
    expect(() => wrongAudience.validateAccessToken(first.accessToken)).toThrow(/audience/i);

    const refreshed = tokens.refresh(first.refreshToken);
    expect(tokens.validateAccessToken(refreshed.accessToken).identity).toEqual(identity);
    expect(() => tokens.refresh(first.refreshToken)).toThrow(/revoked|invalid|replay/i);

    tokens.rotateSigningKey({ keyId: "key-2", secret: Buffer.alloc(32, 0x42) });
    expect(tokens.validateAccessToken(refreshed.accessToken).identity).toEqual(identity);
    const afterRotation = tokens.refresh(refreshed.refreshToken);
    expect(tokens.validateAccessToken(afterRotation.accessToken).identity).toEqual(identity);
  });

  test("revocation and disconnect take effect immediately without leaking token material", () => {
    const client = clients.registerPending({ issuer, subject: "subject-3", oauthClientId: "client-3", displayName: "Client 3" });
    clients.approve(client.clientKey);
    const issued = tokens.issue(client, { nonce: "nonce-3", scope: "computer:*" });

    tokens.revokeToken(issued.accessToken);
    expect(() => tokens.validateAccessToken(issued.accessToken)).toThrow(/revoked/i);
    const refreshed = tokens.refresh(issued.refreshToken);
    clients.disconnect(client.clientKey);
    tokens.revokeClient(client.clientKey);
    expect(() => tokens.validateAccessToken(refreshed.accessToken)).toThrow(/revoked|disconnect/i);

    const dump = database.read((connection) => JSON.stringify(connection.prepare(
      "SELECT token_hash, jti, client_key FROM oauth_tokens"
    ).all()));
    expect(dump).not.toContain(issued.accessToken);
    expect(dump).not.toContain(issued.refreshToken);
  });
});

import type { AuthorizationRequestInput, OwnerConsentService, PendingAuthorization } from "./owner-consent.js";
import type { IssuedTokens, TokenValidator, ValidatedAccessToken } from "./token-validator.js";

export interface OAuthProvider {
  metadata(): {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string;
  };
  beginAuthorization(input: AuthorizationRequestInput): Promise<PendingAuthorization>;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly oauthClientId: string;
  }): Promise<IssuedTokens>;
  refresh(refreshToken: string): Promise<IssuedTokens>;
  validate(accessToken: string): ValidatedAccessToken;
  revoke(token: string): void;
}

export class LocalOAuthProvider implements OAuthProvider {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #consent: OwnerConsentService;
  readonly #tokens: TokenValidator;

  public constructor(options: {
    readonly issuer: string;
    readonly audience: string;
    readonly consent: OwnerConsentService;
    readonly tokens: TokenValidator;
  }) {
    this.#issuer = new URL(options.issuer).origin;
    this.#audience = options.audience;
    this.#consent = options.consent;
    this.#tokens = options.tokens;
  }

  public metadata() {
    return {
      issuer: this.#issuer,
      authorizationEndpoint: new URL("/oauth/authorize", this.#issuer).href,
      tokenEndpoint: new URL("/oauth/token", this.#issuer).href,
      revocationEndpoint: new URL("/oauth/revoke", this.#issuer).href
    } as const;
  }

  public async beginAuthorization(input: AuthorizationRequestInput): Promise<PendingAuthorization> {
    if (new URL(input.issuer).origin !== this.#issuer) throw new Error("OAuth authorization issuer mismatch");
    return this.#consent.begin(input);
  }

  public async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly oauthClientId: string;
  }): Promise<IssuedTokens> {
    return this.#consent.exchangeCode(input);
  }

  public async refresh(refreshToken: string): Promise<IssuedTokens> {
    return this.#tokens.refresh(refreshToken);
  }

  public validate(accessToken: string): ValidatedAccessToken {
    const result = this.#tokens.validateAccessToken(accessToken);
    if (result.audience !== this.#audience) throw new Error("OAuth audience mismatch");
    return result;
  }

  public revoke(token: string): void {
    this.#tokens.revokeToken(token);
  }
}

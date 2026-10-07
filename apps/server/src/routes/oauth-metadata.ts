import type { Express } from "express";

import type { OAuthProvider } from "../auth/oauth-provider.js";

export function registerOAuthMetadataRoutes(
  app: Express,
  options: { readonly provider: OAuthProvider; readonly resource: string }
): void {
  const metadata = options.provider.metadata();
  app.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json({
      resource: options.resource,
      authorization_servers: [metadata.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["computer:*"]
    });
  });
  app.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.json({
      issuer: metadata.issuer,
      authorization_endpoint: metadata.authorizationEndpoint,
      token_endpoint: metadata.tokenEndpoint,
      revocation_endpoint: metadata.revocationEndpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["computer:*"]
    });
  });
}

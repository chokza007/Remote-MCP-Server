import type { Express, Request } from "express";

import type { ClientRegistry } from "../auth/client-registry.js";
import type { OAuthProvider } from "../auth/oauth-provider.js";
import type { OwnerConsentService } from "../auth/owner-consent.js";
import type { TokenValidator } from "../auth/token-validator.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]!);
}

const darkStyles = `
  :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070b11;color:#ecf2fa}
  *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#070b11;color:#ecf2fa}body{min-height:100vh;background:radial-gradient(circle at top,#182235,#090d14 58%);color:#ecf2fa}
  main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:32px;border:1px solid #2b3b52;border-radius:18px;background:#111823;box-shadow:0 24px 80px #0008}
  h1{margin-top:0;font-size:1.8rem}p,small{color:#aebed2;line-height:1.6}.card{padding:18px;margin:14px 0;border:1px solid #2b3b52;border-radius:12px;background:#151f2c}
  label{display:block;margin:14px 0 6px;font-weight:650}input,select,textarea{width:100%;padding:12px;border:1px solid #3b506d;border-radius:9px;background:#0c121c!important;color:#eaf2ff!important;-webkit-text-fill-color:#eaf2ff;caret-color:#88b7ff}input:-webkit-autofill{-webkit-box-shadow:0 0 0 1000px #0c121c inset!important}
  button{padding:11px 18px;margin:14px 8px 0 0;border:0;border-radius:9px;background:#4f8cff;color:#07101f;font-weight:750;cursor:pointer}.danger{background:#ff6b7a}.muted{background:#2b3b52;color:#dce7f5}
  code{word-break:break-all;color:#88b7ff}a{color:#88b7ff}.status{display:inline-block;padding:4px 9px;border-radius:999px;background:#173323;color:#72e6a0;font-weight:700}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${darkStyles}</style></head><body><main>${body}</main></body></html>`;
}

function bearer(request: Request): string | undefined {
  const header = request.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function registerDarkLandingRoute(app: Express, endpoint: string): void {
  app.get("/", (_request, response) => {
    response.status(200).type("html").send(page("Remote MCP Server", `
      <span class="status">ONLINE</span>
      <h1>Remote MCP Server</h1>
      <p>The project-agnostic MCP gateway is running. Connect an MCP client to <code>${escapeHtml(endpoint)}</code>.</p>
      <div class="card"><strong>Persistent Full Access</strong><p>Authorization remains active until the owner revokes it. Important operations are audited and secrets are redacted.</p></div>`));
  });
}

function requestString(request: Request, name: string): string {
  const value = request.query[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing OAuth parameter: ${name}`);
  return value;
}

export function registerOwnerConsoleRoutes(app: Express, options: {
  readonly provider: OAuthProvider;
  readonly consent: OwnerConsentService;
  readonly clients: ClientRegistry;
  readonly tokens: TokenValidator;
  readonly ownerToken: string;
  readonly issuer: string;
  readonly disconnect?: (clientKey: string) => void | Promise<void>;
}): void {
  app.get("/oauth/authorize", async (request, response) => {
    try {
      if (requestString(request, "response_type") !== "code") throw new Error("Only authorization code flow is supported");
      const pending = await options.provider.beginAuthorization({
        issuer: options.issuer,
        subject: requestString(request, "subject"),
        oauthClientId: requestString(request, "client_id"),
        displayName: typeof request.query.client_name === "string" ? request.query.client_name : "Remote AI client",
        redirectUri: requestString(request, "redirect_uri"),
        state: requestString(request, "state"),
        nonce: requestString(request, "nonce"),
        codeChallenge: requestString(request, "code_challenge"),
        codeChallengeMethod: requestString(request, "code_challenge_method") as "S256",
        scope: requestString(request, "scope")
      });
      response.status(200).type("html").send(page("Authorize Remote MCP", `
        <h1>Authorize this client</h1>
        <p>Grant persistent Full Access to <strong>${escapeHtml(pending.displayName)}</strong>. Access remains active until you revoke it.</p>
        <div class="card"><small>Scope</small><br><code>${escapeHtml(pending.scope)}</code><br><small>Redirect</small><br><code>${escapeHtml(pending.redirectUri)}</code></div>
        <form method="post" action="/oauth/authorize/decision">
          <input type="hidden" name="request_id" value="${escapeHtml(pending.requestId)}">
          <label for="owner_token">Owner authorization token</label>
          <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" required>
          <button name="decision" value="approve">Grant Full Access</button>
          <button class="muted" name="decision" value="deny">Deny</button>
        </form>`));
    } catch (error) {
      response.status(400).json({ error: "invalid_request", error_description: error instanceof Error ? error.message : "Invalid request" });
    }
  });

  app.post("/oauth/authorize/decision", async (request, response) => {
    try {
      const requestId = String(request.body.request_id ?? "");
      const ownerToken = String(request.body.owner_token ?? "");
      const redirect = request.body.decision === "deny"
        ? options.consent.deny(requestId, ownerToken)
        : (await options.consent.approve(requestId, ownerToken)).redirectUri;
      response.redirect(303, redirect);
    } catch (error) {
      response.status(403).type("html").send(page("Authorization failed", `<h1>Authorization failed</h1><p>${escapeHtml(error instanceof Error ? error.message : "Access denied")}</p>`));
    }
  });

  app.post("/oauth/token", async (request, response) => {
    try {
      const grantType = String(request.body.grant_type ?? "");
      const issued = grantType === "authorization_code"
        ? await options.provider.exchangeCode({
            code: String(request.body.code ?? ""),
            codeVerifier: String(request.body.code_verifier ?? ""),
            redirectUri: String(request.body.redirect_uri ?? ""),
            oauthClientId: String(request.body.client_id ?? "")
          })
        : grantType === "refresh_token"
          ? await options.provider.refresh(String(request.body.refresh_token ?? ""))
          : (() => { throw new Error("Unsupported OAuth grant type"); })();
      response.setHeader("cache-control", "no-store");
      response.setHeader("pragma", "no-cache");
      response.json({
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        token_type: issued.tokenType,
        expires_in: issued.expiresIn,
        scope: issued.scope
      });
    } catch (error) {
      response.status(400).json({ error: "invalid_grant", error_description: error instanceof Error ? error.message : "Token request failed" });
    }
  });

  app.post("/oauth/revoke", (request, response) => {
    try { options.provider.revoke(String(request.body.token ?? "")); } catch { }
    response.status(200).end();
  });

  app.get("/owner", (request, response) => {
    if (bearer(request) !== options.ownerToken) {
      response.status(401).setHeader("www-authenticate", "Bearer").type("html").send(page(
        "Owner authorization required",
        "<h1>Owner authorization required</h1><p>Open this console through an authenticated owner session. The owner token is never displayed on this page.</p>"
      ));
      return;
    }
    const cards = options.clients.list().map((client) => `
      <div class="card"><strong>${escapeHtml(client.displayName)}</strong><p>Status: ${escapeHtml(client.status)}<br>Client: <code>${escapeHtml(client.clientId)}</code></p>
      ${client.status === "trusted" ? `<form method="post" action="/owner/disconnect"><input type="hidden" name="client_key" value="${escapeHtml(client.clientKey)}"><label>Owner authorization token</label><input name="owner_token" type="password" autocomplete="current-password" required><button class="danger">Disconnect &amp; revoke</button></form>` : ""}</div>`).join("");
    response.type("html").send(page("Remote MCP Owner Console", `<h1>Trusted clients</h1><p>Persistent Full Access stays active until you revoke it here.</p>${cards || "<p>No clients registered.</p>"}`));
  });

  app.post("/owner/disconnect", async (request, response) => {
    if (String(request.body.owner_token ?? "") !== options.ownerToken) {
      response.status(403).end();
      return;
    }
    const clientKey = String(request.body.client_key ?? "");
    options.clients.disconnect(clientKey);
    options.tokens.revokeClient(clientKey);
    await options.disconnect?.(clientKey);
    response.status(200).type("html").send(page("Client disconnected", "<h1>Client disconnected</h1><p>New actions from this client are blocked immediately.</p>"));
  });
}

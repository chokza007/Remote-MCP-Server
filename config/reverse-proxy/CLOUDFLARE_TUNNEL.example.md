# Cloudflare Tunnel example

Keep Remote MCP bound to `127.0.0.1:7331`. TLS must terminate at Cloudflare and the public hostname must exactly match `REMOTE_MCP_PUBLIC_ORIGIN`.

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: C:\ProgramData\cloudflared\YOUR-TUNNEL-UUID.json

ingress:
  - hostname: remote-mcp.example.com
    service: http://127.0.0.1:7331
    originRequest:
      httpHostHeader: remote-mcp.example.com
  - service: http_status:404
```

The tunnel must send these headers to the local service:

- `X-Forwarded-Proto: https`
- `X-Forwarded-Host: remote-mcp.example.com`

Set `REMOTE_MCP_PUBLIC_ORIGIN=https://remote-mcp.example.com`. Never expose port 7331 directly to the LAN or Internet. Use Cloudflare Access in front of the owner console if available, but do not rewrite the OAuth callback parameters.

Verify after deployment:

```powershell
Invoke-RestMethod https://remote-mcp.example.com/.well-known/oauth-protected-resource
```

The returned `resource` and `authorization_servers` values must use the same HTTPS hostname. A request sent directly to the local port without trusted forwarded headers is intentionally rejected for OAuth and owner-console routes.

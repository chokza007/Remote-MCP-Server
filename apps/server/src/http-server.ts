import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";

import {
  createApprovalService,
  createAuditService,
  createEmergencyStopService,
  createGrantService,
  createPolicyEngine,
  createRedactor,
  type AuthenticatedIdentity,
  type SecretProtector,
  type TrustedGrant
} from "@remote-mcp/control-plane";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import { resolveServerConfig, type ServerConfig } from "./config.js";
import { identityFromRequest, sameStableIdentity } from "./context.js";
import { createMcpServer } from "./create-mcp-server.js";
import { ToolRegistry } from "./tool-registry.js";
import { registerAuthorizationTools } from "./tools/authorization.js";
import { registerHealthTool } from "./tools/health.js";
import { registerServerInfoTool } from "./tools/server-info.js";

export interface CreateHttpServerOptions extends Partial<ServerConfig> {
  readonly database: OperationalDatabase;
  readonly protector?: SecretProtector;
  readonly localDevelopmentToken?: string;
}

export interface HttpServerHandle {
  readonly url: URL;
  readonly deviceId: string;
  readonly localDevelopmentToken: string;
  grantPending(requestId: string, ownerId: string): TrustedGrant;
  clearEmergencyStop(ownerId: string): { readonly active: boolean };
  close(): Promise<void>;
}

interface SessionRecord {
  readonly identity: AuthenticatedIdentity;
  readonly transport: StreamableHTTPServerTransport;
}

function jsonRpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32600, message },
    id: null
  });
}

function tokenMatches(request: Request, expected: string): boolean {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const actual = Buffer.from(expected, "utf8");
  return presented.length === actual.length && timingSafeEqual(presented, actual);
}

export async function createHttpServer(options: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const config = resolveServerConfig(options);
  const localDevelopmentToken =
    options.localDevelopmentToken ?? randomBytes(32).toString("base64url");
  if (localDevelopmentToken.length < 32) {
    throw new Error("Local development token must contain at least 32 characters");
  }
  const grants = createGrantService({
    database: options.database,
    ...(options.protector === undefined ? {} : { protector: options.protector })
  });
  const approvals = createApprovalService({ database: options.database });
  const emergencyStop = createEmergencyStopService({ database: options.database });
  const policy = createPolicyEngine({ grants, approvals, emergencyStop });
  const audit = createAuditService({ database: options.database, redactor: createRedactor() });
  const registry = new ToolRegistry();
  registerAuthorizationTools(registry, { grants, emergencyStop });
  registerHealthTool(registry, options.database);
  registerServerInfoTool(registry, grants);

  const sessions = new Map<string, SessionRecord>();
  const app = createMcpExpressApp({ host: config.host });

  async function handle(request: Request, response: Response): Promise<void> {
    const sessionHeader = request.header("mcp-session-id");
    const existing = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (existing) {
      try {
        const requestIdentity = identityFromRequest(
          request,
          grants.serverIdentity().deviceId,
          sessionHeader!
        );
        if (!sameStableIdentity(existing.identity, requestIdentity)) {
          jsonRpcError(response, 401, "Session identity mismatch");
          return;
        }
        await existing.transport.handleRequest(request, response, request.body);
      } catch (error) {
        jsonRpcError(response, 401, error instanceof Error ? error.message : "Unauthenticated");
      }
      return;
    }

    if (sessionHeader) {
      jsonRpcError(response, 404, "Session not found");
      return;
    }
    if (request.method !== "POST" || !isInitializeRequest(request.body)) {
      jsonRpcError(response, 400, "A valid MCP initialization request is required");
      return;
    }
    if (sessions.size >= config.maxSessions) {
      jsonRpcError(response, 503, "Too many open sessions");
      return;
    }

    const sessionId = randomUUID();
    let identity: AuthenticatedIdentity;
    try {
      identity = identityFromRequest(request, grants.serverIdentity().deviceId, sessionId);
    } catch (error) {
      jsonRpcError(response, 401, error instanceof Error ? error.message : "Unauthenticated");
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      maxRequestBodySize: config.maxRequestBodyBytes,
      onsessionclosed: (closedId) => {
        sessions.delete(closedId);
      }
    });
    transport.onclose = () => sessions.delete(sessionId);
    sessions.set(sessionId, { identity, transport });
    try {
      await createMcpServer({ registry, identity, grants, policy, audit }).connect(
        transport as unknown as Transport
      );
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      sessions.delete(sessionId);
      await transport.close().catch(() => undefined);
      if (!response.headersSent) {
        jsonRpcError(response, 500, error instanceof Error ? error.message : "MCP initialization failed");
      }
    }
  }

  app.all(config.endpoint, (request, response, next) => {
    if (!tokenMatches(request, localDevelopmentToken)) {
      jsonRpcError(response, 401, "Unauthorized");
      return;
    }
    next();
  });
  app.all(config.endpoint, (request, response) => {
    void handle(request, response);
  });

  const listener = app.listen(config.port, config.host);
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const address = listener.address() as AddressInfo;
  const hostForUrl = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const url = new URL(`http://${hostForUrl}:${address.port}${config.endpoint}`);

  return {
    url,
    deviceId: grants.serverIdentity().deviceId,
    localDevelopmentToken,
    grantPending: (requestId, ownerId) =>
      grants.grant(requestId, { id: ownerId, kind: "local_owner" }),
    clearEmergencyStop: (ownerId) => {
      emergencyStop.clear({ id: ownerId, kind: "local_owner" });
      return { active: emergencyStop.isActive() };
    },
    close: async () => {
      await Promise.allSettled([...sessions.values()].map(({ transport }) => transport.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

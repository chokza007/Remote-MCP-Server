import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { urlencoded, type Request, type Response } from "express";

import { asClientId, asDeviceId, asPrincipalId, asSessionId } from "@remote-mcp/contracts";

import {
  createFilesystemAdapter,
  createEnvironmentService,
  createArchiveService,
  createBrowserService,
  createDownloadService,
  createDocumentService,
  createGitAdapter,
  createGuiService,
  createHttpService,
  createMediaService,
  createPortService,
  createProcessService,
  createProjectCheckpointHelper,
  createSearchService,
  createSystemDiscovery,
  createTerminalService,
  createWindowsServiceService,
  type EnvironmentService,
  type ArchiveService,
  type BrowserService,
  type DownloadService,
  type DocumentService,
  type FilesystemAdapter,
  type GitAdapter,
  type GuiService,
  type HttpService,
  type MediaService,
  type PortService,
  type ProcessService,
  type ProjectCheckpointHelper,
  type SearchService,
  type SystemDiscovery,
  type TerminalService,
  type WindowsServiceService
} from "@remote-mcp/adapters";
import {
  createApprovalService,
  createAuditService,
  createCredentialService,
  createEmergencyStopService,
  createGrantService,
  createPolicyEngine,
  createRedactor,
  createWindowsCredentialManager,
  type AuthenticatedIdentity,
  type CredentialService,
  type SecretProtector,
  type TrustedGrant
} from "@remote-mcp/control-plane";
import type { OperationalDatabase } from "@remote-mcp/persistence";
import {
  createEventBus,
  createArtifactService,
  createJobService,
  createLockService,
  createMcpNotifier,
  createNotificationService,
  createScheduleRunner,
  createScheduleService,
  createOperationalStateService,
  createRuntimeCheckpointService,
  createTransactionService,
  createWatchService,
  HealthService,
  SelfTestService,
  type EventBus,
  type ArtifactService,
  type JobService,
  type LockService,
  type NotificationService,
  type ScheduleRunner,
  type ScheduleService,
  type OperationalStateService,
  type RuntimeCheckpointService,
  type TransactionService,
  type WatchService
} from "@remote-mcp/runtime";

import { resolveServerConfig, type ServerConfig } from "./config.js";
import { ClientRegistry } from "./auth/client-registry.js";
import { LocalOAuthProvider, type OAuthProvider } from "./auth/oauth-provider.js";
import { OwnerConsentService } from "./auth/owner-consent.js";
import { TokenValidator, type OAuthSigningKey } from "./auth/token-validator.js";
import { createToolContext, identityFromRequest, sameStableIdentity } from "./context.js";
import { createMcpServer, inferTargets } from "./create-mcp-server.js";
import { ToolRegistry } from "./tool-registry.js";
import { registerAuthorizationTools } from "./tools/authorization.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerArchiveTools } from "./tools/archives.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerCredentialTools } from "./tools/credentials.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerGitTools } from "./tools/git.js";
import { registerGuiTools } from "./tools/gui.js";
import { createDefaultCapabilityRegistry, registerHealthTool } from "./tools/health.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerLockTools } from "./tools/locks.js";
import { registerMediaTools } from "./tools/media.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerProjectCheckpointTools } from "./tools/project-checkpoints.js";
import { registerScheduleTools } from "./tools/schedules.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSystemTools } from "./tools/system.js";
import { registerStateTools } from "./tools/state.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerWatchTools } from "./tools/watches.js";
import { registerServerInfoTool } from "./tools/server-info.js";
import { registerOAuthMetadataRoutes } from "./routes/oauth-metadata.js";
import { registerDarkLandingRoute, registerOwnerConsoleRoutes } from "./routes/owner-console.js";

export interface RemoteAuthOptions {
  readonly publicOrigin: string;
  readonly ownerToken: string;
  readonly signingKeys: readonly OAuthSigningKey[];
  readonly requireForwardedHttps?: boolean;
}

export interface CreateHttpServerOptions extends Partial<ServerConfig> {
  readonly database: OperationalDatabase;
  readonly protector?: SecretProtector;
  readonly localDevelopmentToken?: string;
  readonly filesystem?: FilesystemAdapter;
  readonly archives?: ArchiveService;
  readonly browser?: BrowserService;
  readonly browserProfileRoot?: string;
  readonly browserArtifactRoot?: string;
  readonly browserExecutablePath?: string;
  readonly http?: HttpService;
  readonly downloads?: DownloadService;
  readonly documents?: DocumentService;
  readonly documentHelperRoot?: string;
  readonly pythonExecutable?: string;
  readonly git?: GitAdapter;
  readonly gui?: GuiService;
  readonly guiModulePath?: string;
  readonly guiArtifactRoot?: string;
  readonly media?: MediaService;
  readonly search?: SearchService;
  readonly terminal?: TerminalService;
  readonly processes?: ProcessService;
  readonly services?: WindowsServiceService;
  readonly ports?: PortService;
  readonly discovery?: SystemDiscovery;
  readonly environment?: EnvironmentService;
  readonly jobs?: JobService;
  readonly locks?: LockService;
  readonly transactions?: TransactionService;
  readonly recoveryRoot?: string;
  readonly events?: EventBus;
  readonly watches?: WatchService;
  readonly schedules?: ScheduleService;
  readonly scheduleRunner?: ScheduleRunner;
  readonly notifications?: NotificationService;
  readonly schedulerPollMs?: number;
  readonly artifacts?: ArtifactService;
  readonly artifactStoreRoot?: string;
  readonly operationalState?: OperationalStateService;
  readonly runtimeCheckpoints?: RuntimeCheckpointService;
  readonly projectCheckpoints?: ProjectCheckpointHelper;
  readonly credentials?: CredentialService;
  readonly credentialModulePath?: string;
  readonly remoteAuth?: RemoteAuthOptions;
}

export interface HttpServerHandle {
  readonly url: URL;
  readonly deviceId: string;
  readonly localDevelopmentToken: string;
  readonly oauthIssuer?: string;
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

function bearerToken(request: Request): string | undefined {
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

function isLoopbackRequest(request: Request): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function assertTrustedProxyRequest(request: Request, remote: RemoteAuthOptions): void {
  if (remote.requireForwardedHttps === false) return;
  const expected = new URL(remote.publicOrigin);
  const forwardedProto = request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedProto !== "https") throw new Error("Remote OAuth requests require an HTTPS reverse proxy");
  const forwardedHost = request.header("x-forwarded-host")?.split(",", 1)[0]?.trim().toLowerCase();
  if (forwardedHost !== undefined && forwardedHost !== expected.host.toLowerCase()) {
    throw new Error("Forwarded host does not match the configured public origin");
  }
  const origin = request.header("origin");
  if (origin !== undefined && new URL(origin).origin !== expected.origin) {
    throw new Error("Request origin does not match the configured public origin");
  }
}

export async function createHttpServer(options: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const config = resolveServerConfig(options);
  if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost" && options.remoteAuth === undefined) {
    throw new Error("Non-loopback binding requires configured remote OAuth authentication");
  }
  if (options.remoteAuth !== undefined && new URL(options.remoteAuth.publicOrigin).protocol !== "https:") {
    throw new Error("Remote OAuth public origin must use HTTPS");
  }
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
  const redactor = createRedactor();
  const audit = createAuditService({ database: options.database, redactor });
  const registry = new ToolRegistry();
  let oauthProvider: OAuthProvider | undefined;
  let oauthClients: ClientRegistry | undefined;
  let oauthTokens: TokenValidator | undefined;
  let ownerConsent: OwnerConsentService | undefined;
  if (options.remoteAuth !== undefined) {
    const issuer = new URL(options.remoteAuth.publicOrigin).origin;
    oauthClients = new ClientRegistry({ database: options.database });
    oauthTokens = new TokenValidator({
      database: options.database,
      issuer,
      audience: new URL(config.endpoint, issuer).href,
      signingKeys: options.remoteAuth.signingKeys
    });
    ownerConsent = new OwnerConsentService({
      database: options.database,
      clients: oauthClients,
      tokens: oauthTokens,
      ownerToken: options.remoteAuth.ownerToken,
      onApproved: (client) => {
        const identity = {
          principalId: client.principalId,
          clientId: client.clientId,
          deviceId: asDeviceId(grants.serverIdentity().deviceId)
        };
        if (grants.resolve(identity).state !== "granted") {
          const request = grants.request({
            identity,
            mode: "full_access",
            scopes: ["computer:*"],
            requestedBy: `oauth:${client.clientKey}`
          });
          grants.grant(request.id, { id: "oauth-owner-consent", kind: "authenticated_owner" });
        }
      }
    });
    oauthProvider = new LocalOAuthProvider({
      issuer,
      audience: new URL(config.endpoint, issuer).href,
      consent: ownerConsent,
      tokens: oauthTokens
    });
  }
  const http = options.http ?? createHttpService();
  const filesystem = options.filesystem ?? createFilesystemAdapter();
  const documents = options.documents ?? createDocumentService({
    helperRoot: options.documentHelperRoot ?? resolve("helpers/python"),
    ...(options.pythonExecutable === undefined ? {} : { pythonExecutable: options.pythonExecutable })
  });
  const locks = options.locks ?? createLockService({ database: options.database });
  const browser = options.browser ?? createBrowserService({
    profileRoot: options.browserProfileRoot ?? resolve("var/browser/profiles"),
    artifactRoot: options.browserArtifactRoot ?? resolve("var/artifacts/browser"),
    ...(options.browserExecutablePath === undefined ? {} : { executablePath: options.browserExecutablePath }),
    lock: {
      acquire: async (key, ownerId) => {
        const lease = await locks.acquire({
          ownerId,
          resources: [resolve("var/browser/locks", key)],
          leaseMs: 86_400_000
        });
        const renewal = setInterval(() => {
          void locks.renew(lease.leaseId, ownerId, 86_400_000).catch(() => undefined);
        }, 12 * 60 * 60 * 1_000);
        renewal.unref();
        return async () => {
          clearInterval(renewal);
          await locks.release(lease.leaseId, ownerId);
        };
      }
    }
  });
  const gui = options.gui ?? createGuiService({
    modulePath: options.guiModulePath ?? resolve("helpers/powershell/RemoteMcp.UIAutomation.psm1"),
    artifactRoot: options.guiArtifactRoot ?? resolve("var/artifacts/screenshots")
  });
  const services = options.services ?? createWindowsServiceService();
  const discovery = options.discovery ?? createSystemDiscovery();
  const media = options.media ?? createMediaService();
  const transactions = options.transactions ?? createTransactionService({
    database: options.database,
    locks,
    recoveryRoot: options.recoveryRoot ?? resolve("var/recovery")
  });
  const jobs = options.jobs ?? createJobService({ database: options.database });
  const events = options.events ?? createEventBus({ database: options.database });
  const artifacts = options.artifacts ?? createArtifactService({
    database: options.database,
    storeRoot: options.artifactStoreRoot ?? resolve("var/artifacts")
  });
  const operationalState = options.operationalState ?? createOperationalStateService({ database: options.database });
  const runtimeCheckpoints = options.runtimeCheckpoints ?? createRuntimeCheckpointService({ database: options.database });
  const projectCheckpoints = options.projectCheckpoints ?? createProjectCheckpointHelper({ filesystem, artifacts });
  const credentials = options.credentials ?? createCredentialService({
    database: options.database,
    redactor,
    vault: createWindowsCredentialManager({
      modulePath: options.credentialModulePath ?? resolve("helpers/powershell/RemoteMcp.Credentials.psm1")
    }),
    authorizeUse: async (credential) => {
      const first = credential.namespace.indexOf("\0");
      const second = credential.namespace.indexOf("\0", first + 1);
      if (first < 1 || second <= first + 1) return false;
      return grants.resolve({
        principalId: asPrincipalId(credential.namespace.slice(0, first)),
        clientId: asClientId(credential.namespace.slice(first + 1, second)),
        deviceId: asDeviceId(grants.serverIdentity().deviceId)
      }).state === "granted";
    }
  });
  const watches = options.watches ?? createWatchService({
    database: options.database,
    eventBus: events,
    urlProbe: async (url) => {
      const response = await http.request({ url, maxResponseBytes: 1_048_576, timeoutMs: 10_000 });
      return { status: response.status, body: response.body };
    },
    jobState: async (jobId) => jobs.get(jobId).state,
    authorize: async (watch) => {
      if (!watch.grantId) return false;
      const separator = watch.ownerId.indexOf("\0");
      if (separator < 1) return false;
      const resolution = grants.resolve({
        principalId: asPrincipalId(watch.ownerId.slice(0, separator)),
        clientId: asClientId(watch.ownerId.slice(separator + 1)),
        deviceId: asDeviceId(grants.serverIdentity().deviceId)
      });
      return resolution.state === "granted" && resolution.grant.id === watch.grantId;
    }
  });
  const schedules = options.schedules ?? createScheduleService({ database: options.database });
  const notifications = options.notifications ?? createNotificationService({
    database: options.database,
    notifiers: { mcp: createMcpNotifier({ eventBus: events }) }
  });
  const scheduleRunner = options.scheduleRunner ?? createScheduleRunner({
    database: options.database,
    authorize: async (schedule) => {
      const separator = schedule.ownerId.indexOf("\0");
      if (separator < 1) return false;
      const resolution = grants.resolve({
        principalId: asPrincipalId(schedule.ownerId.slice(0, separator)),
        clientId: asClientId(schedule.ownerId.slice(separator + 1)),
        deviceId: asDeviceId(grants.serverIdentity().deviceId)
      });
      return resolution.state === "granted" && resolution.grant.id === schedule.grantId;
    },
    dispatch: async (schedule, scheduledFor) => {
      const separator = schedule.ownerId.indexOf("\0");
      if (separator < 1) throw new Error("Scheduled owner identity is invalid");
      const identity = {
        principalId: asPrincipalId(schedule.ownerId.slice(0, separator)),
        clientId: asClientId(schedule.ownerId.slice(separator + 1)),
        deviceId: asDeviceId(grants.serverIdentity().deviceId)
      };
      const tool = registry.entries().find((entry) => entry.descriptor.name === schedule.action.tool);
      if (!tool) throw new Error(`Scheduled tool is unavailable: ${schedule.action.tool}`);
      const context = createToolContext(identity);
      const targets = await inferTargets(schedule.action.arguments, tool.descriptor.name);
      const decision = await policy.authorize({
        identity,
        correlationId: context.correlationId,
        action: {
          name: tool.descriptor.name,
          version: tool.descriptor.version,
          riskTier: tool.descriptor.riskTier,
          requiredScope: tool.descriptor.requiredScope,
          mutates: tool.descriptor.riskTier > 0,
          actionClass: tool.descriptor.name
        },
        payload: schedule.action.arguments,
        targets,
        preview: null,
        recoveryPlan: null
      });
      if (decision.kind !== "allow" || decision.grantId !== schedule.grantId) {
        throw new Error(decision.kind === "deny" ? decision.reason : "Scheduled authorization requires interaction");
      }
      try {
        const output = await tool.handler(schedule.action.arguments, context);
        audit.record({
          correlationId: context.correlationId,
          principalId: identity.principalId,
          clientId: identity.clientId,
          grantId: decision.grantId,
          eventType: "schedule.completed",
          toolName: tool.descriptor.name,
          targets,
          result: { scheduledFor, scheduleId: schedule.scheduleId, output: tool.auditResult(output) }
        });
        return output;
      } catch (error) {
        audit.record({
          correlationId: context.correlationId,
          principalId: identity.principalId,
          clientId: identity.clientId,
          grantId: decision.grantId,
          eventType: "schedule.failed",
          toolName: tool.descriptor.name,
          targets,
          result: { scheduledFor, scheduleId: schedule.scheduleId, error: error instanceof Error ? error.message : String(error) }
        });
        throw error;
      }
    }
  });
  const capabilityRegistry = createDefaultCapabilityRegistry({
    databaseIntegrity: () => options.database.integrityCheck(),
    discovery,
    browser,
    gui,
    services
  });
  const health = new HealthService({ database: options.database, registry: capabilityRegistry });
  const selfTests = new SelfTestService({ database: options.database, jobs, registry: capabilityRegistry });
  registerAuthorizationTools(registry, { grants, emergencyStop });
  registerArtifactTools(registry, artifacts);
  registerArchiveTools(registry, options.archives ?? createArchiveService());
  registerBrowserTools(registry, browser);
  registerCredentialTools(registry, credentials);
  registerDocumentTools(registry, documents);
  registerFilesystemTools(registry, filesystem);
  registerGitTools(registry, options.git ?? createGitAdapter());
  registerGuiTools(registry, gui);
  registerHealthTool(registry, { health, selfTests, capabilities: capabilityRegistry });
  registerJobTools(registry, {
    jobs,
    grants
  });
  registerLockTools(registry, locks);
  registerMediaTools(registry, media);
  registerNotificationTools(registry, notifications);
  registerProjectCheckpointTools(registry, projectCheckpoints);
  registerNetworkTools(registry, {
    http,
    downloads: options.downloads ?? createDownloadService({
      http,
      database: options.database,
      authorizeResume: (namespace) => {
        const separator = namespace.indexOf("\0");
        if (separator < 1) return false;
        return grants.resolve({
          principalId: asPrincipalId(namespace.slice(0, separator)),
          clientId: asClientId(namespace.slice(separator + 1)),
          deviceId: asDeviceId(grants.serverIdentity().deviceId)
        }).state === "granted";
      }
    })
  });
  registerSearchTools(registry, options.search ?? createSearchService({ database: options.database }));
  registerStateTools(registry, operationalState, runtimeCheckpoints);
  registerScheduleTools(registry, { schedules, grants, runDue: () => scheduleRunner.runDue() });
  registerTerminalTools(
    registry,
    options.terminal ??
      createTerminalService({
        database: options.database,
        allowedShells: ["powershell", "cmd", "python", "node"],
        redactOutput: (value) => redactor.redact(value) as string
      })
  );
  registerTransactionTools(registry, transactions);
  registerWatchTools(registry, watches, grants, events);
  registerSystemTools(registry, {
    processes: options.processes ?? createProcessService(),
    services,
    ports: options.ports ?? createPortService(),
    discovery,
    environment: options.environment ?? createEnvironmentService()
  });
  registerServerInfoTool(registry, grants);
  await watches.start();
  let scheduleRunning = false;
  const schedulerTimer = setInterval(() => {
    if (scheduleRunning) return;
    scheduleRunning = true;
    void Promise.allSettled([scheduleRunner.runDue(), notifications.retryDue()])
      .finally(() => { scheduleRunning = false; });
  }, options.schedulerPollMs ?? 500);
  schedulerTimer.unref();

  const sessions = new Map<string, SessionRecord>();
  const app = createMcpExpressApp({ host: config.host });
  registerDarkLandingRoute(app, config.endpoint);

  if (options.remoteAuth !== undefined && oauthProvider && oauthClients && oauthTokens && ownerConsent) {
    const remote = options.remoteAuth;
    const rate = new Map<string, { count: number; resetAt: number }>();
    app.use(["/oauth", "/owner", "/.well-known"], (request, response, next) => {
      try {
        assertTrustedProxyRequest(request, remote);
        const key = request.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        const current = rate.get(key);
        const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
        window.count += 1;
        rate.set(key, window);
        if (window.count > 120) {
          response.status(429).setHeader("retry-after", "60").end();
          return;
        }
        next();
      } catch (error) {
        response.status(400).json({ error: "invalid_request", error_description: error instanceof Error ? error.message : "Rejected request" });
      }
    });
    app.use(["/oauth", "/owner"], urlencoded({ extended: false, limit: "32kb", parameterLimit: 64 }));
    registerOAuthMetadataRoutes(app, {
      provider: oauthProvider,
      resource: new URL(config.endpoint, remote.publicOrigin).href
    });
    registerOwnerConsoleRoutes(app, {
      provider: oauthProvider,
      consent: ownerConsent,
      clients: oauthClients,
      tokens: oauthTokens,
      ownerToken: remote.ownerToken,
      issuer: new URL(remote.publicOrigin).origin,
      disconnect: (clientKey) => {
        const client = oauthClients!.get(clientKey);
        for (const grant of grants.list()) {
          if (grant.clientId === client.clientId && grant.revokedAt === null) {
            grants.revoke(grant.id, { id: "owner-console", kind: "authenticated_owner" }, "OAuth client disconnected");
          }
        }
      }
    });
  }

  function authenticate(request: Request, sessionId: string): AuthenticatedIdentity {
    if (tokenMatches(request, localDevelopmentToken) && isLoopbackRequest(request) && request.header("x-forwarded-proto") === undefined) {
      return identityFromRequest(request, grants.serverIdentity().deviceId, sessionId);
    }
    if (options.remoteAuth === undefined || oauthProvider === undefined) throw new Error("Unauthorized");
    assertTrustedProxyRequest(request, options.remoteAuth);
    const token = bearerToken(request);
    if (!token) throw new Error("Missing bearer token");
    const validated = oauthProvider.validate(token);
    return {
      principalId: asPrincipalId(validated.identity.principalId),
      clientId: asClientId(validated.identity.clientId),
      deviceId: asDeviceId(grants.serverIdentity().deviceId),
      sessionId: asSessionId(sessionId)
    };
  }

  async function handle(request: Request, response: Response): Promise<void> {
    const sessionHeader = request.header("mcp-session-id");
    const existing = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (existing) {
      try {
        const requestIdentity = authenticate(request, sessionHeader!);
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
      identity = authenticate(request, sessionId);
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
    ...(options.remoteAuth === undefined ? {} : { oauthIssuer: new URL(options.remoteAuth.publicOrigin).origin }),
    grantPending: (requestId, ownerId) =>
      grants.grant(requestId, { id: ownerId, kind: "local_owner" }),
    clearEmergencyStop: (ownerId) => {
      emergencyStop.clear({ id: ownerId, kind: "local_owner" });
      return { active: emergencyStop.isActive() };
    },
    close: async () => {
      clearInterval(schedulerTimer);
      await watches.stop();
      await Promise.allSettled([...sessions.values()].map(({ transport }) => transport.close()));
      sessions.clear();
      await documents.close();
      await browser.dispose();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";

import { asClientId, asDeviceId, asPrincipalId } from "@remote-mcp/contracts";

import {
  createFilesystemAdapter,
  createEnvironmentService,
  createArchiveService,
  createDownloadService,
  createDocumentService,
  createGitAdapter,
  createHttpService,
  createMediaService,
  createPortService,
  createProcessService,
  createSearchService,
  createSystemDiscovery,
  createTerminalService,
  createWindowsServiceService,
  type EnvironmentService,
  type ArchiveService,
  type DownloadService,
  type DocumentService,
  type FilesystemAdapter,
  type GitAdapter,
  type HttpService,
  type MediaService,
  type PortService,
  type ProcessService,
  type SearchService,
  type SystemDiscovery,
  type TerminalService,
  type WindowsServiceService
} from "@remote-mcp/adapters";
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
import {
  createEventBus,
  createJobService,
  createLockService,
  createMcpNotifier,
  createNotificationService,
  createScheduleRunner,
  createScheduleService,
  createTransactionService,
  createWatchService,
  type EventBus,
  type JobService,
  type LockService,
  type NotificationService,
  type ScheduleRunner,
  type ScheduleService,
  type TransactionService,
  type WatchService
} from "@remote-mcp/runtime";

import { resolveServerConfig, type ServerConfig } from "./config.js";
import { createToolContext, identityFromRequest, sameStableIdentity } from "./context.js";
import { createMcpServer, inferTargets } from "./create-mcp-server.js";
import { ToolRegistry } from "./tool-registry.js";
import { registerAuthorizationTools } from "./tools/authorization.js";
import { registerArchiveTools } from "./tools/archives.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerGitTools } from "./tools/git.js";
import { registerHealthTool } from "./tools/health.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerLockTools } from "./tools/locks.js";
import { registerMediaTools } from "./tools/media.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerScheduleTools } from "./tools/schedules.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSystemTools } from "./tools/system.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerWatchTools } from "./tools/watches.js";
import { registerServerInfoTool } from "./tools/server-info.js";

export interface CreateHttpServerOptions extends Partial<ServerConfig> {
  readonly database: OperationalDatabase;
  readonly protector?: SecretProtector;
  readonly localDevelopmentToken?: string;
  readonly filesystem?: FilesystemAdapter;
  readonly archives?: ArchiveService;
  readonly http?: HttpService;
  readonly downloads?: DownloadService;
  readonly documents?: DocumentService;
  readonly documentHelperRoot?: string;
  readonly pythonExecutable?: string;
  readonly git?: GitAdapter;
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
  const redactor = createRedactor();
  const audit = createAuditService({ database: options.database, redactor });
  const registry = new ToolRegistry();
  const http = options.http ?? createHttpService();
  const documents = options.documents ?? createDocumentService({
    helperRoot: options.documentHelperRoot ?? resolve("helpers/python"),
    ...(options.pythonExecutable === undefined ? {} : { pythonExecutable: options.pythonExecutable })
  });
  const locks = options.locks ?? createLockService({ database: options.database });
  const transactions = options.transactions ?? createTransactionService({
    database: options.database,
    locks,
    recoveryRoot: options.recoveryRoot ?? resolve("var/recovery")
  });
  const jobs = options.jobs ?? createJobService({ database: options.database });
  const events = options.events ?? createEventBus({ database: options.database });
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
  registerAuthorizationTools(registry, { grants, emergencyStop });
  registerArchiveTools(registry, options.archives ?? createArchiveService());
  registerDocumentTools(registry, documents);
  registerFilesystemTools(registry, options.filesystem ?? createFilesystemAdapter());
  registerGitTools(registry, options.git ?? createGitAdapter());
  registerHealthTool(registry, options.database);
  registerJobTools(registry, {
    jobs,
    grants
  });
  registerLockTools(registry, locks);
  registerMediaTools(registry, options.media ?? createMediaService());
  registerNotificationTools(registry, notifications);
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
    services: options.services ?? createWindowsServiceService(),
    ports: options.ports ?? createPortService(),
    discovery: options.discovery ?? createSystemDiscovery(),
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
      clearInterval(schedulerTimer);
      await watches.stop();
      await Promise.allSettled([...sessions.values()].map(({ transport }) => transport.close()));
      sessions.clear();
      await documents.close();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

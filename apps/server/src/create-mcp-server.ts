import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { canonicalizeTarget, RemoteMcpError, toToolError, type CanonicalTarget } from "@remote-mcp/contracts";
import type {
  AuditService,
  AuthenticatedIdentity,
  GrantService,
  PolicyEngine
} from "@remote-mcp/control-plane";

import { createToolContext } from "./context.js";
import type { RegisteredGatewayTool, ToolRegistry } from "./tool-registry.js";

export interface McpServerDependencies {
  readonly registry: ToolRegistry;
  readonly identity: AuthenticatedIdentity;
  readonly grants: GrantService;
  readonly policy: PolicyEngine;
  readonly audit: AuditService;
}

function authorizationError(reason: string, tool: RegisteredGatewayTool): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "AUTHORIZATION_REQUIRED",
    message: `Authorization denied: ${reason}`,
    retryable: reason !== "EMERGENCY_STOP",
    suggestedAction: "Grant the required persistent access or clear the applicable security control.",
    target: tool.descriptor.name
  });
}

function sanitizedUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:access[-_]?token|api[-_]?key|key|password|secret|signature|sig|token)/iu.test(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString();
}

async function inferTargets(argumentsValue: Record<string, unknown>, toolName: string): Promise<readonly CanonicalTarget[]> {
  const inputs: Array<{ kind: "path" | "url" | "process" | "service" | "port" | "opaque"; value: string }> = [];
  for (const key of [
    "path", "source", "destination", "root", "archive", "startPath", "cwd",
    "input", "output", "outputDirectory"
  ] as const) {
    if (typeof argumentsValue[key] === "string") inputs.push({ kind: "path", value: argumentsValue[key] });
  }
  if (Array.isArray(argumentsValue.inputs)) {
    for (const value of argumentsValue.inputs) {
      if (typeof value === "string") inputs.push({ kind: "path", value });
    }
  }
  if (Array.isArray(argumentsValue.resources)) {
    for (const value of argumentsValue.resources) {
      if (typeof value === "string") inputs.push({ kind: "path", value });
    }
  }
  if (Array.isArray(argumentsValue.changes)) {
    for (const value of argumentsValue.changes) {
      if (typeof value === "object" && value !== null && typeof (value as { target?: unknown }).target === "string") {
        inputs.push({ kind: "path", value: (value as { target: string }).target });
      }
    }
  }
  if (typeof argumentsValue.url === "string") inputs.push({ kind: "url", value: sanitizedUrl(argumentsValue.url) });
  if (typeof argumentsValue.pid === "number") inputs.push({ kind: "process", value: String(argumentsValue.pid) });
  const identity = argumentsValue.identity as { pid?: unknown } | undefined;
  if (typeof identity?.pid === "number") inputs.push({ kind: "process", value: String(identity.pid) });
  if (toolName.startsWith("service_") && typeof argumentsValue.name === "string") {
    inputs.push({ kind: "service", value: argumentsValue.name });
  }
  if (typeof argumentsValue.port === "number") inputs.push({ kind: "port", value: String(argumentsValue.port) });
  if (typeof argumentsValue.jobId === "string") inputs.push({ kind: "opaque", value: argumentsValue.jobId });
  if (typeof argumentsValue.leaseId === "string") inputs.push({ kind: "opaque", value: argumentsValue.leaseId });
  if (typeof argumentsValue.transactionId === "string") inputs.push({ kind: "opaque", value: argumentsValue.transactionId });
  const targets = await Promise.all(inputs.map((input) => canonicalizeTarget(input)));
  return [...new Map(targets.map((target) => [target.identityKey, target])).values()];
}

export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const server = new McpServer({ name: "remote-mcp-server", version: "0.1.0" });

  for (const tool of dependencies.registry.entries()) {
    server.registerTool(
      tool.descriptor.name,
      {
        title: tool.descriptor.title,
        description: tool.descriptor.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.descriptor.riskTier === 0,
          destructiveHint: tool.descriptor.riskTier >= 2,
          openWorldHint: tool.openWorld
        },
        _meta: {
          "remote-mcp/schemaVersion": tool.descriptor.schemaVersion,
          "remote-mcp/toolVersion": tool.descriptor.version,
          "remote-mcp/riskTier": tool.descriptor.riskTier,
          "remote-mcp/requiredScope": tool.descriptor.requiredScope
        }
      },
      async (argumentsValue) => {
        const context = createToolContext(dependencies.identity);
        let targets: readonly CanonicalTarget[] = [];
        try {
          targets = await inferTargets(argumentsValue, tool.descriptor.name);
          if (!tool.public) {
            if (tool.bypassEmergencyStop) {
              const resolution = dependencies.grants.resolve(context.identity);
              if (resolution.state !== "granted") {
                throw authorizationError(resolution.reason.toUpperCase(), tool);
              }
            } else {
              const decision = await dependencies.policy.authorize({
                identity: context.identity,
                correlationId: context.correlationId,
                action: {
                  name: tool.descriptor.name,
                  version: tool.descriptor.version,
                  riskTier: tool.descriptor.riskTier,
                  requiredScope: tool.descriptor.requiredScope,
                  mutates: tool.descriptor.riskTier > 0,
                  actionClass: tool.descriptor.name
                },
                payload: argumentsValue,
                targets,
                preview: null,
                recoveryPlan: null
              });
              if (decision.kind !== "allow") {
                throw authorizationError(
                  decision.kind === "deny" ? decision.reason : "INTERACTIVE_APPROVAL_REQUIRED",
                  tool
                );
              }
            }
          }

          const output = await tool.handler(argumentsValue, context);
          dependencies.audit.record({
            correlationId: context.correlationId,
            principalId: context.identity.principalId,
            clientId: context.identity.clientId,
            ...(context.identity.sessionId === undefined
              ? {}
              : { sessionId: context.identity.sessionId }),
            eventType: "tool.completed",
            toolName: tool.descriptor.name,
            targets,
            result: tool.auditResult(output)
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output
          };
        } catch (error) {
          const envelope = toToolError(error, { target: tool.descriptor.name });
          dependencies.audit.record({
            correlationId: context.correlationId,
            principalId: context.identity.principalId,
            clientId: context.identity.clientId,
            ...(context.identity.sessionId === undefined
              ? {}
              : { sessionId: context.identity.sessionId }),
            eventType: "tool.failed",
            toolName: tool.descriptor.name,
            targets,
            result: envelope
          });
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
            structuredContent: { schemaVersion: 1, ok: false, error: envelope }
          };
        }
      }
    );
  }

  return server;
}

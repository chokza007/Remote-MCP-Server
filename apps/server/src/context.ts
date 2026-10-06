import { randomUUID } from "node:crypto";

import type { Request } from "express";

import {
  asClientId,
  asCorrelationId,
  asDeviceId,
  asPrincipalId,
  asSessionId,
  type CorrelationId
} from "@remote-mcp/contracts";
import type { AuthenticatedIdentity } from "@remote-mcp/control-plane";

export interface ToolExecutionContext {
  readonly identity: AuthenticatedIdentity;
  readonly correlationId: CorrelationId;
}

function singleHeader(request: Request, name: string): string {
  const value = request.header(name);
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required identity header: ${name}`);
  }
  return value;
}

export function identityFromRequest(
  request: Request,
  deviceId: string,
  sessionId: string
): AuthenticatedIdentity {
  return {
    principalId: asPrincipalId(singleHeader(request, "x-remote-mcp-principal")),
    clientId: asClientId(singleHeader(request, "x-remote-mcp-client")),
    deviceId: asDeviceId(deviceId),
    sessionId: asSessionId(sessionId)
  };
}

export function createToolContext(identity: AuthenticatedIdentity): ToolExecutionContext {
  return { identity, correlationId: asCorrelationId(randomUUID()) };
}

export function sameStableIdentity(
  left: AuthenticatedIdentity,
  right: AuthenticatedIdentity
): boolean {
  return left.principalId === right.principalId &&
    left.clientId === right.clientId &&
    left.deviceId === right.deviceId;
}

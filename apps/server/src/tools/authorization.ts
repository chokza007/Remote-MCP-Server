import { z } from "zod";

import type { EmergencyStopService, GrantService } from "@remote-mcp/control-plane";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface AuthorizationToolDependencies {
  readonly grants: GrantService;
  readonly emergencyStop: EmergencyStopService;
}

export function registerAuthorizationTools(
  registry: ToolRegistry,
  dependencies: AuthorizationToolDependencies
): void {
  const { grants, emergencyStop } = dependencies;

  registry.register(
    coreDescriptor("authorization_status", "Authorization status", "Reports authorization for this client.", 0),
    (_argumentsValue, context) => {
      const resolution = grants.resolve(context.identity);
      if (resolution.state === "restricted") {
        return { schemaVersion: 1, state: "restricted", reason: resolution.reason };
      }
      return {
        schemaVersion: 1,
        state: "granted",
        mode: resolution.grant.mode,
        source: "persistent_grant",
        grantId: resolution.grant.id,
        scopes: resolution.grant.scopes,
        expiresAt: resolution.grant.expiresAt
      };
    },
    { public: true }
  );

  registry.register(
    coreDescriptor("clear_emergency_stop", "Clear emergency stop", "Clears the global emergency stop.", 3),
    (_argumentsValue, context) => {
      emergencyStop.clear({ id: context.identity.principalId, kind: "authenticated_owner" });
      return { schemaVersion: 1, ...emergencyStop.status() };
    },
    { bypassEmergencyStop: true }
  );

  registry.register(
    coreDescriptor("emergency_stop", "Emergency stop", "Stops all new privileged actions immediately.", 3),
    (argumentsValue, context) => {
      emergencyStop.activate(
        { id: context.identity.principalId, kind: "authenticated_owner" },
        String(argumentsValue.reason)
      );
      return { schemaVersion: 1, ...emergencyStop.status() };
    },
    { inputSchema: { reason: z.string().min(1) } }
  );

  registry.register(
    coreDescriptor("list_trusted_clients", "List trusted clients", "Lists persistent trusted grants.", 0),
    () => ({ schemaVersion: 1, clients: grants.list() })
  );

  registry.register(
    coreDescriptor("request_full_access", "Request Full Access", "Creates a pending Full Access enrollment request.", 1),
    (argumentsValue, context) => {
      const request = grants.request({
        identity: context.identity,
        mode: "full_access",
        scopes: argumentsValue.scopes as string[],
        requestedBy: context.identity.principalId
      });
      return {
        schemaVersion: 1,
        status: request.status,
        requestId: request.id,
        mode: request.mode,
        scopes: request.scopes
      };
    },
    { inputSchema: { scopes: z.array(z.string().min(1)).min(1) }, public: true }
  );

  registry.register(
    coreDescriptor("revoke_full_access", "Revoke Full Access", "Revokes a persistent trusted grant.", 3),
    (argumentsValue, context) => {
      const grantId = String(argumentsValue.grantId);
      grants.revoke(
        grantId,
        { id: context.identity.principalId, kind: "authenticated_owner" },
        String(argumentsValue.reason)
      );
      return { schemaVersion: 1, status: "revoked", grantId };
    },
    { inputSchema: { grantId: z.string().min(1), reason: z.string().min(1) } }
  );
}

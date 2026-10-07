import { z } from "zod";

import type { CredentialMetadata, CredentialService } from "@remote-mcp/control-plane";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function namespace(context: ToolExecutionContext, workspaceId: string): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}\u0000${workspaceId}`;
}

function publicMetadata(value: CredentialMetadata): Record<string, unknown> {
  return {
    credentialId: value.credentialId,
    credentialType: value.credentialType,
    metadata: value.metadata,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

const workspaceId = z.string().min(1).max(512);
const credentialId = z.string().uuid();
const secret = z.string().min(1).max(64 * 1024);

export function registerCredentialTools(registry: ToolRegistry, credentials: CredentialService): void {
  registry.register(
    coreDescriptor("credential_create", "Create credential", "Stores secret material in Windows Credential Manager and returns only opaque metadata.", 2),
    async (args, context) => ({ schemaVersion: 1, credential: publicMetadata(await credentials.create({
      namespace: namespace(context, String(args.workspaceId)),
      credentialType: String(args.credentialType),
      secret: String(args.secret),
      ...(args.username === undefined ? {} : { username: String(args.username) }),
      ...(args.metadata === undefined ? {} : { metadata: args.metadata as Record<string, unknown> })
    })) }),
    {
      inputSchema: {
        workspaceId,
        credentialType: z.string().min(1).max(256),
        secret,
        username: z.string().max(1024).optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
      },
      auditResult: (output) => ({ schemaVersion: 1, credential: output.credential })
    }
  );

  registry.register(
    coreDescriptor("credential_update", "Update credential", "Replaces secret material in Windows Credential Manager without exposing it.", 2),
    async (args, context) => ({ schemaVersion: 1, credential: publicMetadata(await credentials.update(
      String(args.credentialId),
      namespace(context, String(args.workspaceId)),
      { secret: String(args.secret), ...(args.username === undefined ? {} : { username: String(args.username) }) }
    )) }),
    {
      inputSchema: { workspaceId, credentialId, secret, username: z.string().max(1024).optional() },
      auditResult: (output) => ({ schemaVersion: 1, credential: output.credential })
    }
  );

  registry.register(
    coreDescriptor("credential_list", "List credential metadata", "Lists owned credential references without reading secret material.", 0),
    (args, context) => ({
      schemaVersion: 1,
      credentials: credentials.listMetadata(namespace(context, String(args.workspaceId))).map(publicMetadata)
    }),
    { inputSchema: { workspaceId } }
  );

  registry.register(
    coreDescriptor("credential_validate", "Validate credential", "Checks that an owned vault credential is available without exporting its value.", 1),
    async (args, context) => ({ schemaVersion: 1, ...(await credentials.use(
      String(args.credentialId),
      namespace(context, String(args.workspaceId)),
      (credential) => ({ available: true, usernamePresent: credential.username !== undefined })
    )) }),
    { inputSchema: { workspaceId, credentialId } }
  );

  registry.register(
    coreDescriptor("credential_delete", "Delete credential", "Deletes owned secret material and tombstones its opaque reference.", 2),
    async (args, context) => ({ schemaVersion: 1, ...(await credentials.delete(
      String(args.credentialId), namespace(context, String(args.workspaceId))
    )) }),
    { inputSchema: { workspaceId, credentialId } }
  );
}

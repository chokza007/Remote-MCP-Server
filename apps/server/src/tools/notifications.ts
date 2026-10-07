import { z } from "zod";

import type { NotificationService } from "@remote-mcp/runtime";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

function owner(context: ToolExecutionContext): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}`;
}

export function registerNotificationTools(registry: ToolRegistry, notifications: NotificationService): void {
  registry.register(
    coreDescriptor("notification_send", "Send notification", "Queues and delivers a durable notification with retry state.", 1),
    async (args, context) => ({ schemaVersion: 1, notification: await notifications.send({
      ownerId: owner(context),
      kind: String(args.kind),
      payload: args.payload,
      ...(args.workspaceId === undefined ? {} : { workspaceId: String(args.workspaceId) })
    }) }),
    {
      inputSchema: {
        kind: z.enum(["mcp", "local"]),
        payload: z.unknown(),
        workspaceId: z.string().min(1).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("notification_inbox", "Read notification inbox", "Lists durable notifications owned by this client.", 0),
    (_args, context) => ({ schemaVersion: 1, notifications: notifications.inbox(owner(context)) })
  );

  registry.register(
    coreDescriptor("notification_acknowledge", "Acknowledge notification", "Acknowledges an owned durable notification.", 1),
    (args, context) => ({
      schemaVersion: 1,
      notification: notifications.acknowledge(String(args.notificationId), owner(context))
    }),
    { inputSchema: { notificationId: z.string().uuid() } }
  );

  registry.register(
    coreDescriptor("notification_retry_due", "Retry notifications", "Retries due pending notification deliveries.", 1),
    async (_args, context) => ({ schemaVersion: 1, ...(await notifications.retryDue(owner(context))) })
  );
}

import type { EventBus } from "../events/event-bus.js";
import type { NotificationRecord, Notifier } from "./notification-service.js";

export interface McpNotifierOptions {
  readonly eventBus: EventBus;
}

export class McpNotifier implements Notifier {
  public constructor(private readonly events: EventBus) {}

  public async deliver(notification: NotificationRecord): Promise<void> {
    this.events.publish({
      namespace: notification.ownerId,
      type: "notification",
      sourceType: "notification",
      sourceId: notification.notificationId,
      payload: notification.payload,
      dedupeKey: `notification:${notification.notificationId}`
    });
  }
}

export function createMcpNotifier(options: McpNotifierOptions): McpNotifier {
  return new McpNotifier(options.eventBus);
}

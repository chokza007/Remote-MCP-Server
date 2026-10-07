import type { NotificationRecord, Notifier } from "./notification-service.js";

export interface LocalNotifierOptions {
  readonly deliver: (notification: NotificationRecord) => void | Promise<void>;
}

export class LocalNotifier implements Notifier {
  public constructor(private readonly deliverCallback: LocalNotifierOptions["deliver"]) {}

  public async deliver(notification: NotificationRecord): Promise<void> {
    await this.deliverCallback(notification);
  }
}

export function createLocalNotifier(options: LocalNotifierOptions): LocalNotifier {
  return new LocalNotifier(options.deliver);
}

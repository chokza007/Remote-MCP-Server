import { randomUUID } from "node:crypto";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export type NotificationState = "pending" | "delivered" | "acknowledged" | "failed";

export interface NotificationRecord {
  readonly notificationId: string;
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly state: NotificationState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly acknowledgedAt: string | null;
}

export interface Notifier {
  deliver(notification: NotificationRecord): Promise<void>;
}

export interface SendNotificationInput {
  readonly ownerId: string;
  readonly workspaceId?: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface NotificationServiceOptions {
  readonly database: OperationalDatabase;
  readonly notifiers: Readonly<Record<string, Notifier>>;
  readonly now?: () => Date;
  readonly retryBaseMs?: number;
  readonly maxAttempts?: number;
}

interface NotificationRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly kind: string;
  readonly payload_json: string;
  readonly state: NotificationState;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly acknowledged_at: string | null;
  readonly owner_id: string;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly error: string | null;
}

function notification(row: NotificationRow): NotificationRecord {
  return {
    notificationId: row.id,
    ownerId: row.owner_id,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at
  };
}

function notFound(id: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "NOTIFICATION_NOT_FOUND",
    message: "The notification does not exist.",
    retryable: false,
    suggestedAction: "Refresh the owned notification inbox before retrying.",
    target: id
  });
}

export class NotificationService {
  private readonly database: OperationalDatabase;
  private readonly notifiers: Readonly<Record<string, Notifier>>;
  private readonly now: () => Date;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;

  public constructor(options: NotificationServiceOptions) {
    this.database = options.database;
    this.notifiers = options.notifiers;
    this.now = options.now ?? (() => new Date());
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 10;
  }

  public async send(input: SendNotificationInput): Promise<NotificationRecord> {
    if (input.ownerId.trim().length === 0 || input.kind.trim().length === 0) throw new Error("Notification owner and kind are required");
    const id = randomUUID();
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO notifications(
          id, workspace_id, kind, payload_json, state, created_at, owner_id, attempts, next_attempt_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?)`
      ).run(id, input.workspaceId ?? null, input.kind, JSON.stringify(input.payload), now, input.ownerId, now);
    });
    await this.attempt(id);
    return this.get(id);
  }

  public inbox(ownerId: string): readonly NotificationRecord[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM notifications WHERE owner_id = ? ORDER BY created_at, id").all(ownerId) as NotificationRow[])
        .map(notification)
    );
  }

  public acknowledge(notificationId: string, ownerId: string): NotificationRecord {
    this.owned(notificationId, ownerId);
    const now = this.now().toISOString();
    this.database.writeTransaction((connection) => {
      connection.prepare(
        "UPDATE notifications SET state = 'acknowledged', acknowledged_at = ? WHERE id = ?"
      ).run(now, notificationId);
    });
    return this.get(notificationId);
  }

  public async retryDue(ownerId?: string): Promise<{ readonly attempted: number; readonly delivered: number; readonly failed: number }> {
    const ids = this.database.read((connection) =>
      ((ownerId === undefined
        ? connection.prepare(
          "SELECT id FROM notifications WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id"
        ).all(this.now().toISOString())
        : connection.prepare(
          "SELECT id FROM notifications WHERE owner_id = ? AND state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id"
        ).all(ownerId, this.now().toISOString())) as Array<{ id: string }>).map((row) => row.id)
    );
    let delivered = 0;
    let failed = 0;
    for (const id of ids) {
      await this.attempt(id);
      if (this.get(id).state === "delivered") delivered += 1;
      else failed += 1;
    }
    return { attempted: ids.length, delivered, failed };
  }

  private get(id: string): NotificationRecord {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as NotificationRow | undefined
    );
    if (!row) throw notFound(id);
    return notification(row);
  }

  private owned(id: string, ownerId: string): NotificationRecord {
    const value = this.get(id);
    if (value.ownerId !== ownerId) throw notFound(id);
    return value;
  }

  private async attempt(id: string): Promise<void> {
    const current = this.get(id);
    if (current.state !== "pending") return;
    const notifier = this.notifiers[current.kind];
    const attempts = current.attempts + 1;
    const now = this.now();
    try {
      if (!notifier) throw new Error(`Notification capability is unavailable: ${current.kind}`);
      await notifier.deliver({ ...current, attempts });
      this.database.writeTransaction((connection) => {
        connection.prepare(
          `UPDATE notifications SET state = 'delivered', attempts = ?, next_attempt_at = NULL,
            error = NULL, delivered_at = ? WHERE id = ? AND state = 'pending'`
        ).run(attempts, now.toISOString(), id);
      });
    } catch (error) {
      const state: NotificationState = attempts >= this.maxAttempts ? "failed" : "pending";
      const delay = this.retryBaseMs * (2 ** Math.min(attempts - 1, 12));
      this.database.writeTransaction((connection) => {
        connection.prepare(
          "UPDATE notifications SET state = ?, attempts = ?, next_attempt_at = ?, error = ? WHERE id = ?"
        ).run(
          state,
          attempts,
          state === "pending" ? new Date(now.getTime() + delay).toISOString() : null,
          (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
          id
        );
      });
    }
  }
}

export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  return new NotificationService(options);
}

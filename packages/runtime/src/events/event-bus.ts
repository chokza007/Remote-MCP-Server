import type { OperationalDatabase } from "@remote-mcp/persistence";

import { EventRepository, type EventPage, type RuntimeEvent } from "./event-repository.js";

export interface PublishEventInput {
  readonly namespace: string;
  readonly type: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
}

export interface EventBusOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
}

export class EventBus {
  private readonly repository: EventRepository;
  private readonly now: () => Date;

  public constructor(options: EventBusOptions) {
    this.repository = new EventRepository(options.database);
    this.now = options.now ?? (() => new Date());
  }

  public publish(input: PublishEventInput): { readonly event: RuntimeEvent; readonly deduplicated: boolean } {
    return this.repository.append({ ...input, occurredAt: this.now().toISOString() });
  }

  public events(namespace: string, cursor = 0, limit = 100): EventPage {
    return this.repository.page(namespace, cursor, limit);
  }

  public watchEvents(watchId: string, cursor = 0, limit = 100): EventPage {
    return this.repository.watchPage(watchId, cursor, limit);
  }
}

export function createEventBus(options: EventBusOptions): EventBus {
  return new EventBus(options);
}

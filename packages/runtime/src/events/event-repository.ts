import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface RuntimeEvent {
  readonly namespace: string;
  readonly sequence: number;
  readonly type: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
  readonly occurredAt: string;
}

export interface EventPage {
  readonly items: readonly RuntimeEvent[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

interface EventRow {
  readonly namespace: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly payload_json: string;
  readonly dedupe_key: string | null;
  readonly occurred_at: string;
}

function asEvent(row: EventRow): RuntimeEvent {
  return {
    namespace: row.namespace,
    sequence: row.sequence,
    type: row.event_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    payload: JSON.parse(row.payload_json) as unknown,
    ...(row.dedupe_key === null ? {} : { dedupeKey: row.dedupe_key }),
    occurredAt: row.occurred_at
  };
}

export class EventRepository {
  public constructor(private readonly database: OperationalDatabase) {}

  public append(input: Omit<RuntimeEvent, "sequence">): { readonly event: RuntimeEvent; readonly deduplicated: boolean } {
    return this.database.writeTransaction((connection) => {
      if (input.dedupeKey !== undefined) {
        const existing = connection.prepare(
          "SELECT * FROM operational_events WHERE namespace = ? AND dedupe_key = ?"
        ).get(input.namespace, input.dedupeKey) as EventRow | undefined;
        if (existing) return { event: asEvent(existing), deduplicated: true };
      }
      const sequence = (connection.prepare(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM operational_events WHERE namespace = ?"
      ).get(input.namespace) as { sequence: number }).sequence;
      connection.prepare(
        `INSERT INTO operational_events(
          namespace, sequence, event_type, source_type, source_id, payload_json, dedupe_key, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.namespace,
        sequence,
        input.type,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.payload),
        input.dedupeKey ?? null,
        input.occurredAt
      );
      const event = { ...input, sequence } satisfies RuntimeEvent;
      if (input.sourceType === "watch") {
        const watchSequence = (connection.prepare(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM watch_events WHERE watch_id = ?"
        ).get(input.sourceId) as { sequence: number }).sequence;
        connection.prepare(
          "INSERT INTO watch_events(watch_id, sequence, event_json, occurred_at) VALUES (?, ?, ?, ?)"
        ).run(input.sourceId, watchSequence, JSON.stringify({ ...event, sequence: watchSequence }), input.occurredAt);
      }
      return { event, deduplicated: false };
    });
  }

  public page(namespace: string, cursor = 0, limit = 100): EventPage {
    this.validatePage(cursor, limit);
    const rows = this.database.read((connection) => connection.prepare(
      "SELECT * FROM operational_events WHERE namespace = ? AND sequence >= ? ORDER BY sequence LIMIT ?"
    ).all(namespace, cursor, limit + 1) as EventRow[]);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: visible.map(asEvent),
      nextCursor: visible.length === 0 ? cursor : visible[visible.length - 1]!.sequence + 1,
      hasMore
    };
  }

  public watchPage(watchId: string, cursor = 0, limit = 100): EventPage {
    this.validatePage(cursor, limit);
    const rows = this.database.read((connection) => connection.prepare(
      "SELECT sequence, event_json, occurred_at FROM watch_events WHERE watch_id = ? AND sequence >= ? ORDER BY sequence LIMIT ?"
    ).all(watchId, cursor, limit + 1) as Array<{ sequence: number; event_json: string; occurred_at: string }>);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const items = visible.map((row) => ({
      ...(JSON.parse(row.event_json) as RuntimeEvent),
      sequence: row.sequence,
      occurredAt: row.occurred_at
    }));
    return { items, nextCursor: items.length === 0 ? cursor : items[items.length - 1]!.sequence + 1, hasMore };
  }

  private validatePage(cursor: number, limit: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Event cursor must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Event limit must be from 1 through 1000");
  }
}

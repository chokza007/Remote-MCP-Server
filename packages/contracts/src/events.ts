import { asCorrelationId, type CorrelationId } from "./ids.js";

export interface OperationalEventInput<Payload = unknown> {
  readonly type: string;
  readonly sequence: number;
  readonly correlationId: string;
  readonly payload: Payload;
  readonly occurredAt: string;
}

export interface OperationalEventV1<Payload = unknown> {
  readonly schemaVersion: 1;
  readonly type: string;
  readonly sequence: number;
  readonly correlationId: CorrelationId;
  readonly payload: Payload;
  readonly occurredAt: string;
}

export function createOperationalEvent<Payload>(
  input: OperationalEventInput<Payload>
): OperationalEventV1<Payload> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("Event sequence must be a non-negative safe integer");
  }

  if (Number.isNaN(Date.parse(input.occurredAt))) {
    throw new Error("Event occurredAt must be an ISO-compatible timestamp");
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    type: input.type,
    sequence: input.sequence,
    correlationId: asCorrelationId(input.correlationId),
    payload: input.payload,
    occurredAt: input.occurredAt
  });
}

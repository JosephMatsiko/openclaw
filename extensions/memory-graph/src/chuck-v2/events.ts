import { createHash, randomUUID } from "node:crypto";
import type { ChuckEvent, ChuckEventType } from "./types.js";

export function createChuckEvent<TPayload>({
  type,
  payload,
  occurredAt = new Date().toISOString(),
  runId,
  parentEventId,
  previousEventHash,
  eventId = `evt-${randomUUID()}`,
}: {
  type: ChuckEventType;
  payload: TPayload;
  occurredAt?: string;
  runId?: string;
  parentEventId?: string;
  previousEventHash?: string;
  eventId?: string;
}): ChuckEvent<TPayload> {
  const unsigned = {
    eventId,
    type,
    occurredAt,
    runId,
    parentEventId,
    previousEventHash,
    payload,
  };
  return {
    ...unsigned,
    eventHash: hashEventUnsigned(unsigned),
  };
}

export function verifyChuckEvent(event: ChuckEvent): boolean {
  const { eventHash: _eventHash, ...unsigned } = event;
  return hashEventUnsigned(unsigned) === event.eventHash;
}

export function chainChuckEvents(
  events: Array<Omit<Parameters<typeof createChuckEvent>[0], "previousEventHash">>,
): ChuckEvent[] {
  const chained: ChuckEvent[] = [];
  for (const event of events) {
    chained.push(
      createChuckEvent({
        ...event,
        previousEventHash: chained.at(-1)?.eventHash,
      }),
    );
  }
  return chained;
}

export function appendChuckEventLine(event: ChuckEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function hashEventUnsigned(unsigned: {
  eventId: string;
  type: ChuckEventType;
  occurredAt: string;
  runId?: string;
  parentEventId?: string;
  previousEventHash?: string;
  payload: unknown;
}): string {
  return `sha256:${createHash("sha256").update(stableStringify(unsigned)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

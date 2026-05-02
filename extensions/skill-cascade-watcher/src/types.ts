// Public types for @openclaw/skill-cascade-watcher.

import type { Severity, Tier } from "../../skill-reach-cascade/api.js";

export interface BusEvent {
  id?: string;
  ts?: string;
  actor?: string;
  source?: string;
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Trigger {
  /** Regex matched against event.type. */
  typeMatch: RegExp;
  /** Optional predicate; only fires when true. */
  when?: (ev: BusEvent) => boolean;
  severity: Severity;
  tier: Tier;
  /** Build the cascade subject line from the matched event. */
  subjectFn: (ev: BusEvent) => string;
}

export interface MatchRecord {
  ts: string;
  triggerEventId?: string;
  triggerType: string;
  eventType: string;
  source: string;
  severity: Severity;
  tier: Tier;
  subject: string;
}

export interface FireRecord {
  ts: string;
  triggerEventId?: string;
  triggerType: string;
  eventType: string;
  subject: string;
  delivered: boolean;
  deliveredVia: string | null;
  ledgerEntryId: string | null;
  finalReason: string | null;
}

export interface SuppressionRecord {
  ts: string;
  triggerType: string;
  source: string;
  count: number;
  windowMs: number;
  triggerEventId?: string;
  triggerEventType?: string;
}

export interface PromotionRecord {
  ts: string;
  introspectId: string;
  eventId?: string;
  taskId: string;
  taskPath: string;
  riskClass: string;
  category: string;
}

export interface FloodCounters {
  [key: string]: { fires: number[] };
}

export interface WatcherState {
  startedAt: string | null;
  pid: number | null;
  matches: MatchRecord[];
  fires: FireRecord[];
  suppressions: SuppressionRecord[];
  promotions: PromotionRecord[];
  floodCounters: FloodCounters;
}

// Public types for @openclaw/skill-morning-digest.

export type DigestFormat = "markdown" | "banner" | "json" | "default";

export interface DigestWindow {
  startMs: number;
  startIso: string;
  endMs: number;
  endIso: string;
}

export interface DocketTaskRecord {
  id: string;
  title: string;
  status: string;
  awaiting: string | boolean | null;
  updatedAt: number | null;
  finishedAt: number | null;
  createdAt: number | null;
  raw: Record<string, unknown>;
}

export interface DecisionEvent {
  ts: string;
  type: string;
  source: string | null;
}

export interface DigestData {
  window: DigestWindow;
  shipped: DocketTaskRecord[];
  blockers: DocketTaskRecord[];
  decisions: DecisionEvent[];
  awaiting: DocketTaskRecord[];
}

export interface DigestSummary {
  ts: string;
  window: { startIso: string; endIso: string };
  counts: {
    shipped: number;
    blockers: number;
    decisions: number;
    awaiting: number;
  };
  shipped: Array<{ id: string; title: string }>;
  blockers: Array<{ id: string; status: string; title: string }>;
  decisions: DecisionEvent[];
  awaiting: Array<{ id: string; title: string }>;
}

export interface RunDigestOptions {
  /** Format to emit. "default" = markdown to stdout AND Telegram post. */
  format?: DigestFormat;
  /** When false, skip the Telegram post even on default format. */
  postToTelegram?: boolean;
  /** Pin the "now" instant for deterministic tests. */
  now?: Date;
}

export interface RunDigestResult {
  data: DigestData;
  markdown: string;
  banner: string;
  summary: DigestSummary;
  telegramPosted: boolean | null;
  receiptPath: string | null;
}

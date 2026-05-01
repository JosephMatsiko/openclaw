// Content-address helpers for prior-capsule + posterior-delta.
//
// Hash chain: each prior-capsule's id is sha256(parent_hash + content_hash + timestamp).
// Each posterior-delta's id is sha256(prior_hash + voice_id + content_hash + timestamp).
//
// Stable JSON serialization is required for reproducible content_hash —
// sort keys, no whitespace, ISO-8601 dates already strings, no Date objects.

import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableStringify(v)}`;
  });
  return `{${parts.join(",")}}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function priorCapsuleId(parts: {
  parent_hash: string | null;
  content: unknown;
  generated_at: string;
}): string {
  const payload = stableStringify({
    parent_hash: parts.parent_hash,
    content: parts.content,
    generated_at: parts.generated_at,
  });
  return sha256(payload);
}

export function posteriorDeltaId(parts: {
  prior_hash: string;
  voice_id: string;
  content: unknown;
  generated_at: string;
}): string {
  const payload = stableStringify({
    prior_hash: parts.prior_hash,
    voice_id: parts.voice_id,
    content: parts.content,
    generated_at: parts.generated_at,
  });
  return sha256(payload);
}

export function shortId(prefix: string, hexHash: string, len: number = 8): string {
  return `${prefix}_${hexHash.slice(0, len)}`;
}

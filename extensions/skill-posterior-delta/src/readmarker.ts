// Read-marker construction — only when prior was injected AND item completed.

import type {
  PosteriorDelta,
  PriorRecord,
  ReadMarker,
  RunnerExecutionItem,
  TaskRecord,
} from "./types.js";
import { compactTimestamp, sha256, stableStringify } from "./util.js";

export function buildReadMarker(input: {
  task: TaskRecord | null;
  prior: PriorRecord | null;
  item: RunnerExecutionItem;
  delta: PosteriorDelta;
}): ReadMarker | null {
  if (input.task?.priorCapsuleBefore?.injectedIntoPrompt !== true) return null;
  if (input.item.status !== "completed") return null;
  const receipt = input.item.receipt ?? {};
  const seenAt = receipt.startedAt ?? input.delta.createdAt;
  const seed = stableStringify({
    priorId: input.delta.priorId,
    deltaId: input.delta.deltaId,
    family: input.delta.producer.family,
    surface: input.delta.producer.surface,
    seenAt,
  });
  return {
    schemaVersion: "chuck.read-marker.v1",
    markerId: `read-${compactTimestamp(seenAt)}-${sha256(seed).slice(0, 12)}`,
    reader: {
      family: input.delta.producer.family,
      surface: input.delta.producer.surface,
      voice: input.delta.producer.voice,
    },
    priorId: input.delta.priorId,
    deltaIds: [input.delta.deltaId],
    seenAt,
    scope: input.task.priorCapsuleBefore.scope ?? "summary",
    result: input.item.countingEligible === true ? "accepted" : "needs-more-context",
    notes: `Prior ${input.prior?.priorId ?? input.delta.priorId} was injected into the executor prompt before dispatch.`,
  };
}

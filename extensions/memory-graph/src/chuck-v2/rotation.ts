import type { ChuckFamily } from "./types.js";

type KnownChuckFamily = Exclude<ChuckFamily, "unknown">;

export const FAMILY_ROTATION_ORDER: KnownChuckFamily[] = [
  "anthropic",
  "openai",
  "google",
  "perplexity",
  "sovereign-local",
  "xai",
];

function orderedIntersection(families: readonly ChuckFamily[]): ChuckFamily[] {
  const available = new Set<KnownChuckFamily>(
    families.filter((f): f is KnownChuckFamily => f !== "unknown"),
  );
  return FAMILY_ROTATION_ORDER.filter((f) => available.has(f));
}

export function chooseAdjudicatorFamily({
  validFamilies,
  previousFamily = null,
}: {
  validFamilies: readonly ChuckFamily[];
  previousFamily?: ChuckFamily | null;
}): ChuckFamily {
  const ordered = orderedIntersection(validFamilies);
  if (ordered.length === 0) {
    return "unknown";
  }
  if (!previousFamily) {
    return ordered[0];
  }
  const priorIdx =
    previousFamily === "unknown" ? -1 : FAMILY_ROTATION_ORDER.indexOf(previousFamily);
  for (let offset = 1; offset <= FAMILY_ROTATION_ORDER.length; offset += 1) {
    const candidate = FAMILY_ROTATION_ORDER[(priorIdx + offset) % FAMILY_ROTATION_ORDER.length];
    if (ordered.includes(candidate)) {
      return candidate;
    }
  }
  return ordered[0];
}

export function chooseRedTeamFamily({
  validFamilies,
  outlierFamily,
  previousRedTeamFamily = null,
}: {
  validFamilies: readonly ChuckFamily[];
  outlierFamily: ChuckFamily;
  previousRedTeamFamily?: ChuckFamily | null;
}): ChuckFamily {
  const candidates = orderedIntersection(validFamilies).filter((f) => f !== outlierFamily);
  if (candidates.length === 0) {
    return "unknown";
  }
  const rotated = chooseAdjudicatorFamily({
    validFamilies: candidates,
    previousFamily: previousRedTeamFamily ?? outlierFamily,
  });
  return rotated === "unknown" ? candidates[0] : rotated;
}

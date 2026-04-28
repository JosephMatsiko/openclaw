import type { ChuckFamily, FleetReviewRatification, FleetReviewRole } from "./types.js";

export type FleetReviewFamilyRole = {
  family: ChuckFamily;
  role: FleetReviewRole;
  present: boolean;
};

export function classifyFleetReviewRoles({
  configuredFamilies,
  reviewerFamilies,
  originatingFamily,
}: {
  configuredFamilies: ChuckFamily[];
  reviewerFamilies: ChuckFamily[];
  originatingFamily?: ChuckFamily;
}): FleetReviewFamilyRole[] {
  const reviewers = new Set(reviewerFamilies);
  return uniqueFamilies(configuredFamilies).map((family) => ({
    family,
    role: originatingFamily === family ? "originating-family-self-review" : "independent-review",
    present: reviewers.has(family),
  }));
}

export function evaluateFleetReviewRatification({
  configuredFamilies,
  reviewerFamilies,
  originatingFamily,
  minimumIndependentFamilies = 3,
}: {
  configuredFamilies: ChuckFamily[];
  reviewerFamilies: ChuckFamily[];
  originatingFamily?: ChuckFamily;
  minimumIndependentFamilies?: number;
}): FleetReviewRatification {
  const roles = classifyFleetReviewRoles({
    configuredFamilies,
    reviewerFamilies,
    originatingFamily,
  });
  const independentFamilies = roles
    .filter((entry) => entry.present && entry.role === "independent-review")
    .map((entry) => entry.family);
  const selfReviewFamilies = roles
    .filter((entry) => entry.present && entry.role === "originating-family-self-review")
    .map((entry) => entry.family);
  const missingFamilies = roles.filter((entry) => !entry.present).map((entry) => entry.family);
  const notes: string[] = [];

  if (originatingFamily !== undefined) {
    notes.push(
      `${originatingFamily} is originating-family self-review and cannot be decisive independent ratification`,
    );
    if (!selfReviewFamilies.includes(originatingFamily)) {
      notes.push(`${originatingFamily} self-review is missing from configured review completion`);
    }
  }
  if (independentFamilies.length < minimumIndependentFamilies) {
    notes.push(
      `only ${independentFamilies.length} independent families; ${minimumIndependentFamilies} required`,
    );
  }
  for (const family of missingFamilies) {
    notes.push(`${family} review missing`);
  }

  return {
    configuredFamilies: uniqueFamilies(configuredFamilies),
    reviewerFamilies: uniqueFamilies(reviewerFamilies),
    originatingFamily,
    independentFamilies,
    selfReviewFamilies,
    missingFamilies,
    configuredReviewComplete: missingFamilies.length === 0,
    canIndependentlyRatify: independentFamilies.length >= minimumIndependentFamilies,
    notes,
  };
}

function uniqueFamilies(families: ChuckFamily[]): ChuckFamily[] {
  return [...new Set(families)];
}

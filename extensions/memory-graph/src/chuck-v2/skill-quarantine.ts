export type SkillRisk = "low" | "medium" | "high";
export type SkillCapability =
  | "shell"
  | "network"
  | "credential"
  | "browser"
  | "filesystem-broad"
  | "persistence";

export type SkillQuarantineStep =
  | "unpack"
  | "metadata-parse"
  | "sbom-static-scan"
  | "declared-capability-review"
  | "network-off-dry-run"
  | "observed-behavior-diff"
  | "fleet-review"
  | "local-sign"
  | "enable";

const CAPABILITY_PATTERNS: Array<{ capability: SkillCapability; pattern: RegExp }> = [
  { capability: "shell", pattern: /\b(shell|bash|zsh|exec|spawn|child_process|osascript)\b/i },
  { capability: "network", pattern: /\b(network|fetch|curl|wget|http|websocket|socket)\b/i },
  {
    capability: "credential",
    pattern: /\b(api[_ -]?key|credential|password|token|ssh|keychain|wallet|private key)\b/i,
  },
  { capability: "browser", pattern: /\b(browser|chrome|cookies?|localStorage|sessionStorage)\b/i },
  { capability: "persistence", pattern: /\b(launchd|cron|daemon|plist|startup|persistence)\b/i },
  {
    capability: "filesystem-broad",
    pattern: /(home directory|~\/|\/Users\/|\/etc\/|\/var\/|\bfilesystem\b|\bfile system\b)/i,
  },
];

export type SkillQuarantineAssessment = {
  risk: SkillRisk;
  highRiskReasons: string[];
  declaredCapabilities: SkillCapability[];
  requiresSandboxDryRun: boolean;
  requiresFleetReview: boolean;
};

export type SkillQuarantinePlan = {
  risk: SkillRisk;
  requiredSteps: SkillQuarantineStep[];
  blockedUntil: SkillQuarantineStep[];
};

export function assessSkillManifest(manifestText: string): SkillQuarantineAssessment {
  const detected = CAPABILITY_PATTERNS.filter(({ pattern }) => pattern.test(manifestText));
  const highRiskReasons = detected.map(
    ({ capability, pattern }) => `${capability}:${String(pattern)}`,
  );
  const declaredCapabilities = [...new Set(detected.map(({ capability }) => capability))];
  const risk: SkillRisk =
    highRiskReasons.length >= 2 ? "high" : highRiskReasons.length === 1 ? "medium" : "low";
  return {
    risk,
    highRiskReasons,
    declaredCapabilities,
    requiresSandboxDryRun: true,
    requiresFleetReview: risk === "high",
  };
}

export function buildSkillQuarantinePlan(
  assessment: SkillQuarantineAssessment,
): SkillQuarantinePlan {
  const requiredSteps: SkillQuarantineStep[] = [
    "unpack",
    "metadata-parse",
    "sbom-static-scan",
    "declared-capability-review",
    "network-off-dry-run",
    "observed-behavior-diff",
  ];
  if (assessment.requiresFleetReview) {
    requiredSteps.push("fleet-review");
  }
  requiredSteps.push("local-sign", "enable");

  return {
    risk: assessment.risk,
    requiredSteps,
    blockedUntil: requiredSteps.filter((step) => step !== "enable"),
  };
}

export function canEnableSkill({
  assessment,
  completedSteps,
}: {
  assessment: SkillQuarantineAssessment;
  completedSteps: SkillQuarantineStep[];
}): {
  allowed: boolean;
  missingSteps: SkillQuarantineStep[];
} {
  const plan = buildSkillQuarantinePlan(assessment);
  const completed = new Set(completedSteps);
  const missingSteps = plan.blockedUntil.filter((step) => !completed.has(step));
  return {
    allowed: missingSteps.length === 0 && completed.has("local-sign"),
    missingSteps,
  };
}

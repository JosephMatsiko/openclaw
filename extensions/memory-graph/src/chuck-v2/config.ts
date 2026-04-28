import { homedir } from "node:os";
import { join } from "node:path";
import type { ChuckConfig, ChuckFamily, ChuckFleetEntry } from "./types.js";

export const CHUCK_V2_STATE_DIR = join(homedir(), ".openclaw", "workspace", "state", "chuck-v2");

export const GROK_CANDIDATE_FLEET_ENTRY: ChuckFleetEntry = {
  family: "xai",
  voice: "grok",
  surface: "grok/web-or-app",
  rationale:
    "Candidate sixth family; useful for X/Twitter-native real-time context, long-context reasoning, and tool/search posture. Optional until runner attribution is reliable and subscription/app access is confirmed.",
  capabilityProfile: "live-research",
  commercialPolicy: "subscription-only",
  quotaPolicy: "unknown",
  weightPolicy: "partial-vote",
};

export const DEFAULT_CHUCK_CONFIG: ChuckConfig = {
  version: 1,
  fleet: [
    {
      family: "anthropic",
      voice: "claude-cli",
      surface: "claude-cli/exec",
      rationale:
        "Claude Max subscription surface; no PAYG Anthropic API dependency in the core path.",
      capabilityProfile: "frontier-reasoning",
      commercialPolicy: "subscription-only",
      quotaPolicy: "normal",
      weightPolicy: "full-vote",
    },
    {
      family: "openai",
      voice: "chatgpt-web",
      surface: "chatgpt/web-chat",
      rationale:
        "ChatGPT Pro subscription surface; counted only when actual runner attribution remains OpenAI.",
      capabilityProfile: "frontier-reasoning",
      commercialPolicy: "subscription-only",
      quotaPolicy: "normal",
      weightPolicy: "full-vote",
    },
    {
      family: "google",
      voice: "gemini-cli",
      surface: "gemini/cli",
      rationale: "Google AI Plus subscription surface; useful but quota-sensitive.",
      capabilityProfile: "frontier-reasoning",
      commercialPolicy: "subscription-only",
      quotaPolicy: "scarce",
      weightPolicy: "full-vote",
    },
    {
      family: "perplexity",
      voice: "perplexity-mac",
      surface: "perplexity/mac-app",
      rationale:
        "Perplexity Max Mac app surface; strongest on source-grounded tasks and governed by its app protocol.",
      capabilityProfile: "meta-router",
      commercialPolicy: "subscription-only",
      quotaPolicy: "normal",
      weightPolicy: "partial-vote",
    },
    {
      family: "sovereign-local",
      voice: "ollama-local",
      surface: "ollama/localhost",
      rationale: "Local sovereignty floor; flag-not-vote on complex frontier reasoning.",
      capabilityProfile: "sovereign-local",
      commercialPolicy: "local-only",
      quotaPolicy: "local",
      weightPolicy: "flag-not-vote",
    },
    GROK_CANDIDATE_FLEET_ENTRY,
  ],
  thresholds: {
    minimumFamilies: 3,
    highRiskMinimumFamilies: 4,
    unanimousCorrectnessGate: 0.8,
    disagreementGate: 0.15,
    minorityFractureCount: 2,
  },
  stakePolicy: {
    destructiveRequiresApproval: true,
    vaultWritesRequireOperatorApproval: true,
  },
  evidencePolicy: {
    precedence: [
      "deterministic-verifier",
      "runtime-trace",
      "primary-doc",
      "live-source",
      "repo-fact",
      "model-reasoning",
      "vault-doctrine",
      "unsourced",
    ],
    vaultMayOverruleExternalTruth: false,
  },
  budgets: {
    defaultTimeoutMs: 5 * 60 * 1000,
    highRiskTimeoutMs: 20 * 60 * 1000,
    maxFleetCallsPerRun: 12,
    maxConcurrentFleetRuns: 1,
    lowFreeMemoryMb: 1_500,
  },
  intercept: {
    enabled: false,
    bypassTargetMs: 200,
  },
  sandbox: {
    skillNetworkDefault: "deny",
    skillFilesystemDefault: "ephemeral",
  },
  vaultPolicy: {
    writes: "operator-approved-proposals",
    scope: "doctrine-not-external-truth",
  },
  sovereigntyPolicy: {
    legitimateSurfaceDominanceRequired: true,
    unauthorizedBypassAllowed: false,
    stealthEvasionAllowed: false,
    internalReceiptsRequired: true,
    externalTraceMinimizationRequired: true,
    captureResistanceRequired: true,
  },
};

export function configWithCandidateGrok(config: ChuckConfig = DEFAULT_CHUCK_CONFIG): ChuckConfig {
  if (config.fleet.some((entry) => entry.family === "xai")) {
    return config;
  }
  return normalizeChuckConfig({
    ...config,
    fleet: [...config.fleet, GROK_CANDIDATE_FLEET_ENTRY],
  });
}

export function configWithSafeCliScoutSurfaces(
  config: ChuckConfig = DEFAULT_CHUCK_CONFIG,
): ChuckConfig {
  const hasSurface = (family: ChuckFamily, surface: string) =>
    config.fleet.some((entry) => entry.family === family && entry.surface === surface);
  const hasAllConfiguredMembers = [
    ["anthropic", "claude/web-chat"],
    ["anthropic", "claude/mac-app"],
    ["openai", "codex/exec"],
    ["openai", "codex-review/exec"],
    ["openai", "chatgpt/mac-app"],
    ["google", "gemini/web-chat"],
    ["google", "aistudio/web"],
  ].every(([family, surface]) => hasSurface(family as ChuckFamily, surface));
  if (hasAllConfiguredMembers) {
    return config;
  }
  const anthropicBase = config.fleet.find((entry) => entry.family === "anthropic");
  const openAiBase = config.fleet.find((entry) => entry.family === "openai");
  const googleBase = config.fleet.find((entry) => entry.family === "google");
  const anthropicDefaults = {
    family: "anthropic" as const,
    commercialPolicy: "subscription-only" as const,
    quotaPolicy: "normal" as const,
    weightPolicy: "full-vote" as const,
  };
  const openAiDefaults = {
    family: "openai" as const,
    commercialPolicy: "subscription-only" as const,
    quotaPolicy: "normal" as const,
    weightPolicy: "full-vote" as const,
  };
  const googleDefaults = {
    family: "google" as const,
    commercialPolicy: "subscription-only" as const,
    quotaPolicy: "scarce" as const,
    weightPolicy: "full-vote" as const,
  };
  const memberSurfaces: ChuckFleetEntry[] = [
    {
      ...(anthropicBase ?? anthropicDefaults),
      voice: "claude-ai",
      surface: "claude/web-chat",
      rationale:
        "Claude web subscription surface; same Anthropic family signal for browser-specific behavior and session divergence.",
      capabilityProfile: "frontier-reasoning",
    },
    {
      ...(anthropicBase ?? anthropicDefaults),
      voice: "claude-mac",
      surface: "claude/mac-app",
      rationale:
        "Claude Mac app surface; same Anthropic family signal and native-app fallback when web/CLI surfaces diverge.",
      capabilityProfile: "frontier-reasoning",
    },
    {
      ...(openAiBase ?? openAiDefaults),
      voice: "codex",
      surface: "codex/exec",
      rationale:
        "Codex CLI safe scout surface for repo-grounded OpenAI signal; intra-family only and never an additional independent family vote.",
      capabilityProfile: "code-grounded",
    },
    {
      ...(openAiBase ?? openAiDefaults),
      voice: "codex-review",
      surface: "codex-review/exec",
      rationale:
        "Codex review-mode CLI surface; same OpenAI family signal for critique and code-review framing.",
      capabilityProfile: "code-grounded",
    },
    {
      ...(openAiBase ?? openAiDefaults),
      voice: "chatgpt-mac",
      surface: "chatgpt/mac-app",
      rationale:
        "ChatGPT Mac app surface; same OpenAI family signal and native-app fallback when web/Codex surfaces diverge.",
      capabilityProfile: "frontier-reasoning",
    },
    {
      ...(googleBase ?? googleDefaults),
      voice: "gemini-web",
      surface: "gemini/web-chat",
      rationale:
        "Gemini browser/PWA subscription surface; same Google family signal used when CLI quota/session diverges from consumer Pro access.",
      capabilityProfile: "frontier-reasoning",
    },
    {
      ...(googleBase ?? googleDefaults),
      voice: "gemini-studio",
      surface: "aistudio/web",
      rationale:
        "Google AI Studio Run-button surface; same Google family signal for developer-studio behavior and quota divergence, never an additional independent family vote.",
      capabilityProfile: "frontier-reasoning",
    },
  ];
  return normalizeChuckConfig({
    ...config,
    fleet: [
      ...config.fleet,
      ...memberSurfaces.filter((entry) => !hasSurface(entry.family, entry.surface)),
    ],
  });
}

export type FleetValidationResult = {
  ok: boolean;
  repeatedFamilies: ChuckFamily[];
  duplicateFamilySurfaces: string[];
  missingRationale: string[];
  missingSurface: string[];
  invalidCommercialPolicy: string[];
};

export function validateFleet(fleet: readonly ChuckFleetEntry[]): FleetValidationResult {
  const seenFamilies = new Set<ChuckFamily>();
  const seenFamilySurfaces = new Set<string>();
  const repeatedFamilies: ChuckFamily[] = [];
  const duplicateFamilySurfaces: string[] = [];
  const missingRationale: string[] = [];
  const missingSurface: string[] = [];
  const invalidCommercialPolicy: string[] = [];
  for (const entry of fleet) {
    if (seenFamilies.has(entry.family) && !repeatedFamilies.includes(entry.family)) {
      repeatedFamilies.push(entry.family);
    }
    seenFamilies.add(entry.family);
    const surface = entry.surface.trim();
    if (!surface) {
      missingSurface.push(entry.voice);
    }
    const familySurface = `${entry.family}:${surface}`;
    if (seenFamilySurfaces.has(familySurface) && !duplicateFamilySurfaces.includes(familySurface)) {
      duplicateFamilySurfaces.push(familySurface);
    }
    seenFamilySurfaces.add(familySurface);
    if (!entry.rationale.trim()) {
      missingRationale.push(entry.voice);
    }
    if (
      entry.family !== "sovereign-local" &&
      entry.commercialPolicy !== "subscription-only" &&
      entry.commercialPolicy !== "operator-approved-exception"
    ) {
      invalidCommercialPolicy.push(`${entry.family}:${entry.surface}`);
    }
  }
  return {
    ok:
      duplicateFamilySurfaces.length === 0 &&
      missingRationale.length === 0 &&
      missingSurface.length === 0 &&
      invalidCommercialPolicy.length === 0,
    repeatedFamilies,
    duplicateFamilySurfaces,
    missingRationale,
    missingSurface,
    invalidCommercialPolicy,
  };
}

export function normalizeChuckConfig(config: Partial<ChuckConfig> = {}): ChuckConfig {
  return {
    ...DEFAULT_CHUCK_CONFIG,
    ...config,
    fleet: config.fleet ?? DEFAULT_CHUCK_CONFIG.fleet,
    thresholds: {
      ...DEFAULT_CHUCK_CONFIG.thresholds,
      ...config.thresholds,
    },
    stakePolicy: {
      ...DEFAULT_CHUCK_CONFIG.stakePolicy,
      ...config.stakePolicy,
    },
    evidencePolicy: {
      ...DEFAULT_CHUCK_CONFIG.evidencePolicy,
      ...config.evidencePolicy,
      vaultMayOverruleExternalTruth: false,
    },
    budgets: {
      ...DEFAULT_CHUCK_CONFIG.budgets,
      ...config.budgets,
    },
    intercept: {
      ...DEFAULT_CHUCK_CONFIG.intercept,
      ...config.intercept,
    },
    sandbox: {
      ...DEFAULT_CHUCK_CONFIG.sandbox,
      ...config.sandbox,
    },
    vaultPolicy: {
      ...DEFAULT_CHUCK_CONFIG.vaultPolicy,
      ...config.vaultPolicy,
      writes: "operator-approved-proposals",
      scope: "doctrine-not-external-truth",
    },
    sovereigntyPolicy: {
      ...DEFAULT_CHUCK_CONFIG.sovereigntyPolicy,
      ...config.sovereigntyPolicy,
      legitimateSurfaceDominanceRequired: true,
      unauthorizedBypassAllowed: false,
      stealthEvasionAllowed: false,
      internalReceiptsRequired: true,
      externalTraceMinimizationRequired: true,
      captureResistanceRequired: true,
    },
  };
}

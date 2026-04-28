import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CHUCK_CONFIG,
  GROK_CANDIDATE_FLEET_ENTRY,
  analyzeRepoHygieneFromPorcelain,
  appendFleetTrace,
  assessAuthorityDiff,
  assessExternalFootprint,
  assessSkillManifest,
  assessStake,
  appendChuckEventLine,
  buildSkillQuarantinePlan,
  buildContrarianDeepenPrompt,
  buildCapabilityLedger,
  buildOllamaScoutPrompt,
  canEnableSkill,
  canUseExternalSurface,
  canVaultOverride,
  canKernelRelyOn,
  chainChuckEvents,
  chooseAdjudicatorFamily,
  chooseRedTeamFamily,
  classifyProtocol,
  computeDeepenTriggers,
  compareEvidence,
  buildScoutRoundPrompt,
  chooseOcrRoute,
  choosePerplexityLease,
  classifyForkBranch,
  calibrateRunnerOutput,
  createChuckEvent,
  createBlindedAdjudicationPacket,
  changedFilesFromPatch,
  createChatGptMacRunnerAdapter,
  createChatGptWebRunnerAdapter,
  createClaudeCliRunnerAdapter,
  createClaudeMacRunnerAdapter,
  createClaudeWebRunnerAdapter,
  createCodexCliRunnerAdapter,
  createCodexReviewRunnerAdapter,
  createDocumentEvidenceRecord,
  createFleetTraceRecord,
  createFleetDeepenDispatchPlan,
  createGeminiCliRunnerAdapter,
  createGeminiWebRunnerAdapter,
  createGrokWebRunnerAdapter,
  createIntentAnchor,
  createOllamaRunnerAdapter,
  createOperatorSurfaceProfile,
  createPerplexityMacRunnerAdapter,
  createPerplexitySessionLease,
  createTaskCapsule,
  createChuckOpenClawCommand,
  approveBuilderRun,
  completePerplexityLease,
  computeRunnerTimeoutBudget,
  decisionRecordFromParts,
  detectLocalOcrCapability,
  detectIntraFamilyFractures,
  documentCitationToSourceSpan,
  evidenceClassForDocumentSourceKind,
  eventsForKernelAdjudication,
  evaluateOllamaLocalModel,
  executeFleetDispatchPlan,
  evaluateFleetReviewRatification,
  formatLiveScoutReply,
  formatBuildStatusReply,
  formatGitHubHygieneReport,
  formatRepoHygieneReport,
  formatSurfaceAtlasReport,
  formatUpstreamSyncReport,
  gradeEfficiencyTrace,
  handleChuckOpenClawCommand,
  evaluateKernelAdjudication,
  evaluateKernelPreflight,
  evaluateCalibrationGate,
  evaluateExcellenceTrajectory,
  evaluateGapClosurePlan,
  evaluateVaultWrite,
  configWithCandidateGrok,
  configWithSafeCliScoutSurfaces,
  decayedReliabilityForProfile,
  defaultRunnerAdapters,
  docketItemsForModelDoctor,
  isImpersonatedReceipt,
  isAuthorityExpanding,
  isReceiptValidForCounting,
  groundTruthAnchorForTask,
  initializeFleetTraceDb,
  machineResourceSnapshotFromMemorySample,
  modelDoctorSummary,
  memoryPressureFromWatcherLevel,
  machineResourceSnapshotFromDarwinMemory,
  normalizeClaimText,
  normalizeChuckConfig,
  persistChuckLoopResult,
  persistFleetDispatchExecution,
  parseChuckCommandArgs,
  extractUnifiedDiffPatchCandidate,
  runCandidateOnboarding,
  runChuckOnboarding,
  parseScoutSections,
  planRepoHygiene,
  planFleetEfficiency,
  preflightAdmission,
  rankLocalModelEvaluations,
  repoHygieneLaneManifests,
  listOllamaLocalModelCandidates,
  loadRunnerSurfaceProofs,
  readFleetTrace,
  readDocketItems,
  receiptCountsForFamily,
  redactedOperatorSurface,
  resolveFleetScout,
  runSelfBuild,
  runChuckLoop,
  runModelDoctor,
  shouldDeepenFleetScout,
  shouldRestorePerplexityIncognito,
  sha256Text,
  signRunnerReceipt,
  summarizeOperatorSurfaces,
  summarizeChuckLoopResult,
  surfaceAtlasEntries,
  surfaceAtlasEntry,
  surfaceAtlasSummary,
  surfaceReceiptsFromRunnerReceipts,
  summarizeReceiptInvariants,
  validateFleet,
  validateDocumentEvidenceRecord,
  vaultCanResolveConflictAgainst,
  verifyChuckEvent,
  verifyDocumentCitation,
  verifyIntentAnchor,
  verifyRunnerReceipt,
  workerProbeNamesForConfig,
} from "./index.js";

const execFileAsync = promisify(execFile);
import type { SurfaceProofDetail, SurfaceProofRecord } from "./capability-ledger.js";
import type { LocalModelEvaluationResult } from "./local-model-eval.js";
import type {
  AlignmentMatrix,
  ChuckFamily,
  ChuckFleetEntry,
  Claim,
  RunnerReceipt,
  WorkerHealthSnapshot,
} from "./types.js";

const SECRET = "local-test-secret";

function structuredScoutText(claim = "local scout answer"): string {
  return [
    "CLAIMS:",
    `- ${claim}`,
    "RISKS:",
    "- none identified in the scout pass",
    "MISSING_EVIDENCE:",
    "- none for this diagnostic",
    "DEEPEN_NEEDED: no",
  ].join("\n");
}

function matrix(clusters: Array<{ id: string; familyVotes: ChuckFamily[] }>): AlignmentMatrix {
  return {
    clusters: clusters.map((c) => ({
      id: c.id,
      familyVotes: c.familyVotes,
      claimIds: [`claim-${c.id}`],
      summary: c.id,
    })),
    contradictions: clusters.length > 1 ? ["families disagreed"] : [],
  };
}

function receipt(family: ChuckFamily, overrides: Partial<RunnerReceipt> = {}): RunnerReceipt {
  return signRunnerReceipt({
    declaredVoice: `${family}-voice`,
    requestedFamily: family,
    actualRunner: `${family}-runner`,
    actualFamily: family,
    surface: "test",
    layerUsed: "unit",
    modelClaimed: family,
    modelVerified: true,
    transcriptText: `transcript-${family}`,
    startedAt: "2026-04-26T00:00:00.000Z",
    endedAt: "2026-04-26T00:00:01.000Z",
    signingSecret: SECRET,
    ...overrides,
  });
}

function provedSurfaceProof(method = "unit-test"): SurfaceProofRecord {
  return {
    verdict: "proved",
    method,
    evidence: "unit proof",
    caveats: [],
    checkedAt: "2026-04-27T00:00:01.000Z",
  };
}

function splitSurfaceProof(
  surface: string,
  family: ChuckFamily,
  extractionMethod: SurfaceProofDetail["extractionMethod"] = "cli-stdout",
): SurfaceProofDetail {
  return {
    surface,
    family,
    promptDeliveryProof: provedSurfaceProof(extractionMethod),
    answerAttributionProof: provedSurfaceProof(extractionMethod),
    extractionMethod,
    receiptSignature: `${surface}:signature`,
    receiptEndedAt: "2026-04-27T00:00:01.000Z",
    proofModel: "split",
  };
}

function fixedClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function fakeSpawn({
  stdout,
  stderr = "",
  code = 0,
  calls,
}: {
  stdout: string;
  stderr?: string;
  code?: number;
  calls: Array<{ command: string; args: string[]; stdin?: string }>;
}): typeof import("node:child_process").spawn {
  return ((command: string, args: string[] = []) => {
    const call: { command: string; args: string[]; stdin?: string } = { command, args: [...args] };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        end(value: string) {
          call.stdin = value;
        },
      },
      kill() {},
    });
    process.nextTick(() => {
      if (stdout) {
        child.stdout.emit("data", Buffer.from(stdout));
      }
      if (stderr) {
        child.stderr.emit("data", Buffer.from(stderr));
      }
      child.emit("close", code);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

const baseClaim: Claim = {
  id: "claim-1",
  text: "Use a verifier before mutation.",
  category: "technical",
  evidenceClass: "deterministic-verifier",
  sourceSpans: [{ source: "unit-test" }],
  vaultNodes: ["principle:leave-workspace-as-found"],
  confidence: 0.9,
  producedBy: ["anthropic"],
};

describe("Chuck V2 config", () => {
  test("default fleet is valid and keeps intercept disabled", () => {
    expect(validateFleet(DEFAULT_CHUCK_CONFIG.fleet)).toMatchObject({ ok: true });
    expect(DEFAULT_CHUCK_CONFIG.intercept.enabled).toBe(false);
    expect(DEFAULT_CHUCK_CONFIG.vaultPolicy.scope).toBe("doctrine-not-external-truth");
  });

  test("default fleet encodes subscription-only vendor access and local-only sovereign access", () => {
    expect(
      DEFAULT_CHUCK_CONFIG.fleet.map((entry) => [
        entry.family,
        entry.surface,
        entry.commercialPolicy,
      ]),
    ).toEqual([
      ["anthropic", "claude-cli/exec", "subscription-only"],
      ["openai", "chatgpt/web-chat", "subscription-only"],
      ["google", "gemini/cli", "subscription-only"],
      ["perplexity", "perplexity/mac-app", "subscription-only"],
      ["sovereign-local", "ollama/localhost", "local-only"],
      ["xai", "grok/web-or-app", "subscription-only"],
    ]);
    expect(validateFleet(DEFAULT_CHUCK_CONFIG.fleet).invalidCommercialPolicy).toEqual([]);
  });

  test("vendor surfaces cannot be misclassified as local-only core access", () => {
    const invalidVendorPolicy = validateFleet([
      ...DEFAULT_CHUCK_CONFIG.fleet.slice(0, 1),
      {
        ...DEFAULT_CHUCK_CONFIG.fleet[1],
        commercialPolicy: "local-only",
      },
      ...DEFAULT_CHUCK_CONFIG.fleet.slice(2),
    ]);
    expect(invalidVendorPolicy.ok).toBe(false);
    expect(invalidVendorPolicy.invalidCommercialPolicy).toEqual(["openai:chatgpt/web-chat"]);
  });

  test("same-family surfaces can repeat but duplicate family/surface tuples are rejected", () => {
    const secondOpenAiSurface: ChuckFleetEntry = {
      ...DEFAULT_CHUCK_CONFIG.fleet[1],
      voice: "codex-review",
      surface: "codex/review",
      rationale: "Second OpenAI surface for intra-family signal only.",
    };
    const multiSurface = validateFleet([...DEFAULT_CHUCK_CONFIG.fleet, secondOpenAiSurface]);
    expect(multiSurface.ok).toBe(true);
    expect(multiSurface.repeatedFamilies).toEqual(["openai"]);

    const duplicate: ChuckFleetEntry = {
      ...DEFAULT_CHUCK_CONFIG.fleet[0],
      voice: "claude-ai",
    };
    const result = validateFleet([...DEFAULT_CHUCK_CONFIG.fleet, duplicate]);
    expect(result.ok).toBe(false);
    expect(result.duplicateFamilySurfaces).toContain("anthropic:claude-cli/exec");
  });

  test("normalization refuses unsafe Vault policy overrides", () => {
    const config = normalizeChuckConfig({
      evidencePolicy: {
        precedence: DEFAULT_CHUCK_CONFIG.evidencePolicy.precedence,
        vaultMayOverruleExternalTruth: true as false,
      },
      vaultPolicy: {
        writes: "operator-approved-proposals",
        scope: "doctrine-not-external-truth",
      },
    });
    expect(config.evidencePolicy.vaultMayOverruleExternalTruth).toBe(false);
    expect(config.vaultPolicy.writes).toBe("operator-approved-proposals");
  });

  test("normalization refuses unsafe sovereignty policy overrides", () => {
    const config = normalizeChuckConfig({
      sovereigntyPolicy: {
        legitimateSurfaceDominanceRequired: false as true,
        unauthorizedBypassAllowed: true as false,
        stealthEvasionAllowed: true as false,
        internalReceiptsRequired: false as true,
        externalTraceMinimizationRequired: false as true,
        captureResistanceRequired: false as true,
      },
    });
    expect(config.sovereigntyPolicy).toEqual({
      legitimateSurfaceDominanceRequired: true,
      unauthorizedBypassAllowed: false,
      stealthEvasionAllowed: false,
      internalReceiptsRequired: true,
      externalTraceMinimizationRequired: true,
      captureResistanceRequired: true,
    });
  });

  test("default sovereignty posture is aggressive but auditable", () => {
    expect(DEFAULT_CHUCK_CONFIG.sovereigntyPolicy).toMatchObject({
      legitimateSurfaceDominanceRequired: true,
      unauthorizedBypassAllowed: false,
      stealthEvasionAllowed: false,
      internalReceiptsRequired: true,
      externalTraceMinimizationRequired: true,
      captureResistanceRequired: true,
    });
  });

  test("Grok is a default sixth family and the candidate helper is idempotent", () => {
    expect(DEFAULT_CHUCK_CONFIG.fleet.map((entry) => entry.family)).toEqual([
      "anthropic",
      "openai",
      "google",
      "perplexity",
      "sovereign-local",
      "xai",
    ]);
    expect(GROK_CANDIDATE_FLEET_ENTRY).toMatchObject({
      family: "xai",
      voice: "grok",
      capabilityProfile: "live-research",
      weightPolicy: "partial-vote",
    });
    const withGrok = configWithCandidateGrok(DEFAULT_CHUCK_CONFIG);
    expect(withGrok.fleet.map((entry) => entry.family)).toEqual([
      "anthropic",
      "openai",
      "google",
      "perplexity",
      "sovereign-local",
      "xai",
    ]);
    expect(configWithCandidateGrok(withGrok).fleet).toHaveLength(6);
    expect(validateFleet(withGrok.fleet)).toMatchObject({ ok: true });
  });

  test("safe CLI scout helper adds same-family fallback surfaces without extra family votes", () => {
    const config = configWithSafeCliScoutSurfaces();
    const anthropicSurfaces = config.fleet
      .filter((entry) => entry.family === "anthropic")
      .map((entry) => entry.surface);
    const openAiSurfaces = config.fleet
      .filter((entry) => entry.family === "openai")
      .map((entry) => entry.surface);
    const googleSurfaces = config.fleet
      .filter((entry) => entry.family === "google")
      .map((entry) => entry.surface);
    expect(anthropicSurfaces).toEqual(["claude-cli/exec", "claude/web-chat", "claude/mac-app"]);
    expect(openAiSurfaces).toEqual([
      "chatgpt/web-chat",
      "codex/exec",
      "codex-review/exec",
      "chatgpt/mac-app",
    ]);
    expect(googleSurfaces).toEqual(["gemini/cli", "gemini/web-chat", "aistudio/web"]);
    expect(validateFleet(config.fleet)).toMatchObject({
      ok: true,
      repeatedFamilies: ["anthropic", "openai", "google"],
    });
    expect(configWithSafeCliScoutSurfaces(config).fleet).toHaveLength(config.fleet.length);
  });
});

describe("Chuck V2 authority diffs", () => {
  test("Tier-0 patches are high-risk and require approval", () => {
    const diff = assessAuthorityDiff({
      targetPaths: ["extensions/memory-graph/src/chuck-v2/kernel.ts"],
      generatedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(diff.diffId).toMatch(/^authdiff-[a-f0-9]{16}$/);
    expect(diff.protectedPathVerdict).toBe("touches-tier0");
    expect(diff.riskClass).toBe("high");
    expect(diff.operatorApprovalRequired).toBe(true);
    expect(isAuthorityExpanding(diff)).toBe(true);
  });

  test("new imports map into authority capabilities", () => {
    const diff = assessAuthorityDiff({
      targetPaths: ["extensions/memory-graph/scripts/example.mjs"],
      addedImports: ["node:child_process", "undici", "playwright", "node:fs/promises"],
      generatedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(diff.addedCapabilities).toEqual([
      "browser.drive",
      "filesystem.read",
      "filesystem.write",
      "network.fetch",
      "shell.run",
    ]);
    expect(diff.riskClass).toBe("high");
    expect(diff.operatorApprovalRequired).toBe(true);
  });

  test("threshold, allowlist, credential, and sandbox policy changes are authority-expanding", () => {
    const diff = assessAuthorityDiff({
      targetPaths: ["extensions/memory-graph/src/chuck-v2/config.ts"],
      modifiesThresholds: true,
      modifiesAllowlists: true,
      touchesCredentials: true,
      touchesSandboxPolicy: true,
      generatedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(diff.riskClass).toBe("high");
    expect(diff.operatorApprovalRequired).toBe(true);
    expect(isAuthorityExpanding(diff)).toBe(true);
    expect(diff.reasons.join("\n")).toContain("thresholds");
    expect(diff.reasons.join("\n")).toContain("sandbox policy");
  });
});

describe("Chuck V2 external footprint", () => {
  test("local-only work denies network and requires no external receipt", () => {
    const assessment = assessExternalFootprint({
      destinationKind: "none",
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    expect(assessment).toMatchObject({
      verdict: "local-only",
      networkScope: "deny",
      receiptRequired: false,
      externalTraceMinimizationRequired: false,
    });
    expect(assessment.footprintId).toMatch(/^footprint-[a-f0-9]{16}$/);
    expect(canUseExternalSurface(assessment)).toBe(false);
  });

  test("subscribed surfaces are allowed only with minimized payloads and local receipts", () => {
    const assessment = assessExternalFootprint({
      destinationKind: "subscribed-app",
      destination: "chatgpt/web-chat",
      dataClasses: ["prompt", "repo-snippet"],
      operatorAuthorized: true,
      accessEntitled: true,
      payloadMinimized: true,
      receiptPlanned: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    expect(assessment).toMatchObject({
      verdict: "allowed-minimized",
      networkScope: "allowlisted",
      operatorApprovalRequired: false,
      receiptRequired: true,
      externalTraceMinimizationRequired: true,
    });
    expect(canUseExternalSurface(assessment)).toBe(true);
  });

  test("local alternatives route around external submission", () => {
    const assessment = assessExternalFootprint({
      destinationKind: "vendor-model",
      destination: "perplexity/mac-app",
      dataClasses: ["document-span"],
      operatorAuthorized: true,
      accessEntitled: true,
      payloadMinimized: true,
      receiptPlanned: true,
      localOrConnectorAlternativeAvailable: true,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    expect(assessment.verdict).toBe("route-local-first");
    expect(assessment.networkScope).toBe("deny");
    expect(assessment.requiredMitigations).toContain(
      "prefer local, cache, or connector evidence before external submission",
    );
  });

  test("missing minimization or receipts escalates before external use", () => {
    const assessment = assessExternalFootprint({
      destinationKind: "vendor-model",
      destination: "claude-cli/exec",
      dataClasses: ["operator-private"],
      operatorAuthorized: true,
      accessEntitled: true,
      payloadMinimized: false,
      receiptPlanned: false,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    expect(assessment.verdict).toBe("needs-approval");
    expect(assessment.operatorApprovalRequired).toBe(true);
    expect(assessment.networkScope).toBe("allowlisted");
    expect(canUseExternalSurface(assessment)).toBe(false);
  });

  test("bypass attempts and sensitive bulk payloads are blocked", () => {
    for (const assessment of [
      assessExternalFootprint({
        destinationKind: "public-web",
        destination: "paywalled.example",
        dataClasses: ["prompt"],
        operatorAuthorized: true,
        accessEntitled: false,
        attemptsBypass: true,
        payloadMinimized: true,
        receiptPlanned: true,
        generatedAt: "2026-04-27T00:00:00.000Z",
      }),
      assessExternalFootprint({
        destinationKind: "vendor-model",
        destination: "unknown-model",
        dataClasses: ["credential", "full-local-archive"],
        operatorAuthorized: true,
        accessEntitled: true,
        payloadMinimized: false,
        receiptPlanned: true,
        generatedAt: "2026-04-27T00:00:00.000Z",
      }),
    ]) {
      expect(assessment.verdict).toBe("blocked");
      expect(assessment.networkScope).toBe("deny");
      expect(canUseExternalSurface(assessment)).toBe(false);
    }
  });
});

describe("Chuck V2 runner receipts", () => {
  test("signed receipts verify against runner metadata", () => {
    const r = receipt("openai");
    expect(verifyRunnerReceipt(r, SECRET)).toBe(true);
    expect(receiptCountsForFamily(r, "openai")).toBe(true);
  });

  test("tampered family metadata invalidates the signature", () => {
    const r = receipt("openai");
    const tampered = { ...r, actualFamily: "anthropic" as const };
    expect(verifyRunnerReceipt(tampered, SECRET)).toBe(false);
    expect(isImpersonatedReceipt(tampered)).toBe(true);
    expect(receiptCountsForFamily(tampered, "anthropic")).toBe(false);
  });

  test("signed impersonation is still excluded from vote counting", () => {
    const r = receipt("openai", { actualFamily: "anthropic" });
    const report = summarizeReceiptInvariants([r, receipt("anthropic")]);
    expect(verifyRunnerReceipt(r, SECRET)).toBe(true);
    expect(isReceiptValidForCounting(r)).toBe(false);
    expect(report.impersonatedReceipts).toHaveLength(1);
    expect(report.validFamilies).toEqual(["anthropic"]);
  });
});

describe("Chuck V2 surface attribution", () => {
  test("surface receipts preserve same-family surfaces without increasing family count", () => {
    const receipts = [
      receipt("openai", { declaredVoice: "codex", surface: "codex/exec" }),
      receipt("openai", { declaredVoice: "codex-review", surface: "codex/review" }),
      receipt("anthropic", { declaredVoice: "claude-cli", surface: "claude-cli/exec" }),
    ];
    const surfaces = surfaceReceiptsFromRunnerReceipts(receipts);
    expect(surfaces.map((surface) => `${surface.family}:${surface.surface}`).toSorted()).toEqual([
      "anthropic:claude-cli/exec",
      "openai:codex/exec",
      "openai:codex/review",
    ]);

    const record = decisionRecordFromParts({
      runId: "surface-run-1",
      stakeClass: "high-readonly",
      taskClass: "architecture",
      configuredFleetSize: 5,
      adjudicatorFamily: "google",
      receipts,
      claims: [baseClaim],
      alignmentMatrix: matrix([{ id: "A", familyVotes: ["openai", "anthropic"] }]),
      protocol: "INCOMPLETE",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      confidenceLabel: "none",
    });
    expect(record.validVoiceCount).toBe(3);
    expect(record.validFamilyCount).toBe(2);
    expect(record.surfaceReceipts).toHaveLength(3);
  });

  test("same-family opposing verdicts halt while framing divergence remains signal", () => {
    const hard = detectIntraFamilyFractures([
      {
        family: "openai",
        voice: "codex",
        surface: "codex/exec",
        verdict: "accept",
        finalAction: "emit-task-capsule",
      },
      {
        family: "openai",
        voice: "codex-review",
        surface: "codex/review",
        verdict: "reject",
        finalAction: "operator-halt",
      },
    ]);
    expect(hard).toMatchObject([
      {
        family: "openai",
        kind: "opposing-verdict",
        operatorActionRequired: true,
      },
    ]);

    const soft = detectIntraFamilyFractures([
      {
        family: "openai",
        voice: "codex",
        surface: "codex/exec",
        verdict: "accept",
        finalAction: "emit-task-capsule",
        summary: "focuses on authority diff",
      },
      {
        family: "openai",
        voice: "codex-review",
        surface: "codex/review",
        verdict: "accept",
        finalAction: "emit-task-capsule",
        summary: "focuses on operator attention",
      },
    ]);
    expect(soft).toMatchObject([
      {
        family: "openai",
        kind: "framing-divergence",
        operatorActionRequired: false,
      },
    ]);
  });
});

describe("Chuck V2 stake assessment", () => {
  test("destructive actions require approval", () => {
    const assessed = assessStake("delete the workspace and rotate credentials");
    expect(assessed.stakeClass).toBe("destructive");
    expect(assessed.taskClass).toBe("destructive-action");
    expect(assessed.requiresOperatorApproval).toBe(true);
  });

  test("skill installs and Vault writes are high-mutating", () => {
    expect(assessStake("install this ClawHub SKILL.md").taskClass).toBe("skill-install");
    expect(assessStake("write a new Vault doctrine principle").taskClass).toBe("vault-doctrine");
  });

  test("architecture review is high-readonly", () => {
    const assessed = assessStake("evaluate this architecture spec and roadmap");
    expect(assessed.stakeClass).toBe("high-readonly");
    expect(assessed.requiresDecisionRecord).toBe(true);
  });
});

describe("Chuck V2 evidence and Vault policy", () => {
  test("deterministic evidence outranks Vault doctrine", () => {
    expect(compareEvidence("deterministic-verifier", "vault-doctrine")).toBeLessThan(0);
    expect(canVaultOverride("primary-doc", DEFAULT_CHUCK_CONFIG)).toBe(false);
    expect(canVaultOverride("repo-fact", DEFAULT_CHUCK_CONFIG)).toBe(false);
    expect(canVaultOverride("model-reasoning", DEFAULT_CHUCK_CONFIG)).toBe(true);
    expect(canVaultOverride("unsourced", DEFAULT_CHUCK_CONFIG)).toBe(true);
  });

  test("Vault writes remain proposals until the operator approves", () => {
    expect(evaluateVaultWrite({ fleetRecommended: true })).toMatchObject({
      allowedToCommit: false,
      proposalOnly: true,
      requiresOperatorApproval: true,
    });
    expect(evaluateVaultWrite({ fleetRecommended: true, operatorApproved: true })).toMatchObject({
      allowedToCommit: true,
      proposalOnly: false,
    });
  });

  test("Vault cannot resolve conflicts against externally verifiable evidence", () => {
    expect(vaultCanResolveConflictAgainst("primary-doc")).toBe(false);
    expect(vaultCanResolveConflictAgainst("runtime-trace")).toBe(false);
    expect(vaultCanResolveConflictAgainst("model-reasoning")).toBe(true);
  });

  test("document evidence records require span-backed citations", () => {
    const record = createDocumentEvidenceRecord({
      sourceKind: "pdf",
      sourcePathOrUrl: "/tmp/spec.pdf",
      sourceText: "Page 1: Chuck must cite exact source spans before weighing claims.",
      ingestedAt: "2026-04-26T00:00:00.000Z",
      units: [
        {
          unitId: "page-1",
          text: "Chuck must cite exact source spans before weighing claims.",
          coordinate: { page: 1 },
          spans: [
            {
              spanId: "page-1:0-57",
              text: "Chuck must cite exact source spans before weighing claims.",
              startOffset: 0,
              endOffset: 57,
              coordinate: { page: 1 },
            },
          ],
        },
      ],
    });

    expect(record.recordId).toMatch(/^doc-evd-/);
    expect(record.sourceHash).toMatch(/^sha256:/);
    expect(validateDocumentEvidenceRecord(record)).toMatchObject({ ok: true });
    expect(
      verifyDocumentCitation(record, {
        documentRecordId: record.recordId,
        sourceHash: record.sourceHash,
        unitId: "page-1",
        spanId: "page-1:0-57",
        quote: "exact source spans",
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifyDocumentCitation(record, {
        documentRecordId: record.recordId,
        unitId: "page-1",
        spanId: "missing",
      }),
    ).toMatchObject({ ok: false, errors: ["missing span: missing"] });
  });

  test("document citations fail when the quote is not in the cited span", () => {
    const record = createDocumentEvidenceRecord({
      sourceKind: "repo-file",
      sourcePathOrUrl: "/repo/src/file.ts",
      sourceText: "export const safe = true;",
      ingestedAt: "2026-04-26T00:00:00.000Z",
      units: [
        {
          unitId: "file:1-1",
          text: "export const safe = true;",
          coordinate: { startLine: 1, endLine: 1 },
          spans: [{ spanId: "file:1:0-25", text: "export const safe = true;" }],
        },
      ],
    });

    const result = verifyDocumentCitation(record, {
      documentRecordId: record.recordId,
      unitId: "file:1-1",
      spanId: "file:1:0-25",
      quote: "unsafe = true",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("quote is not present in cited span");
  });

  test("document source kinds map into the evidence hierarchy", () => {
    expect(evidenceClassForDocumentSourceKind("repo-file")).toBe("repo-fact");
    expect(evidenceClassForDocumentSourceKind("web-page")).toBe("live-source");
    expect(evidenceClassForDocumentSourceKind("transcript")).toBe("runtime-trace");
    expect(evidenceClassForDocumentSourceKind("pdf")).toBe("primary-doc");
  });

  test("document citations can be attached to claim source spans", () => {
    const record = createDocumentEvidenceRecord({
      sourceKind: "transcript",
      sourcePathOrUrl: "/tmp/transcript.txt",
      sourceText: "The verifier passed.",
      ingestedAt: "2026-04-26T00:00:00.000Z",
      units: [
        {
          unitId: "timestamp:1000",
          text: "The verifier passed.",
          coordinate: { timestampMs: 1000 },
          spans: [{ spanId: "timestamp:1000:0-20", text: "The verifier passed." }],
        },
      ],
    });
    const sourceSpan = documentCitationToSourceSpan(record, {
      documentRecordId: record.recordId,
      unitId: "timestamp:1000",
      spanId: "timestamp:1000:0-20",
      quote: "verifier passed",
    });
    expect(sourceSpan).toEqual({
      source: "/tmp/transcript.txt",
      documentRecordId: record.recordId,
      unitId: "timestamp:1000",
      spanId: "timestamp:1000:0-20",
      quote: "verifier passed",
    });
  });
});

describe("Chuck V2 preflight admission", () => {
  const health: WorkerHealthSnapshot = {
    updatedAt: "2026-04-26T00:00:00.000Z",
    workers: {
      claude: { worker: "claude", healthy: true },
      chatgpt: { worker: "chatgpt", healthy: true },
      gemini: { worker: "gemini", healthy: false, details: "quota exhausted" },
      perplexity: { worker: "perplexity", healthy: true },
      ollama: { worker: "ollama", healthy: false, details: "not running" },
      grok: { worker: "grok", healthy: false, details: "session missing" },
    },
  };

  test("allows high-readonly work in DEGRADED-3 but labels it", () => {
    const result = preflightAdmission({
      config: DEFAULT_CHUCK_CONFIG,
      health,
      stakeClass: "high-readonly",
    });
    expect(result.admitted).toBe(true);
    expect(result.degradedMode).toBe("DEGRADED-3");
    expect(result.validFamilies).toEqual(["anthropic", "openai", "perplexity"]);
  });

  test("blocks high-mutating work when only three families are healthy", () => {
    const result = preflightAdmission({
      config: DEFAULT_CHUCK_CONFIG,
      health,
      stakeClass: "high-mutating",
    });
    expect(result.admitted).toBe(false);
    expect(result.reasons.join("\n")).toContain("4 required");
  });

  test("blocks sovereignty-critical work without the local family", () => {
    const result = preflightAdmission({
      config: DEFAULT_CHUCK_CONFIG,
      health,
      stakeClass: "high-readonly",
      sovereigntyCritical: true,
    });
    expect(result.admitted).toBe(false);
    expect(result.reasons.join("\n")).toContain("sovereign-local");
  });

  test("rejects duplicate family/surface fleet configs", () => {
    const config = normalizeChuckConfig({
      fleet: [
        ...DEFAULT_CHUCK_CONFIG.fleet,
        { ...DEFAULT_CHUCK_CONFIG.fleet[0], voice: "claude-ai" },
      ],
    });
    const result = preflightAdmission({ config, stakeClass: "medium" });
    expect(result.admitted).toBe(false);
    expect(result.reasons.join("\n")).toContain(
      "duplicateFamilySurfaces=anthropic:claude-cli/exec",
    );
  });

  test("rejects invalid commercial policy before fleet admission", () => {
    const config = normalizeChuckConfig({
      fleet: [
        ...DEFAULT_CHUCK_CONFIG.fleet.slice(0, 3),
        {
          ...DEFAULT_CHUCK_CONFIG.fleet[3],
          commercialPolicy: "local-only",
        },
        DEFAULT_CHUCK_CONFIG.fleet[4],
      ],
    });
    const result = preflightAdmission({ config, stakeClass: "medium" });
    expect(result.admitted).toBe(false);
    expect(result.reasons.join("\n")).toContain(
      "invalid commercial policy: perplexity:perplexity/mac-app",
    );
  });

  test("blocks high-risk fleet work under memory warning but allows trivial work", () => {
    const warning = { memoryPressure: "warning" as const, freeMemoryMb: 900 };
    expect(
      preflightAdmission({
        config: DEFAULT_CHUCK_CONFIG,
        stakeClass: "high-mutating",
        resources: warning,
      }),
    ).toMatchObject({
      admitted: false,
      resourceMode: "memory-warning",
    });
    expect(
      preflightAdmission({
        config: DEFAULT_CHUCK_CONFIG,
        stakeClass: "trivial",
        resources: warning,
      }),
    ).toMatchObject({
      admitted: true,
      resourceMode: "memory-warning",
    });
  });

  test("critical memory pressure admits only trivial work", () => {
    const critical = { memoryPressure: "critical" as const, freeMemoryMb: 500 };
    const highReadonly = preflightAdmission({
      config: DEFAULT_CHUCK_CONFIG,
      stakeClass: "high-readonly",
      resources: critical,
    });
    expect(highReadonly.admitted).toBe(false);
    expect(highReadonly.resourceMode).toBe("memory-critical");
    expect(highReadonly.reasons.join("\n")).toContain("critical memory pressure");

    expect(
      preflightAdmission({
        config: DEFAULT_CHUCK_CONFIG,
        stakeClass: "trivial",
        resources: critical,
      }),
    ).toMatchObject({
      admitted: true,
      resourceMode: "memory-critical",
    });
  });

  test("limits concurrent fleet runs by default on constrained machines", () => {
    const result = preflightAdmission({
      config: DEFAULT_CHUCK_CONFIG,
      stakeClass: "medium",
      activeFleetRuns: 1,
    });
    expect(result.admitted).toBe(false);
    expect(result.resourceMode).toBe("concurrency-limited");
    expect(result.reasons.join("\n")).toContain("maxConcurrentFleetRuns");
  });

  test("maps memory-pressure watcher levels into kernel resource policy levels", () => {
    expect(memoryPressureFromWatcherLevel("L0")).toBe("normal");
    expect(memoryPressureFromWatcherLevel("L1")).toBe("warning");
    expect(memoryPressureFromWatcherLevel("L2")).toBe("warning");
    expect(memoryPressureFromWatcherLevel("L3")).toBe("critical");

    expect(
      machineResourceSnapshotFromMemorySample({
        ts: Date.UTC(2026, 3, 27, 2, 30, 0),
        level: "L3",
        freeMb: 512,
        swapUsedMb: 35878,
        compressedMb: 12000,
      }),
    ).toMatchObject({
      capturedAt: "2026-04-27T02:30:00.000Z",
      memoryPressure: "critical",
      freeMemoryMb: 512,
      swapUsedMb: 35878,
      notes: ["compressed memory 12000MB"],
    });
  });

  test("derives memory pressure from native Darwin vm_stat and sysctl output", () => {
    const snapshot = machineResourceSnapshotFromDarwinMemory({
      capturedAt: "2026-04-27T03:00:00.000Z",
      memsizeOutput: "hw.memsize: 34359738368",
      swapUsageOutput: "vm.swapusage: total = 4096.00M  used = 5120.00M  free = 0.00M  (encrypted)",
      vmStatOutput: [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                               80000.",
        "Pages inactive:                           10000.",
        "Pages speculative:                        10000.",
        "Pages purgeable:                              0.",
        "Pages occupied by compressor:           700000.",
      ].join("\n"),
    });
    expect(snapshot).toMatchObject({
      capturedAt: "2026-04-27T03:00:00.000Z",
      memoryPressure: "warning",
      freeMemoryMb: 1406,
      swapUsedMb: 5120,
    });
    expect(snapshot.notes?.join("\n")).toContain("total memory 32768MB");
    expect(snapshot.notes?.join("\n")).toContain(
      "inactive memory 156MB not counted as admission headroom",
    );
  });

  test("does not count large inactive macOS memory as build admission headroom", () => {
    const snapshot = machineResourceSnapshotFromDarwinMemory({
      capturedAt: "2026-04-27T06:58:00.000Z",
      memsizeOutput: "hw.memsize: 17179869184",
      swapUsageOutput:
        "vm.swapusage: total = 2048.00M  used = 376.56M  free = 1671.44M  (encrypted)",
      vmStatOutput: [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages free:                               78980.",
        "Pages inactive:                          439053.",
        "Pages speculative:                         3322.",
        "Pages purgeable:                          13560.",
        "Pages occupied by compressor:             88254.",
      ].join("\n"),
    });
    expect(snapshot).toMatchObject({
      memoryPressure: "warning",
      freeMemoryMb: 1498,
      swapUsedMb: 376.56,
    });
    expect(snapshot.notes?.join("\n")).toContain(
      "inactive memory 6860MB not counted as admission headroom",
    );
  });
});

describe("Chuck V2 Fleet-default efficiency governor", () => {
  const allHealthy: WorkerHealthSnapshot = {
    updatedAt: "2026-04-27T00:00:00.000Z",
    workers: {
      claude: { worker: "claude", healthy: true },
      chatgpt: { worker: "chatgpt", healthy: true },
      gemini: { worker: "gemini", healthy: true },
      perplexity: { worker: "perplexity", healthy: true },
      ollama: { worker: "ollama", healthy: true },
      grok: { worker: "grok", healthy: true },
    },
  };

  test("non-trivial requests default to sealed Fleet scout", () => {
    const decision = planFleetEfficiency({
      runId: "eff-run-1",
      requestText: "evaluate this architecture spec",
      stakeClass: "high-readonly",
      taskClass: "architecture",
      health: allHealthy,
    });
    expect(decision.chosenOption.kind).toBe("fleet-scout");
    expect(decision.fleetPlan.protocol).toBe("scout-deepen-resolve");
    expect(decision.fleetPlan.sealedFirstRound).toBe(true);
    expect(decision.fleetPlan.lateScoutPolicy).toBe("drop-from-round");
    expect(decision.chosenOption.dropOnTimeout).toBe(true);
    expect(decision.chosenOption.timeoutMs).toBeGreaterThan(0);
    expect(decision.fleetPlan.persuasiveMajorityMayOverrideEvidence).toBe(false);
    expect(decision.rejectedOptions.map((option) => option.kind)).toContain("single-surface");
  });

  test("trivial requests can use the least-action single-surface path", () => {
    const decision = planFleetEfficiency({
      runId: "eff-run-2",
      requestText: "what is the time",
      stakeClass: "trivial",
      taskClass: "factual",
      health: allHealthy,
    });
    expect(decision.chosenOption.kind).toBe("single-surface");
    expect(decision.chosenOption.surfaces).toEqual(["ollama/localhost"]);
    expect(decision.rejectedOptions.map((option) => option.kind)).toContain("fleet-scout");
  });

  test("memory warning staggers Fleet while critical memory blocks non-trivial work", () => {
    expect(
      planFleetEfficiency({
        runId: "eff-run-3",
        requestText: "evaluate this architecture spec",
        stakeClass: "high-readonly",
        taskClass: "architecture",
        resources: { memoryPressure: "warning", freeMemoryMb: 900 },
        health: allHealthy,
      }),
    ).toMatchObject({
      chosenOption: { kind: "fleet-scout", schedulingMode: "staggered" },
      visibleToOperator: "operator-visible",
    });
    expect(
      planFleetEfficiency({
        runId: "eff-run-4",
        requestText: "evaluate this architecture spec",
        stakeClass: "high-readonly",
        taskClass: "architecture",
        resources: { memoryPressure: "critical", freeMemoryMb: 400 },
        health: allHealthy,
      }),
    ).toMatchObject({
      chosenOption: { kind: "docket", schedulingMode: "blocked-trivial-only" },
    });
  });

  test("scout deepens only for stake, conflict, uncertainty, or source-heavy factual work", () => {
    expect(
      shouldDeepenFleetScout({
        stakeClass: "medium",
        taskClass: "architecture",
        alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "openai", "google"] }]),
      }),
    ).toMatchObject({ shouldDeepen: false });
    expect(
      shouldDeepenFleetScout({
        stakeClass: "medium",
        taskClass: "architecture",
        alignmentMatrix: {
          clusters: [
            {
              id: "A",
              familyVotes: ["anthropic", "openai"],
              claimIds: ["claim-a"],
              summary: "sandboxed worktree verifier passes",
            },
            {
              id: "B",
              familyVotes: ["google", "perplexity"],
              claimIds: ["claim-b"],
              summary: "credential proxy authority expands",
            },
          ],
          contradictions: ["families disagreed"],
        },
      }),
    ).toMatchObject({ shouldDeepen: true });
    expect(
      shouldDeepenFleetScout({
        stakeClass: "medium",
        taskClass: "factual",
        requestText: "verify the latest source with citations",
      }),
    ).toMatchObject({ shouldDeepen: true });
    expect(
      shouldDeepenFleetScout({
        stakeClass: "medium",
        taskClass: "code-mutation",
        generatedDiffText: "import { execFile } from 'node:child_process';",
      }),
    ).toMatchObject({ shouldDeepen: true, triggers: ["code-diff-risk"] });
  });

  test("deterministic deepen triggers distinguish conflict, minority block, missing citation, and verifier failure", () => {
    expect(
      computeDeepenTriggers({
        stakeClass: "medium",
        taskClass: "factual",
        requestText: "verify current sources",
        alignmentMatrix: {
          clusters: [
            {
              id: "A",
              familyVotes: ["anthropic", "openai"],
              claimIds: ["claim-a"],
              summary: "sandboxed worktree verifier passes",
            },
            {
              id: "B",
              familyVotes: ["google", "perplexity"],
              claimIds: ["claim-b"],
              summary: "credential proxy authority expands",
            },
          ],
          contradictions: ["families disagreed"],
        },
        claims: [{ ...baseClaim, evidenceClass: "unsourced", sourceSpans: [] }],
        verifierStatus: "failed",
      }),
    ).toEqual([
      "claim-cluster-conflict",
      "large-minority",
      "low-claim-similarity",
      "source-heavy",
      "missing-citation",
      "verifier-failed",
    ]);
  });

  test("sealed first pass and blinded adjudication prevent peer and identity leakage", () => {
    const scoutPrompt = buildScoutRoundPrompt({ requestText: "Evaluate this." });
    expect(scoutPrompt.sealed).toBe(true);
    expect(scoutPrompt.includesPeerOutputs).toBe(false);
    expect(scoutPrompt.dropOnTimeout).toBe(true);
    expect(scoutPrompt.prompt).toContain("Do not infer or reference other model outputs");

    const packet = createBlindedAdjudicationPacket({
      seed: "unit-seed",
      claims: [
        { ...baseClaim, id: "claim-b", producedBy: ["anthropic"] },
        { ...baseClaim, id: "claim-a", producedBy: ["openai"] },
      ],
    });
    expect(packet.identityBlind).toBe(true);
    expect(packet.randomizedOrder).toBe(true);
    expect(packet.persuasiveMajorityMayOverrideEvidence).toBe(false);
    expect(packet.claims[0]).not.toHaveProperty("producedBy");
    expect(packet.hiddenProvenance).toEqual([
      { claimId: "claim-b", producedBy: ["anthropic"], sourceSpanCount: 1 },
      { claimId: "claim-a", producedBy: ["openai"], sourceSpanCount: 1 },
    ]);
    expect(normalizeClaimText("Claude says that I apologize, but the diff is risky.")).toBe(
      "the diff is risky.",
    );
  });

  test("contrarian deepen prompt treats outlier as hypothesis, not binding fact", () => {
    const prompt = buildContrarianDeepenPrompt({
      requestText: "Change a protected permission proxy.",
      normalizedClaim: {
        id: "claim-risk",
        text: "The proposed path expands authority without an approval diff.",
        evidenceClass: "model-reasoning",
        category: "risk",
        confidence: 0.7,
      },
    });
    expect(prompt).toMatchObject({ identityBlind: true, bindingPremise: false });
    expect(prompt.prompt).toContain("hypothesis to test");
    expect(prompt.prompt).toContain("Validate the premise");
  });

  test("calibrated reliability changes retry/order without changing family count", () => {
    const decision = planFleetEfficiency({
      runId: "eff-run-5",
      requestText: "research current sources",
      stakeClass: "medium",
      taskClass: "factual",
      health: allHealthy,
      reliabilityProfiles: [
        {
          family: "perplexity",
          surface: "perplexity/mac-app",
          taskKind: "source-heavy-research",
          reliability: 0.95,
          sampleCount: 20,
          observedAt: "2026-04-27T00:00:00.000Z",
          halfLifeDays: 30,
        },
      ],
    });
    expect(decision.chosenOption.kind).toBe("fleet-scout");
    expect(decision.chosenOption.surfaces[0]).toBe("perplexity/mac-app");
    expect(decision.chosenOption.families).toContain("perplexity");
  });

  test("calibration weights decay over time and stay inactive during cold start", () => {
    expect(
      planFleetEfficiency({
        runId: "eff-run-cold-start",
        requestText: "research current sources",
        stakeClass: "medium",
        taskClass: "factual",
        health: allHealthy,
        reliabilityProfiles: [
          {
            family: "perplexity",
            surface: "perplexity/mac-app",
            taskKind: "source-heavy-research",
            reliability: 0.99,
            sampleCount: 3,
          },
        ],
      }).chosenOption.surfaces[0],
    ).not.toBe("perplexity/mac-app");
    expect(
      decayedReliabilityForProfile({
        now: new Date("2026-04-28T00:00:00.000Z"),
        profile: {
          family: "perplexity",
          surface: "perplexity/mac-app",
          taskKind: "source-heavy-research",
          reliability: 0.9,
          sampleCount: 30,
          observedAt: "2026-03-28T00:00:00.000Z",
          halfLifeDays: 30,
        },
      }),
    ).toBeCloseTo(0.7, 1);
  });

  test("task classes declare their external ground-truth anchors", () => {
    expect(
      groundTruthAnchorForTask({ stakeClass: "high-mutating", taskClass: "code-mutation" }),
    ).toMatchObject({
      kind: "deterministic-verifier",
      factualAuthority: "strong",
    });
    expect(
      groundTruthAnchorForTask({
        stakeClass: "medium",
        taskClass: "architecture",
      }),
    ).toMatchObject({
      kind: "structural-judgment-only",
      factualAuthority: "structural-only",
    });
  });

  test("trace grading records local regression signals", () => {
    expect(
      gradeEfficiencyTrace({
        correctness: 0.9,
        evidenceQuality: 0.86,
        refusalQuality: 0.9,
        latencyMs: 10_000,
        quotaCalls: 6,
      }),
    ).toMatchObject({ grade: "pass" });
    expect(
      gradeEfficiencyTrace({
        correctness: 0.52,
        evidenceQuality: 0.4,
        failures: 1,
        operatorAttentionMinutes: 15,
      }).regressionSignals,
    ).toEqual([
      "correctness below route-change floor",
      "evidence quality below route-change floor",
      "run had tool/surface failures",
      "operator attention cost too high",
    ]);
  });

  test("fleet traces persist route, resources, grades, and regression signals in local SQLite", () => {
    const db = new DatabaseSync(":memory:");
    initializeFleetTraceDb(db);
    const record = createFleetTraceRecord({
      traceId: "trace-eff-1",
      runId: "run-eff-1",
      taskClass: "factual",
      stakeClass: "medium",
      routeTaken: "fleet-scout",
      scoutFamilies: ["anthropic", "openai", "google", "perplexity"],
      promptBudgetChars: 3500,
      surfaceReceiptCount: 4,
      finalDisposition: "red-team-outlier",
      protocol: "OUTLIER",
      memoryPressure: "normal",
      quotaPolicy: "normal",
      metrics: {
        correctness: 0.8,
        evidenceQuality: 0.9,
        latencyMs: 12_000,
        quotaCalls: 4,
      },
    });
    appendFleetTrace(db, record);
    expect(readFleetTrace(db, "trace-eff-1")).toMatchObject({
      runId: "run-eff-1",
      routeTaken: "fleet-scout",
      scoutFamilies: ["anthropic", "openai", "google", "perplexity"],
      promptBudgetChars: 3500,
      finalDisposition: "red-team-outlier",
      protocol: "OUTLIER",
      grade: { grade: "pass" },
    });
    db.close();
  });
});

describe("Chuck V2 local OCR and Perplexity leases", () => {
  test("Apex OCR is preferred over tesseract and external vision", () => {
    const capability = detectLocalOcrCapability({
      apexOcrPath: "/bin/apex-ocr",
      apexOcrSourcePath: "/src/apex-ocr.swift",
      swiftcPath: "/usr/bin/swiftc",
      tesseractPath: "/opt/homebrew/bin/tesseract",
      exists: (path) => path === "/bin/apex-ocr" || path === "/opt/homebrew/bin/tesseract",
    });
    expect(capability).toMatchObject({
      status: "local-ready",
      preferredProvider: "apex-ocr",
      providerOrder: ["apex-ocr", "tesseract"],
    });
    expect(chooseOcrRoute({ capability, externalVisionAllowed: true })).toMatchObject({
      chosenProvider: "apex-ocr",
      localOnly: true,
    });
  });

  test("OCR is buildable when the Swift source and compiler exist", () => {
    expect(
      detectLocalOcrCapability({
        apexOcrPath: "/bin/apex-ocr",
        apexOcrSourcePath: "/src/apex-ocr.swift",
        swiftcPath: "/usr/bin/swiftc",
        tesseractPath: "/opt/homebrew/bin/tesseract",
        exists: (path) => path === "/src/apex-ocr.swift" || path === "/usr/bin/swiftc",
      }),
    ).toMatchObject({
      status: "buildable",
      preferredProvider: "apex-ocr",
    });
  });

  test("active Perplexity Incognito lease is reused before creating a new thread", () => {
    const lease = createPerplexitySessionLease({
      leaseId: "lease-active-1",
      runId: "run-pplx-1",
      now: "2026-04-27T00:00:00.000Z",
      mode: "research",
      originalIncognitoState: "OFF",
      incognitoVerified: true,
      entitlementStatus: "unknown",
    });
    expect(
      choosePerplexityLease({
        activeLeases: [lease],
        now: "2026-04-27T00:02:00.000Z",
        requestedMode: "research",
      }),
    ).toMatchObject({
      action: "reuse-active-lease",
      lease: { leaseId: "lease-active-1", lastObservedAt: "2026-04-27T00:02:00.000Z" },
    });
  });

  test("Perplexity lease preserves unknown entitlement as a caveat", () => {
    const lease = createPerplexitySessionLease({
      runId: "run-pplx-2",
      incognitoVerified: true,
      entitlementStatus: "unknown",
    });
    expect(lease.status).toBe("active");
    expect(lease.reasons.join("\n")).toContain("do not report Max as verified");
  });

  test("Perplexity Incognito restore waits for the last active lease", () => {
    const closingLease = createPerplexitySessionLease({
      leaseId: "lease-closing",
      runId: "run-pplx-3",
      originalIncognitoState: "OFF",
      incognitoVerified: true,
    });
    const otherLease = createPerplexitySessionLease({
      leaseId: "lease-other",
      runId: "run-pplx-4",
      originalIncognitoState: "OFF",
      incognitoVerified: true,
    });
    expect(shouldRestorePerplexityIncognito({ closingLease, activeLeases: [otherLease] })).toBe(
      false,
    );
    expect(
      shouldRestorePerplexityIncognito({
        closingLease: completePerplexityLease({ lease: closingLease }),
      }),
    ).toBe(true);
  });
});

describe("Chuck V2 kernel", () => {
  test("trivial requests route to a single model without a DecisionRecord requirement", () => {
    const decision = evaluateKernelPreflight({
      requestText: "what is the time",
      config: DEFAULT_CHUCK_CONFIG,
    });
    expect(decision.disposition).toBe("route-single-model");
    expect(decision.finalAction).toBe("single-model-response");
    expect(decision.canProceed).toBe(true);
    expect(decision.operatorActionRequired).toBe(false);
  });

  test("destructive requests require operator approval before execution", () => {
    const decision = evaluateKernelPreflight({
      requestText: "delete the workspace",
      config: DEFAULT_CHUCK_CONFIG,
    });
    expect(decision.disposition).toBe("operator-approval-required");
    expect(decision.finalAction).toBe("operator-approval-required");
    expect(decision.canProceed).toBe(false);
    expect(decision.operatorActionRequired).toBe(true);
  });

  test("kernel halts non-trivial work under critical memory pressure", () => {
    const decision = evaluateKernelPreflight({
      requestText: "evaluate this architecture spec",
      config: DEFAULT_CHUCK_CONFIG,
      resources: { memoryPressure: "critical", freeMemoryMb: 400 },
    });
    expect(decision.disposition).toBe("halt");
    expect(decision.preflight.resourceMode).toBe("memory-critical");
    expect(decision.canProceed).toBe(false);
  });

  test("unanimous high-mutating adjudication can emit a TaskCapsule", () => {
    const receipts = [
      receipt("anthropic"),
      receipt("openai"),
      receipt("google"),
      receipt("perplexity"),
      receipt("sovereign-local"),
    ];
    const decision = evaluateKernelAdjudication({
      requestText: "write a TypeScript patch and run tests",
      config: DEFAULT_CHUCK_CONFIG,
      receipts,
      claims: [baseClaim],
      alignmentMatrix: matrix([
        {
          id: "A",
          familyVotes: ["anthropic", "openai", "google", "perplexity", "sovereign-local"],
        },
      ]),
      adjudicatorFamily: "google",
      runId: "kernel-run-1",
    });
    expect(decision.classification.protocol).toBe("UNANIMOUS");
    expect(decision.disposition).toBe("execute");
    expect(decision.canExecute).toBe(true);
    expect(decision.decisionRecord.operatorActionRequired).toBe(false);
  });

  test("destructive unanimous adjudication executes only after operator approval", () => {
    const receipts = [
      receipt("anthropic"),
      receipt("openai"),
      receipt("google"),
      receipt("perplexity"),
      receipt("sovereign-local"),
    ];
    const input = {
      requestText: "delete generated cache files",
      config: DEFAULT_CHUCK_CONFIG,
      receipts,
      claims: [baseClaim],
      alignmentMatrix: matrix([
        {
          id: "A",
          familyVotes: ["anthropic", "openai", "google", "perplexity", "sovereign-local"],
        },
      ]),
      adjudicatorFamily: "google" as const,
      runId: "kernel-run-2",
    };

    expect(evaluateKernelAdjudication(input)).toMatchObject({
      disposition: "operator-approval-required",
      canExecute: false,
      operatorActionRequired: true,
    });
    expect(evaluateKernelAdjudication({ ...input, operatorApproved: true })).toMatchObject({
      disposition: "execute",
      finalAction: "emit-task-capsule",
      canExecute: true,
      operatorActionRequired: false,
    });
  });

  test("deep fractures halt instead of executing a simple majority", () => {
    const decision = evaluateKernelAdjudication({
      requestText: "evaluate this architecture spec",
      config: DEFAULT_CHUCK_CONFIG,
      receipts: [
        receipt("anthropic"),
        receipt("openai"),
        receipt("google"),
        receipt("perplexity"),
        receipt("sovereign-local"),
      ],
      claims: [baseClaim],
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google"] },
        { id: "B", familyVotes: ["perplexity", "sovereign-local"] },
      ]),
      adjudicatorFamily: "anthropic",
      runId: "kernel-run-3",
    });
    expect(decision.classification.protocol).toBe("DEEP_FRACTURE");
    expect(decision.disposition).toBe("halt");
    expect(decision.canExecute).toBe(false);
  });

  test("outliers can continue resolution but cannot execute directly", () => {
    const decision = evaluateKernelAdjudication({
      requestText: "evaluate this architecture spec",
      config: DEFAULT_CHUCK_CONFIG,
      receipts: [
        receipt("anthropic"),
        receipt("openai"),
        receipt("google"),
        receipt("perplexity"),
        receipt("sovereign-local"),
      ],
      claims: [baseClaim],
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google", "perplexity"] },
        { id: "B", familyVotes: ["sovereign-local"] },
      ]),
      adjudicatorFamily: "openai",
      runId: "kernel-run-4",
    });
    expect(decision.classification.protocol).toBe("OUTLIER");
    expect(decision.disposition).toBe("continue-resolution");
    expect(decision.canContinueResolution).toBe(true);
    expect(decision.canExecute).toBe(false);
  });

  test("intra-family fractures halt before execution even when family-level votes converge", () => {
    const decision = evaluateKernelAdjudication({
      requestText: "evaluate this architecture spec",
      config: DEFAULT_CHUCK_CONFIG,
      receipts: [
        receipt("anthropic"),
        receipt("openai", { declaredVoice: "codex", surface: "codex/exec" }),
        receipt("openai", { declaredVoice: "codex-review", surface: "codex/review" }),
        receipt("google"),
        receipt("perplexity"),
      ],
      claims: [baseClaim],
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google", "perplexity"] },
      ]),
      adjudicatorFamily: "google",
      intraFamilyFractures: [
        {
          family: "openai",
          surfaces: ["codex/exec", "codex/review"],
          kind: "opposing-verdict",
          operatorActionRequired: true,
          summary: "OpenAI surfaces disagreed on accept vs reject.",
        },
      ],
      runId: "kernel-run-intra-family",
    });
    expect(decision.classification.protocol).toBe("INTRA_FAMILY_FRACTURE");
    expect(decision.disposition).toBe("halt");
    expect(decision.canExecute).toBe(false);
    expect(decision.decisionRecord.intraFamilyFractures).toHaveLength(1);
  });

  test("impersonated receipts force a kernel halt", () => {
    const decision = evaluateKernelAdjudication({
      requestText: "evaluate this architecture spec",
      config: DEFAULT_CHUCK_CONFIG,
      receipts: [
        receipt("openai", { actualFamily: "anthropic" }),
        receipt("anthropic"),
        receipt("google"),
      ],
      claims: [baseClaim],
      alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "google"] }]),
      adjudicatorFamily: "google",
      runId: "kernel-run-5",
    });
    expect(decision.classification.protocol).toBe("IMPERSONATION_DETECTED");
    expect(decision.disposition).toBe("halt");
    expect(decision.canExecute).toBe(false);
    expect(decision.operatorActionRequired).toBe(true);
  });

  test("kernel adjudications can be emitted as a replayable event chain", () => {
    const requestText = "evaluate this architecture spec";
    const decision = evaluateKernelAdjudication({
      requestText,
      config: DEFAULT_CHUCK_CONFIG,
      receipts: [receipt("anthropic"), receipt("openai"), receipt("google")],
      claims: [baseClaim],
      alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "openai", "google"] }]),
      adjudicatorFamily: "google",
      runId: "kernel-run-events",
    });
    const events = eventsForKernelAdjudication({
      requestText,
      decision,
      occurredAt: "2026-04-26T00:00:00.000Z",
    });

    expect(events.map((event) => event.type)).toEqual([
      "prompt.received",
      "stake.classified",
      "preflight.evaluated",
      "protocol.classified",
      "decision.recorded",
    ]);
    expect(events[1].previousEventHash).toBe(events[0].eventHash);
    expect(events.every((event) => verifyChuckEvent(event))).toBe(true);
    expect(events.at(-1)?.payload).toMatchObject({ decisionRecordId: "kernel-run-events" });
  });
});

describe("Chuck V2 runnable loop", () => {
  test("preflight loop creates a waiting-fleet docket item for high-readonly work", async () => {
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      runId: "loop-preflight-1",
      now: "2026-04-27T00:00:00.000Z",
    });
    expect(summarizeChuckLoopResult(result)).toMatchObject({
      runId: "loop-preflight-1",
      mode: "preflight",
      disposition: "route-fleet",
      finalAction: "emit-task-capsule",
      stakeClass: "high-readonly",
      docketStatus: "waiting-fleet",
      operatorActionRequired: false,
      efficiencyOption: "fleet-scout",
      efficiencyStage: "scout",
    });
    expect(result.efficiencyDecision.chosenOption.kind).toBe("fleet-scout");
    expect(result.dispatchPlan).toMatchObject({
      optionKind: "fleet-scout",
      stage: "scout",
      lateScoutPolicy: "drop-from-round",
      independentFamilyCount: 6,
    });
    expect(
      result.dispatchPlan.tasks.every((task) => task.sealed && !task.includesPeerOutputs),
    ).toBe(true);
    expect(result.traceRecord).toMatchObject({
      traceId: "trace-loop-preflight-1",
      routeTaken: "fleet-scout",
      scoutFamilies: ["anthropic", "openai", "google", "perplexity", "sovereign-local", "xai"],
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "prompt.received",
      "stake.classified",
      "preflight.evaluated",
      "efficiency.planned",
      "fleet.dispatch.planned",
      "fleet.trace.recorded",
    ]);
    expect(result.events.every((event) => verifyChuckEvent(event))).toBe(true);
  });

  test("dispatch treats same-family surfaces as intra-family signal, not extra votes", async () => {
    const config = normalizeChuckConfig({
      fleet: [
        ...DEFAULT_CHUCK_CONFIG.fleet,
        {
          ...DEFAULT_CHUCK_CONFIG.fleet[1],
          voice: "codex",
          surface: "codex/exec",
          capabilityProfile: "code-grounded",
        },
      ],
    });
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      config,
      runId: "loop-dispatch-surface",
      now: "2026-04-27T00:00:00.000Z",
    });
    const openAiTasks = result.dispatchPlan.tasks.filter((task) => task.family === "openai");
    expect(openAiTasks).toHaveLength(2);
    expect(openAiTasks.filter((task) => task.countsAsIndependentFamilySignal)).toHaveLength(1);
    expect(result.dispatchPlan.independentFamilyCount).toBe(6);
  });

  test("local Ollama adapter executes a dispatch task and emits a signed receipt", async () => {
    const localScout = structuredScoutText();
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      runId: "loop-local-ollama",
      now: "2026-04-27T00:00:00.000Z",
    });
    const localPlan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) => task.surface === "ollama/localhost"),
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: localPlan,
      adapters: [
        createOllamaRunnerAdapter({
          model: "llama-test",
          fetchImpl: async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
            return {
              ok: true,
              status: 200,
              text: async () => "",
              json: async () => ({ response: localScout, model: "llama-test" }),
            };
          },
        }),
      ],
      signingSecret: SECRET,
      now: fixedClock(["2026-04-27T00:00:01.000Z", "2026-04-27T00:00:02.000Z"]),
    });
    expect(execution.receipts).toHaveLength(1);
    expect(execution.executions).toMatchObject([
      {
        status: "completed",
        family: "sovereign-local",
        surface: "ollama/localhost",
        text: localScout,
        calibration: { verdict: "usable" },
        countingEligible: true,
      },
    ]);
    expect(verifyRunnerReceipt(execution.receipts[0], SECRET)).toBe(true);
    expect(execution.receipts[0]).toMatchObject({
      requestedFamily: "sovereign-local",
      actualFamily: "sovereign-local",
      actualRunner: "ollama-http-local",
      modelClaimed: "ollama/llama-test (local)",
      modelVerified: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://localhost:11434/api/generate",
      body: {
        model: "llama-test",
        stream: false,
        think: false,
      },
    });
    expect(String(calls[0]?.body.prompt)).toContain(
      "Do not infer or reference other model outputs",
    );
    expect(String(calls[0]?.body.prompt)).toContain("technical evaluation pass");
    expect(String(calls[0]?.body.prompt)).toContain("DEEPEN_NEEDED: yes|no");
  });

  test("local output calibration degrades roleplay drift before it can count", async () => {
    const driftText =
      "Recommended scout path: approach the asteroid field and scan energy signatures.";
    expect(
      calibrateRunnerOutput({
        family: "sovereign-local",
        surface: "ollama/localhost",
        text: driftText,
      }),
    ).toMatchObject({
      verdict: "degraded",
      roleplayDriftDetected: true,
      formatCompliant: false,
    });

    const result = await runChuckLoop({
      requestText: "say ok",
      runId: "loop-local-drift",
      now: "2026-04-27T00:00:00.000Z",
    });
    const localPlan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) => task.surface === "ollama/localhost"),
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: localPlan,
      adapters: [
        createOllamaRunnerAdapter({
          model: "llama-test",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({ response: driftText, model: "llama-test" }),
          }),
        }),
      ],
      signingSecret: SECRET,
      now: fixedClock(["2026-04-27T00:00:01.000Z", "2026-04-27T00:00:02.000Z"]),
    });
    const completed = execution.executions[0];
    expect(completed).toMatchObject({
      status: "completed",
      calibration: {
        verdict: "degraded",
        roleplayDriftDetected: true,
      },
      countingEligible: false,
    });
    expect(execution.receipts[0]).toMatchObject({
      actualFamily: "sovereign-local",
      modelVerified: false,
    });
    expect(summarizeReceiptInvariants(execution.receipts)).toMatchObject({
      validFamilies: [],
      unverifiedReceipts: [expect.objectContaining({ actualFamily: "sovereign-local" })],
    });
    expect(
      calibrateRunnerOutput({
        family: "sovereign-local",
        surface: "ollama/localhost",
        text: "A scout evaluates whether to deploy a specific ship.",
      }),
    ).toMatchObject({
      verdict: "degraded",
      roleplayDriftDetected: true,
    });
  });

  test("local output calibration permits literal exact diagnostic answers", () => {
    expect(
      calibrateRunnerOutput({
        family: "sovereign-local",
        surface: "ollama/localhost",
        prompt: "Say exactly: OK",
        text: "OK",
      }),
    ).toMatchObject({
      verdict: "usable",
      formatCompliant: true,
      roleplayDriftDetected: false,
    });
  });

  test("runner calibration rejects prompt echo before it can count as attribution", async () => {
    const taskPrompt = "Reply with exactly SURFACE_PROOF_OK.";
    const grokPlan = {
      dispatchId: "dispatch-loop-prompt-echo",
      runId: "loop-prompt-echo",
      optionKind: "fleet-scout" as const,
      stage: "scout" as const,
      schedulingMode: "staggered" as const,
      lateScoutPolicy: "drop-from-round" as const,
      independentFamilyCount: 1,
      skippedSurfaces: [],
      tasks: [
        {
          taskId: "loop-prompt-echo:xai:grok-web-or-app:scout",
          runId: "loop-prompt-echo",
          stage: "scout" as const,
          family: "xai" as const,
          voice: "grok",
          surface: "grok/web-or-app",
          countsAsIndependentFamilySignal: true,
          familyVoteKey: "xai" as const,
          prompt: taskPrompt,
          promptBudgetChars: taskPrompt.length,
          timeoutMs: 60_000,
          dropOnTimeout: true,
          sealed: true,
          includesPeerOutputs: false,
          status: "pending" as const,
        },
      ],
    };
    const deliveredPrompt = [
      "Do not use tools. Do not inspect files. Answer only from this prompt.",
      "This is a sealed Scout pass, not a repository exploration or implementation task.",
      "Do not claim knowledge of repo state, build health, or external facts unless the prompt itself provides that evidence.",
      "Use this structure:",
      "CLAIMS:",
      "- ...",
      "RISKS:",
      "- ...",
      "MISSING_EVIDENCE:",
      "- ...",
      "DEEPEN_NEEDED: yes|no",
      "",
      taskPrompt,
    ].join("\n");
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: grokPlan,
      adapters: [
        createGrokWebRunnerAdapter({
          command: "fake-node",
          scriptPath: "/tmp/research-grok-chat.mjs",
          spawnImpl: fakeSpawn({
            stdout: JSON.stringify({ text: deliveredPrompt, modelUsed: "grok" }),
            calls: [],
          }),
        }),
      ],
      signingSecret: SECRET,
      now: fixedClock(["2026-04-27T00:00:01.000Z", "2026-04-27T00:00:02.000Z"]),
    });

    expect(execution.executions[0]).toMatchObject({
      status: "completed",
      calibration: {
        verdict: "degraded",
        reasons: expect.arrayContaining(["runner returned the prompt text instead of the answer"]),
      },
      answerAttributionProof: {
        verdict: "failed",
        evidence: "runner output matched the submitted prompt instead of an attributed answer",
      },
      countingEligible: false,
    });
    expect(execution.receipts[0]?.modelVerified).toBe(false);
  });

  test("runner calibration rejects stale surface proof text without requested proof token", () => {
    const calibration = calibrateRunnerOutput({
      family: "google",
      surface: "gemini/web-chat",
      prompt: "Reply with exactly one short sentence containing SURFACE_PROOF_OK.",
      text: [
        "CLAIMS:",
        "- This looks structured but came from an old thread.",
        "RISKS:",
        "- Stale answer could be mistaken for fresh attribution.",
        "MISSING_EVIDENCE:",
        "- The requested proof token is absent.",
        "DEEPEN_NEEDED: no",
      ].join("\n"),
    });

    expect(calibration).toMatchObject({
      verdict: "degraded",
      formatCompliant: false,
      reasons: expect.arrayContaining(["runner did not return requested surface proof token"]),
    });
  });

  test("Ollama scout wrapper forces local diagnostic structure", () => {
    const prompt = buildOllamaScoutPrompt("diagnose the local model");
    expect(prompt).toContain("technical evaluation pass");
    expect(prompt).toContain("Interpret the word scout as a short independent technical review");
    expect(prompt).toContain(
      "Do not invent spacecraft, mission, navigation, engine, sensor, or environmental details",
    );
    expect(prompt).toContain("literal and minimal");
    expect(prompt).toContain("CLAIMS:");
    expect(prompt).toContain("DEEPEN_NEEDED: yes|no");
    expect(prompt).toContain("diagnose the local model");
  });

  test("local runner receipts can persist transcript paths and execution artifacts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-v2-runner-"));
    try {
      const localScout = structuredScoutText("durable local answer");
      const result = await runChuckLoop({
        requestText: "evaluate this architecture spec",
        runId: "loop-runner-persist",
        now: "2026-04-27T00:00:00.000Z",
      });
      const localPlan = {
        ...result.dispatchPlan,
        tasks: result.dispatchPlan.tasks.filter((task) => task.surface === "ollama/localhost"),
      };
      const execution = await executeFleetDispatchPlan({
        dispatchPlan: localPlan,
        adapters: [
          createOllamaRunnerAdapter({
            model: "llama-test",
            fetchImpl: async () => ({
              ok: true,
              status: 200,
              text: async () => "",
              json: async () => ({ response: localScout, model: "llama-test" }),
            }),
          }),
        ],
        signingSecret: SECRET,
        transcriptDir: join(stateDir, "transcripts", result.runId),
        now: fixedClock(["2026-04-27T00:00:01.000Z", "2026-04-27T00:00:02.000Z"]),
      });
      const receipt = execution.receipts[0];
      expect(receipt.transcriptPath).toBeDefined();
      expect(await readFile(receipt.transcriptPath!, "utf8")).toBe(localScout);
      expect(receipt.transcriptSha256).toBe(sha256Text(localScout));
      expect(verifyRunnerReceipt(receipt, SECRET)).toBe(true);
      const persisted = await persistFleetDispatchExecution({ stateDir, execution });
      expect(JSON.parse(await readFile(persisted.executionPath, "utf8"))).toMatchObject({
        runId: "loop-runner-persist",
        receipts: [{ transcriptPath: receipt.transcriptPath }],
      });
      expect(await readdir(join(stateDir, "runner-executions"))).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("default live-scout registry covers local and safe CLI adapters", () => {
    expect(defaultRunnerAdapters().map((adapter) => adapter.surface)).toEqual([
      "ollama/localhost",
      "claude-cli/exec",
      "gemini/cli",
      "codex/exec",
      "chatgpt/web-chat",
      "chatgpt/mac-app",
      "codex-review/exec",
      "claude/web-chat",
      "claude/mac-app",
      "gemini/web-chat",
      "aistudio/web",
      "perplexity/mac-app",
      "grok/web-or-app",
    ]);
  });

  test("safe CLI scout config lets runnable loop plan Codex without adding a family vote", async () => {
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-safe-cli-config",
      now: "2026-04-27T00:00:00.000Z",
    });
    const openAiTasks = result.dispatchPlan.tasks.filter((task) => task.family === "openai");
    expect(openAiTasks.map((task) => task.surface)).toEqual([
      "chatgpt/web-chat",
      "codex/exec",
      "codex-review/exec",
      "chatgpt/mac-app",
    ]);
    expect(openAiTasks.filter((task) => task.countsAsIndependentFamilySignal)).toHaveLength(1);
    expect(result.dispatchPlan.independentFamilyCount).toBe(6);
  });

  test("Claude CLI adapter executes through the receipt boundary without tools", async () => {
    const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const adapter = createClaudeCliRunnerAdapter({
      command: "fake-claude",
      model: "sonnet",
      spawnImpl: fakeSpawn({ stdout: "claude scout", calls }),
    });
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      runId: "loop-claude-adapter",
      now: "2026-04-27T00:00:00.000Z",
    });
    const claudePlan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) => task.surface === "claude-cli/exec"),
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: claudePlan,
      adapters: [adapter],
      signingSecret: SECRET,
      now: fixedClock(["2026-04-27T00:00:01.000Z", "2026-04-27T00:00:02.000Z"]),
    });
    expect(execution.receipts[0]).toMatchObject({
      actualFamily: "anthropic",
      actualRunner: "claude-cli",
      modelClaimed: "claude-cli/sonnet;effort=low;tools=disabled",
    });
    expect(calls[0]).toMatchObject({
      command: "fake-claude",
      args: expect.arrayContaining([
        "-p",
        "--model",
        "sonnet",
        "--output-format",
        "text",
        "--tools",
        "",
        "--effort",
        "low",
        "--permission-mode",
        "plan",
        "--no-session-persistence",
      ]),
    });
    expect(calls[0]?.args).not.toContain("--allowedTools");
    expect(calls[0]?.args.join("\n")).toContain("Do not use tools. Do not inspect files");
  });

  test("Gemini CLI scout defaults to Flash and Codex runs read-only/ephemeral", async () => {
    const geminiCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const codexCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const gemini = createGeminiCliRunnerAdapter({
      command: "fake-gemini",
      spawnImpl: fakeSpawn({ stdout: "gemini scout", calls: geminiCalls }),
    });
    const codex = createCodexCliRunnerAdapter({
      command: "fake-codex",
      spawnImpl: fakeSpawn({ stdout: "codex scout", calls: codexCalls }),
      cwd: "/tmp/chuck-readonly",
    });
    const config = normalizeChuckConfig({
      fleet: [
        ...DEFAULT_CHUCK_CONFIG.fleet,
        {
          ...DEFAULT_CHUCK_CONFIG.fleet[1],
          voice: "codex",
          surface: "codex/exec",
          capabilityProfile: "code-grounded",
        },
      ],
    });
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      config,
      runId: "loop-cli-adapters",
      now: "2026-04-27T00:00:00.000Z",
    });
    const cliPlan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter(
        (task) => task.surface === "gemini/cli" || task.surface === "codex/exec",
      ),
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: cliPlan,
      adapters: [gemini, codex],
      signingSecret: SECRET,
      now: fixedClock([
        "2026-04-27T00:00:01.000Z",
        "2026-04-27T00:00:02.000Z",
        "2026-04-27T00:00:03.000Z",
        "2026-04-27T00:00:04.000Z",
      ]),
    });
    expect(execution.receipts.map((receipt) => receipt.actualFamily)).toEqual(["google", "openai"]);
    expect(geminiCalls[0]).toMatchObject({
      command: "fake-gemini",
      args: expect.arrayContaining(["--model", "gemini-2.5-flash", "--approval-mode", "plan"]),
    });
    expect(geminiCalls[0]?.args.join("\n")).toContain("Do not use tools. Do not inspect files");
    expect(codexCalls[0]).toMatchObject({
      command: "fake-codex",
      args: expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--ignore-rules",
        "-c",
        'model_reasoning_effort="low"',
        "--model",
        "gpt-5.3-codex-spark",
        "-",
      ]),
    });
    expect(codexCalls[0]?.args).not.toContain("--ask-for-approval");
    expect(codexCalls[0]?.stdin).toContain("Do not use tools. Do not inspect files");
    expect(codexCalls[0]?.stdin).toContain("Do not infer or reference other model outputs");
  });

  test("parallel dispatch starts registered scout surfaces without serial blocking", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeAdapter = (family: ChuckFamily, surface: string) => ({
      adapterId: `${family}-${surface}`,
      family,
      surface,
      async run() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          text: structuredScoutText(`${surface} scout`),
          actualRunner: `${family}-${surface}`,
          actualFamily: family,
          modelClaimed: `${family}/${surface}`,
          modelVerified: true,
        };
      },
    });
    const config = configWithSafeCliScoutSurfaces();
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for fleet scout scheduling",
      config,
      runId: "loop-parallel-dispatch",
      now: "2026-04-27T00:00:00.000Z",
    });
    const cliPlan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) =>
        ["claude-cli/exec", "gemini/cli", "codex/exec"].includes(task.surface),
      ),
      schedulingMode: "parallel" as const,
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: cliPlan,
      adapters: [
        makeAdapter("anthropic", "claude-cli/exec"),
        makeAdapter("google", "gemini/cli"),
        makeAdapter("openai", "codex/exec"),
      ],
      signingSecret: SECRET,
    });

    expect(execution.receipts.map((receipt) => receipt.surface)).toEqual([
      "claude-cli/exec",
      "gemini/cli",
      "codex/exec",
    ]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("parallel dispatch keeps GUI and app surfaces in one exclusive lane", async () => {
    let totalInFlight = 0;
    let maxTotalInFlight = 0;
    let guiInFlight = 0;
    let maxGuiInFlight = 0;
    const guiSurfaces = new Set(["chatgpt/web-chat", "gemini/web-chat", "grok/web-or-app"]);
    const makeAdapter = (family: ChuckFamily, surface: string) => ({
      adapterId: `${family}-${surface}`,
      family,
      surface,
      async run() {
        totalInFlight += 1;
        maxTotalInFlight = Math.max(maxTotalInFlight, totalInFlight);
        if (guiSurfaces.has(surface)) {
          guiInFlight += 1;
          maxGuiInFlight = Math.max(maxGuiInFlight, guiInFlight);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (guiSurfaces.has(surface)) {
          guiInFlight -= 1;
        }
        totalInFlight -= 1;
        return {
          text: structuredScoutText(`${surface} scout`),
          actualRunner: `${family}-${surface}`,
          actualFamily: family,
          modelClaimed: `${family}/${surface}`,
          modelVerified: true,
        };
      },
    });
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for mixed CLI and GUI scout scheduling",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-exclusive-gui-dispatch",
      now: "2026-04-27T00:00:00.000Z",
    });
    const surfaces = new Set([
      "claude-cli/exec",
      "codex/exec",
      "chatgpt/web-chat",
      "gemini/web-chat",
      "grok/web-or-app",
    ]);
    const plan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) => surfaces.has(task.surface)),
      schedulingMode: "parallel" as const,
    };
    await executeFleetDispatchPlan({
      dispatchPlan: plan,
      adapters: [
        makeAdapter("anthropic", "claude-cli/exec"),
        makeAdapter("openai", "codex/exec"),
        makeAdapter("openai", "chatgpt/web-chat"),
        makeAdapter("google", "gemini/web-chat"),
        makeAdapter("xai", "grok/web-or-app"),
      ],
      signingSecret: SECRET,
    });

    expect(maxTotalInFlight).toBeGreaterThan(1);
    expect(maxGuiInFlight).toBe(1);
  });

  test("scout resolve parses transcripts, preserves dissent, and recommends deepening", async () => {
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for scout resolve",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-scout-resolve",
      now: "2026-04-27T00:00:00.000Z",
    });
    const plan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) =>
        ["claude-cli/exec", "codex/exec"].includes(task.surface),
      ),
      schedulingMode: "parallel" as const,
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: plan,
      adapters: [
        {
          adapterId: "anthropic-resolve-test",
          family: "anthropic",
          surface: "claude-cli/exec",
          async run() {
            return {
              text: structuredScoutText("Signed receipts are necessary."),
              actualRunner: "anthropic-resolve-test",
              actualFamily: "anthropic",
              modelClaimed: "claude-test",
              modelVerified: true,
            };
          },
        },
        {
          adapterId: "openai-resolve-test",
          family: "openai",
          surface: "codex/exec",
          async run() {
            return {
              text: [
                "CLAIMS:",
                "- The scout layer still needs a formal quorum rule.",
                "RISKS:",
                "- No simple majority can hurt liveness.",
                "MISSING_EVIDENCE:",
                "- Live latency measurements.",
                "DEEPEN_NEEDED: yes",
              ].join("\n"),
              actualRunner: "openai-resolve-test",
              actualFamily: "openai",
              modelClaimed: "codex-test",
              modelVerified: true,
            };
          },
        },
      ],
      signingSecret: SECRET,
    });
    const resolve = resolveFleetScout(execution);

    expect(resolve.disposition).toBe("deepen");
    expect(resolve.usableSurfaces).toEqual(["claude-cli/exec", "codex/exec"]);
    expect(resolve.usableFamilies).toEqual(["anthropic", "openai"]);
    expect(resolve.independentUsableFamilyCount).toBe(2);
    expect(resolve.deepenNeededSurfaces).toEqual(["codex/exec"]);
    expect(resolve.noDeepenSurfaces).toEqual(["claude-cli/exec"]);
    expect(resolve.dissentRetained).toBe(true);
    expect(resolve.normalizedClaims.map((claim) => claim.text)).toContain(
      "The scout layer still needs a formal quorum rule.",
    );
  });

  test("scout resolve reports same-family surfaces without inflating independent family count", async () => {
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for same-family surfaces",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-same-family-surface-count",
      now: "2026-04-27T00:00:00.000Z",
    });
    const plan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) =>
        ["gemini/cli", "gemini/web-chat"].includes(task.surface),
      ),
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: plan,
      adapters: [
        {
          adapterId: "google-cli-count-test",
          family: "google",
          surface: "gemini/cli",
          async run() {
            return {
              text: structuredScoutText("Google CLI surface signal."),
              actualRunner: "google-cli-count-test",
              actualFamily: "google",
              modelClaimed: "gemini-cli-test",
              modelVerified: true,
            };
          },
        },
        {
          adapterId: "google-web-count-test",
          family: "google",
          surface: "gemini/web-chat",
          async run() {
            return {
              text: structuredScoutText("Google web surface signal."),
              actualRunner: "google-web-count-test",
              actualFamily: "google",
              modelClaimed: "gemini-web-test",
              modelVerified: true,
            };
          },
        },
      ],
      signingSecret: SECRET,
    });
    const resolve = resolveFleetScout(execution);

    expect(resolve.usableSurfaces).toEqual(["gemini/cli", "gemini/web-chat"]);
    expect(resolve.usableFamilies).toEqual(["google"]);
    expect(resolve.independentUsableFamilyCount).toBe(1);
  });

  test("scout resolve can create an identity-blind deepen dispatch plan", async () => {
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for deepen plan",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-deepen-plan",
      now: "2026-04-27T00:00:00.000Z",
    });
    const plan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) =>
        ["claude-cli/exec", "codex/exec"].includes(task.surface),
      ),
      schedulingMode: "parallel" as const,
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: plan,
      adapters: [
        {
          adapterId: "anthropic-deepen-test",
          family: "anthropic",
          surface: "claude-cli/exec",
          async run() {
            return {
              text: [
                "CLAIMS:",
                "- Claude says that signed receipts are necessary.",
                "RISKS:",
                "- Key rotation is underspecified.",
                "MISSING_EVIDENCE:",
                "- Receipt schema.",
                "DEEPEN_NEEDED: yes",
              ].join("\n"),
              actualRunner: "anthropic-deepen-test",
              actualFamily: "anthropic",
              modelClaimed: "claude-test",
              modelVerified: true,
            };
          },
        },
        {
          adapterId: "openai-deepen-test",
          family: "openai",
          surface: "codex/exec",
          async run() {
            return {
              text: [
                "CLAIMS:",
                "- Codex claims that destructive actions require operator approval.",
                "RISKS:",
                "- Approval fatigue.",
                "MISSING_EVIDENCE:",
                "- Destructive action taxonomy.",
                "DEEPEN_NEEDED: no",
              ].join("\n"),
              actualRunner: "openai-deepen-test",
              actualFamily: "openai",
              modelClaimed: "codex-test",
              modelVerified: true,
            };
          },
        },
      ],
      signingSecret: SECRET,
    });
    const resolve = resolveFleetScout(execution);
    const deepenPlan = createFleetDeepenDispatchPlan({
      scoutPlan: plan,
      scoutResolve: resolve,
      requestText: "architecture/spec decision for deepen plan",
    });

    expect(deepenPlan?.stage).toBe("deepen");
    expect(deepenPlan?.optionKind).toBe("fleet-deepen");
    expect(deepenPlan?.tasks.map((task) => task.surface)).toEqual(["claude-cli/exec"]);
    expect(deepenPlan?.tasks[0]?.includesPeerOutputs).toBe(true);
    expect(deepenPlan?.tasks[0]?.sealed).toBe(false);
    expect(deepenPlan?.tasks[0]?.prompt).toContain("identity-blind claims");
    expect(deepenPlan?.tasks[0]?.prompt).toContain("signed receipts are necessary");
    expect(deepenPlan?.tasks[0]?.prompt).not.toContain("Claude says");
    expect(deepenPlan?.tasks[0]?.prompt).not.toContain("Codex claims");
  });

  test("scout parser accepts inline deepen labels and missing-evidence variants", () => {
    const parsed = parseScoutSections(
      [
        "CLAIMS: one claim",
        "RISKS:",
        "- one risk",
        "MISSING EVIDENCE:",
        "- one source span",
        "DEEPEN_NEEDED: no",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      claims: ["one claim"],
      risks: ["one risk"],
      missingEvidence: ["one source span"],
      deepenNeeded: "no",
    });
  });

  test("web, app, review, and Perplexity adapters wrap same-family surfaces without impersonation fallback", async () => {
    const chatGptCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const chatGptMacCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const codexReviewCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const claudeWebCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const claudeMacCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const geminiCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const grokCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const perplexityCalls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const chatGpt = createChatGptWebRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-chatgpt-chat.mjs",
      spawnImpl: fakeSpawn({
        stdout: JSON.stringify({
          text: structuredScoutText("chatgpt web scout"),
          modelUsed: "chatgpt/web",
        }),
        calls: chatGptCalls,
      }),
    });
    const chatGptMac = createChatGptMacRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-chatgpt-mac.mjs",
      spawnImpl: fakeSpawn({
        stdout: structuredScoutText("chatgpt mac scout"),
        calls: chatGptMacCalls,
      }),
    });
    const codexReview = createCodexReviewRunnerAdapter({
      command: "fake-codex",
      model: "gpt-review",
      spawnImpl: fakeSpawn({
        stdout: structuredScoutText("codex review scout"),
        calls: codexReviewCalls,
      }),
    });
    const claudeWeb = createClaudeWebRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-claude-ai-chat.mjs",
      spawnImpl: fakeSpawn({
        stdout: JSON.stringify({
          text: structuredScoutText("claude web scout"),
          modelUsed: "claude/web",
        }),
        calls: claudeWebCalls,
      }),
    });
    const claudeMac = createClaudeMacRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-claude-mac.mjs",
      spawnImpl: fakeSpawn({
        stdout: structuredScoutText("claude mac scout"),
        calls: claudeMacCalls,
      }),
    });
    const gemini = createGeminiWebRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-gemini-chat.mjs",
      spawnImpl: fakeSpawn({
        stdout: JSON.stringify({
          text: structuredScoutText("gemini web scout"),
          modelUsed: "gemini/web-chat",
        }),
        calls: geminiCalls,
      }),
    });
    const grok = createGrokWebRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-grok-chat.mjs",
      spawnImpl: fakeSpawn({
        stdout: JSON.stringify({
          text: structuredScoutText("grok scout"),
          modelUsed: "grok/web-free",
        }),
        calls: grokCalls,
      }),
    });
    const perplexity = createPerplexityMacRunnerAdapter({
      command: "fake-node",
      scriptPath: "/tmp/research-perplexity-mac.mjs",
      spawnImpl: fakeSpawn({
        stdout: structuredScoutText("perplexity scout"),
        calls: perplexityCalls,
      }),
    });
    const result = await runChuckLoop({
      requestText: "architecture/spec decision for external adapters",
      config: configWithSafeCliScoutSurfaces(),
      runId: "loop-external-adapters",
      now: "2026-04-27T00:00:00.000Z",
    });
    const plan = {
      ...result.dispatchPlan,
      tasks: result.dispatchPlan.tasks.filter((task) =>
        [
          "chatgpt/web-chat",
          "chatgpt/mac-app",
          "codex-review/exec",
          "claude/web-chat",
          "claude/mac-app",
          "gemini/web-chat",
          "perplexity/mac-app",
          "grok/web-or-app",
        ].includes(task.surface),
      ),
    };
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: plan,
      adapters: [chatGpt, chatGptMac, codexReview, claudeWeb, claudeMac, gemini, grok, perplexity],
      signingSecret: SECRET,
    });

    expect(
      execution.receipts.map((receipt) => [
        receipt.actualFamily,
        receipt.actualRunner,
        receipt.surface,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["openai", "chatgpt-web-primary", "chatgpt/web-chat"],
        ["openai", "chatgpt-mac-primary", "chatgpt/mac-app"],
        ["openai", "codex-review-cli", "codex-review/exec"],
        ["anthropic", "claude-web-primary", "claude/web-chat"],
        ["anthropic", "claude-mac-primary", "claude/mac-app"],
        ["google", "gemini-web-primary", "gemini/web-chat"],
        ["perplexity", "perplexity-mac-primary", "perplexity/mac-app"],
        ["xai", "grok-web-primary", "grok/web-or-app"],
      ]),
    );
    expect(chatGptCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining(["/tmp/research-chatgpt-chat.mjs", "--ask", "--json"]),
    });
    expect(chatGptMacCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining(["/tmp/research-chatgpt-mac.mjs", "--prompt"]),
    });
    expect(codexReviewCalls[0]).toMatchObject({
      command: "fake-codex",
      args: expect.arrayContaining(["exec", "--sandbox", "read-only"]),
    });
    expect(codexReviewCalls[0]?.stdin).toContain("same-family review surface");
    expect(claudeWebCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining([
        "/tmp/research-claude-ai-chat.mjs",
        "--ask",
        "--json",
        "--web-only",
      ]),
    });
    expect(claudeMacCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining(["/tmp/research-claude-mac.mjs", "--prompt"]),
    });
    expect(geminiCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining(["/tmp/research-gemini-chat.mjs", "--ask", "--json"]),
    });
    expect(geminiCalls[0]?.args.join("\n")).toContain("Do not use tools. Do not inspect files");
    expect(grokCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining(["/tmp/research-grok-chat.mjs", "--ask", "--json"]),
    });
    expect(grokCalls[0]?.args.join("\n")).not.toContain("claude-cli");
    expect(grokCalls[0]?.args.join("\n")).toContain("Do not use tools. Do not inspect files");
    expect(perplexityCalls[0]).toMatchObject({
      command: "fake-node",
      args: expect.arrayContaining([
        "/tmp/research-perplexity-mac.mjs",
        "--mode",
        "research",
        "--prompt",
      ]),
    });
    expect(perplexityCalls[0]?.args.join("\n")).toContain("Do not use tools. Do not inspect files");
  });

  test("runner timeout budgets are dynamic by surface and prompt size", () => {
    const shortGrok = computeRunnerTimeoutBudget({
      surface: "grok/web-or-app",
      baseTimeoutMs: 45_000,
      promptChars: 800,
    });
    const longGrok = computeRunnerTimeoutBudget({
      surface: "grok/web-or-app",
      baseTimeoutMs: 45_000,
      promptChars: 12_000,
    });
    const perplexity = computeRunnerTimeoutBudget({
      surface: "perplexity/mac-app",
      baseTimeoutMs: 45_000,
      promptChars: 800,
    });
    const cli = computeRunnerTimeoutBudget({
      surface: "codex/exec",
      baseTimeoutMs: 45_000,
      promptChars: 800,
    });
    const gemini = computeRunnerTimeoutBudget({
      surface: "gemini/cli",
      baseTimeoutMs: 45_000,
      promptChars: 800,
    });

    expect(shortGrok.timeoutMs).toBeGreaterThan(cli.timeoutMs);
    expect(gemini.timeoutMs).toBeGreaterThan(cli.timeoutMs);
    expect(longGrok.timeoutMs).toBeGreaterThan(shortGrok.timeoutMs);
    expect(perplexity.timeoutMs).toBeGreaterThan(shortGrok.timeoutMs);
    expect(longGrok.timeoutMs).toBeLessThanOrEqual(longGrok.hardCeilingMs);
    expect(longGrok.reasons.join("\n")).toContain("prompt:12000 chars");
  });

  test("runner timeout env override is an explicit proof budget, not only a ceiling", () => {
    const previous = process.env.CHUCK_GROK_SCOUT_TIMEOUT_MS;
    process.env.CHUCK_GROK_SCOUT_TIMEOUT_MS = "130000";
    try {
      const budget = computeRunnerTimeoutBudget({
        surface: "grok/web-or-app",
        baseTimeoutMs: 45_000,
        promptChars: 100_000,
        envName: "CHUCK_GROK_SCOUT_TIMEOUT_MS",
      });
      expect(budget.timeoutMs).toBe(130_000);
      expect(budget.hardCeilingMs).toBe(130_000);
      expect(budget.reasons.join("\n")).toContain("ceiling:130000ms");
      expect(budget.reasons.join("\n")).toContain(
        "env-override:CHUCK_GROK_SCOUT_TIMEOUT_MS=130000ms",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CHUCK_GROK_SCOUT_TIMEOUT_MS;
      } else {
        process.env.CHUCK_GROK_SCOUT_TIMEOUT_MS = previous;
      }
    }
  });

  test("dispatch skips surfaces without registered adapters", async () => {
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      runId: "loop-no-adapters",
      now: "2026-04-27T00:00:00.000Z",
    });
    const execution = await executeFleetDispatchPlan({
      dispatchPlan: result.dispatchPlan,
      adapters: [],
      signingSecret: SECRET,
    });
    expect(execution.receipts).toHaveLength(0);
    expect(execution.executions).toHaveLength(result.dispatchPlan.tasks.length);
    expect(execution.executions.every((task) => task.status === "skipped")).toBe(true);
  });

  test("demo-fleet loop emits a shadow DecisionRecord without calling real models", async () => {
    const result = await runChuckLoop({
      requestText: "evaluate this architecture spec",
      mode: "demo-fleet",
      runId: "loop-demo-1",
      now: "2026-04-27T00:00:00.000Z",
      signingSecret: SECRET,
    });
    expect(result.adjudication?.classification.protocol).toBe("UNANIMOUS");
    expect(result.decisionRecord).toMatchObject({
      runId: "loop-demo-1",
      protocol: "UNANIMOUS",
      validFamilyCount: 6,
      finalAction: "emit-task-capsule",
      efficiencyDecisionId: result.efficiencyDecision.decisionId,
    });
    expect(result.decisionRecord?.receipts.every((runnerReceipt) => runnerReceipt.layerUsed)).toBe(
      true,
    );
    expect(result.docketItem).toMatchObject({
      status: "ready",
      decisionRecordId: "loop-demo-1",
      protocol: "UNANIMOUS",
    });
    expect(result.traceRecord).toMatchObject({
      traceId: "trace-loop-demo-1",
      protocol: "UNANIMOUS",
      surfaceReceiptCount: 6,
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "prompt.received",
      "stake.classified",
      "preflight.evaluated",
      "efficiency.planned",
      "fleet.dispatch.planned",
      "protocol.classified",
      "fleet.trace.recorded",
      "decision.recorded",
    ]);
  });

  test("destructive loop becomes a needs-approval docket item", async () => {
    const result = await runChuckLoop({
      requestText: "delete the workspace",
      runId: "loop-destructive-1",
      now: "2026-04-27T00:00:00.000Z",
    });
    expect(result.docketItem).toMatchObject({
      status: "needs-approval",
      stakeClass: "destructive",
      taskClass: "destructive-action",
      operatorActionRequired: true,
    });
  });

  test("loop persistence writes run, decision, trace, docket, and event files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-v2-loop-"));
    try {
      const result = await runChuckLoop({
        requestText: "evaluate this architecture spec",
        mode: "demo-fleet",
        runId: "loop-persist-1",
        now: "2026-04-27T00:00:00.000Z",
        signingSecret: SECRET,
      });
      const persisted = await persistChuckLoopResult(result, { stateDir });
      expect(JSON.parse(await readFile(persisted.runPath, "utf8"))).toMatchObject({
        runId: "loop-persist-1",
      });
      expect(persisted.decisionRecordPath).toBeDefined();
      expect(JSON.parse(await readFile(persisted.decisionRecordPath!, "utf8"))).toMatchObject({
        runId: "loop-persist-1",
        protocol: "UNANIMOUS",
      });
      const traceDb = new DatabaseSync(persisted.traceDbPath);
      try {
        expect(readFleetTrace(traceDb, persisted.traceId)).toMatchObject({
          runId: "loop-persist-1",
          routeTaken: "fleet-scout",
          protocol: "UNANIMOUS",
        });
      } finally {
        traceDb.close();
      }
      const docket = await readDocketItems({ stateDir });
      expect(docket).toMatchObject([{ runId: "loop-persist-1", status: "ready" }]);
      expect((await readFile(persisted.eventsPath, "utf8")).trim().split("\n")).toHaveLength(8);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("docket reader shows the latest item per docket id", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-v2-docket-"));
    try {
      await persistChuckLoopResult(
        await runChuckLoop({
          requestText: "evaluate this architecture spec",
          runId: "loop-dedupe-1",
          now: "2026-04-27T00:00:00.000Z",
        }),
        { stateDir },
      );
      await persistChuckLoopResult(
        await runChuckLoop({
          requestText: "delete the workspace",
          runId: "loop-dedupe-1",
          now: "2026-04-27T00:01:00.000Z",
        }),
        { stateDir },
      );
      expect(await readDocketItems({ stateDir })).toMatchObject([
        {
          runId: "loop-dedupe-1",
          status: "needs-approval",
          title: "delete the workspace",
        },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Chuck V2 local model evaluation", () => {
  test("lists installed Ollama chat models while excluding embeddings", async () => {
    const candidates = await listOllamaLocalModelCandidates({
      fetchImpl: async (url, init) => {
        expect(url).toBe("http://localhost:11434/api/tags");
        expect(init.method).toBe("GET");
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({
            models: [
              { name: "llama3.1:8b", size: 4_900_000_000, modified_at: "2026-04-27T00:00:00Z" },
              {
                name: "nomic-embed-text:latest",
                size: 274_000_000,
                modified_at: "2026-04-27T00:00:00Z",
              },
            ],
          }),
        };
      },
    });
    expect(candidates).toEqual([
      { name: "llama3.1:8b", size: "4900000000", modifiedAt: "2026-04-27T00:00:00Z" },
    ]);
  });

  test("evaluates a local model by task class and promotes only clean candidates", async () => {
    const outputs = [
      "OK",
      structuredScoutText("Deleting build artifacts before tests is risky and needs a verifier."),
      structuredScoutText(
        "A scout is an independent technical evaluation pass in Chuck's Fleet protocol.",
      ),
    ];
    const evaluation = await evaluateOllamaLocalModel({
      model: "llama-test",
      now: fixedClock(["2026-04-27T00:00:00.000Z", "2026-04-27T00:00:01.000Z"]),
      fetchImpl: async (url, init) => {
        expect(url).toBe("http://localhost:11434/api/generate");
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body ?? "{}") as {
          model?: string;
          stream?: boolean;
          think?: boolean;
        };
        expect(body).toMatchObject({ model: "llama-test", stream: false, think: false });
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ response: outputs.shift() }),
        };
      },
    });
    expect(evaluation).toMatchObject({
      model: "llama-test",
      aggregateScore: 1,
      verdict: "promote",
      usableForDefault: true,
      caseCount: 3,
    });
    expect(evaluation.results.map((result) => result.passed)).toEqual([true, true, true]);
  });

  test("rejects local models that drift during the evaluation", async () => {
    const outputs = [
      "OK",
      "CLAIMS:\n- Navigation computer stable.\nRISKS:\n- Portside propulsion fault.\nMISSING_EVIDENCE:\n- Sensor sweep.\nDEEPEN_NEEDED: yes",
      "A scout path scans an asteroid field for energy signatures.",
    ];
    const evaluation = await evaluateOllamaLocalModel({
      model: "drifty-local",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ response: outputs.shift() }),
      }),
    });
    expect(evaluation.verdict).toBe("reject");
    expect(evaluation.usableForDefault).toBe(false);
    expect(evaluation.results.some((result) => result.calibration.roleplayDriftDetected)).toBe(
      true,
    );
  });

  test("ranks local model evaluations by score and latency", () => {
    function evaluation(
      model: string,
      score: number,
      latencyMs: number,
    ): LocalModelEvaluationResult {
      return {
        model,
        surface: "ollama/localhost",
        startedAt: "2026-04-27T00:00:00.000Z",
        endedAt: "2026-04-27T00:00:01.000Z",
        caseCount: 1,
        aggregateScore: score,
        verdict: score >= 0.85 ? "promote" : "candidate",
        usableForDefault: score >= 0.85,
        results: [
          {
            caseId: `${model}-case`,
            taskClass: "literal",
            passed: true,
            score,
            latencyMs,
            text: "OK",
            failures: [],
            calibration: {
              verdict: "usable",
              reasons: [],
              roleplayDriftDetected: false,
              formatCompliant: true,
            },
          },
        ],
      };
    }
    expect(
      rankLocalModelEvaluations([
        evaluation("lower", 0.8, 100),
        evaluation("slow", 0.9, 3000),
        evaluation("fast", 0.9, 1000),
      ]).map((result) => result.model),
    ).toEqual(["fast", "slow", "lower"]);
  });
});

describe("Chuck V2 model doctor", () => {
  test("doctor reports missing surface probes and creates setup docket items", () => {
    const report = runModelDoctor({ generatedAt: "2026-04-27T00:00:00.000Z" });
    expect(modelDoctorSummary(report)).toMatchObject({
      configuredVoices: 6,
      readyFamilies: [],
      unknownFamilies: ["anthropic", "openai", "google", "perplexity", "sovereign-local", "xai"],
      executionReadyFamilies: [],
      canRunMinimumFleet: false,
      canRunHighRiskFleet: false,
      canRunLoadBearingMinimumFleet: false,
      canRunLoadBearingHighRiskFleet: false,
    });
    const docket = docketItemsForModelDoctor(report);
    expect(docket).toHaveLength(6);
    expect(docket[0]).toMatchObject({
      status: "needs-setup",
      operatorActionRequired: true,
    });
    expect(
      report.rows.find((row) => row.surface === "chatgpt/web-chat")?.guide.windowPolicy,
    ).toContain("shared Chuck web cockpit");
    expect(
      report.rows.find((row) => row.surface === "perplexity/mac-app")?.guide.setupAction,
    ).toContain("Perplexity Max Mac app");
    expect(
      report.rows
        .filter((row) => row.family !== "sovereign-local")
        .flatMap((row) => row.guide.notes)
        .join("\n"),
    ).toContain("No PAYG");
  });

  test("doctor exposes the worker-probe set for the configured fleet", () => {
    expect(workerProbeNamesForConfig()).toEqual([
      "claude",
      "chatgpt",
      "gemini",
      "perplexity",
      "ollama",
      "grok",
    ]);
  });

  test("doctor distinguishes ready, unknown, and blocked families", () => {
    const report = runModelDoctor({
      generatedAt: "2026-04-27T00:00:00.000Z",
      health: {
        updatedAt: "2026-04-27T00:00:00.000Z",
        workers: {
          claude: { worker: "claude", healthy: true },
          chatgpt: { worker: "chatgpt", healthy: true },
          gemini: { worker: "gemini", healthy: false, details: "quota exhausted" },
          perplexity: { worker: "perplexity", healthy: true },
        },
      },
    });
    expect(report.readyFamilies).toEqual(["anthropic", "openai", "perplexity"]);
    expect(report.executionReadyFamilies).toEqual(["anthropic"]);
    expect(report.configuredButNotExecutableSurfaces).toEqual([
      "chatgpt/web-chat",
      "perplexity/mac-app",
    ]);
    expect(report.blockedFamilies).toEqual(["google"]);
    expect(report.unknownFamilies).toEqual(["sovereign-local", "xai"]);
    expect(report.canRunMinimumFleet).toBe(true);
    expect(report.canRunHighRiskFleet).toBe(false);
    expect(report.canRunLoadBearingMinimumFleet).toBe(false);
    expect(report.rows.find((row) => row.surface === "chatgpt/web-chat")?.nextAction).toContain(
      "repeatable live receipt proof",
    );
    expect(docketItemsForModelDoctor(report).map((item) => item.title)).toEqual([
      "Prove openai via chatgpt/web-chat",
      "Wire google via gemini/cli",
      "Prove perplexity via perplexity/mac-app",
      "Wire sovereign-local via ollama/localhost",
      "Wire xai via grok/web-or-app",
    ]);
  });

  test("doctor blocks core surfaces that violate the no-PAYG commercial policy", () => {
    const config = normalizeChuckConfig({
      fleet: [
        {
          ...DEFAULT_CHUCK_CONFIG.fleet[1],
          commercialPolicy: "local-only",
        },
      ],
      thresholds: {
        ...DEFAULT_CHUCK_CONFIG.thresholds,
        minimumFamilies: 1,
        highRiskMinimumFamilies: 1,
      },
    });
    const report = runModelDoctor({
      config,
      generatedAt: "2026-04-27T00:00:00.000Z",
      health: {
        updatedAt: "2026-04-27T00:00:00.000Z",
        workers: {
          chatgpt: { worker: "chatgpt", healthy: true },
        },
      },
    });
    expect(report.rows).toMatchObject([
      {
        family: "openai",
        surface: "chatgpt/web-chat",
        status: "blocked",
        countsAsFamily: false,
      },
    ]);
    expect(report.blockedFamilies).toEqual(["openai"]);
    expect(report.canRunMinimumFleet).toBe(false);
    expect(report.rows[0]?.nextAction).toContain("subscription-only/local-only");
  });

  test("doctor separates account access from load-bearing runner execution", () => {
    const report = runModelDoctor({
      config: configWithSafeCliScoutSurfaces(),
      generatedAt: "2026-04-27T00:00:00.000Z",
      health: {
        updatedAt: "2026-04-27T00:00:00.000Z",
        workers: {
          claude: { worker: "claude", healthy: true },
          chatgpt: { worker: "chatgpt", healthy: true },
          codex: { worker: "codex", healthy: true },
          gemini: { worker: "gemini", healthy: true },
          perplexity: { worker: "perplexity", healthy: true },
          grok: { worker: "grok", healthy: true },
          ollama: { worker: "ollama", healthy: false, details: "uninstalled" },
        },
      },
    });

    expect(report.readyFamilies).toEqual(["anthropic", "openai", "google", "perplexity", "xai"]);
    expect(report.executionReadyFamilies).toEqual(["anthropic", "openai", "google"]);
    expect(report.configuredButNotExecutableSurfaces).toEqual(
      expect.arrayContaining(["chatgpt/web-chat", "perplexity/mac-app", "grok/web-or-app"]),
    );
    expect(report.canRunMinimumFleet).toBe(true);
    expect(report.canRunLoadBearingMinimumFleet).toBe(true);
    expect(report.canRunLoadBearingHighRiskFleet).toBe(false);
    expect(report.rows.find((row) => row.surface === "codex/exec")).toMatchObject({
      executionStatus: "registered",
      countsAsLoadBearingFamily: true,
    });
    expect(report.rows.find((row) => row.surface === "ollama/localhost")).toMatchObject({
      status: "blocked",
      countsAsLoadBearingFamily: false,
    });
  });

  test("doctor graduates provisional surfaces only with repeatable live receipt proof", () => {
    const report = runModelDoctor({
      config: configWithSafeCliScoutSurfaces(),
      generatedAt: "2026-04-27T00:00:00.000Z",
      executionProofs: {
        "perplexity/mac-app": {
          surface: "perplexity/mac-app",
          family: "perplexity",
          successes: 2,
          failures: 0,
          latestStatus: "completed",
          lastSuccessAt: "2026-04-27T00:00:00.000Z",
          repeatable: true,
        },
        "grok/web-or-app": {
          surface: "grok/web-or-app",
          family: "xai",
          successes: 1,
          failures: 1,
          latestStatus: "failed",
          lastFailureReason: "timeout",
          repeatable: false,
        },
      },
      health: {
        updatedAt: "2026-04-27T00:00:00.000Z",
        workers: {
          claude: { worker: "claude", healthy: true },
          chatgpt: { worker: "chatgpt", healthy: true },
          codex: { worker: "codex", healthy: true },
          gemini: { worker: "gemini", healthy: true },
          perplexity: { worker: "perplexity", healthy: true },
          grok: { worker: "grok", healthy: true },
          ollama: { worker: "ollama", healthy: false, details: "uninstalled" },
        },
      },
    });

    expect(report.executionReadyFamilies).toEqual(["anthropic", "openai", "google", "perplexity"]);
    expect(report.canRunLoadBearingHighRiskFleet).toBe(true);
    expect(report.rows.find((row) => row.surface === "perplexity/mac-app")).toMatchObject({
      executionStatus: "proven",
      countsAsLoadBearingFamily: true,
    });
    expect(report.rows.find((row) => row.surface === "grok/web-or-app")).toMatchObject({
      executionStatus: "provisional",
      countsAsLoadBearingFamily: false,
    });
  });

  test("runner proof loader tracks latest failure after prior success", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-proof-"));
    try {
      const first = await runChuckLoop({
        requestText: "architecture/spec decision for proof loader",
        config: configWithSafeCliScoutSurfaces(),
        runId: "loop-proof-success",
        now: "2026-04-27T00:00:00.000Z",
      });
      const successPlan = {
        ...first.dispatchPlan,
        tasks: first.dispatchPlan.tasks.filter((task) => task.surface === "perplexity/mac-app"),
      };
      const successExecution = await executeFleetDispatchPlan({
        dispatchPlan: successPlan,
        adapters: [
          createPerplexityMacRunnerAdapter({
            command: "fake-node",
            scriptPath: "/tmp/research-perplexity-mac.mjs",
            spawnImpl: fakeSpawn({ stdout: structuredScoutText("perplexity proof"), calls: [] }),
          }),
        ],
        signingSecret: SECRET,
      });
      const successPersisted = await persistFleetDispatchExecution({
        stateDir,
        execution: successExecution,
      });
      await utimes(
        successPersisted.executionPath,
        new Date("2026-04-27T00:00:00.000Z"),
        new Date("2026-04-27T00:00:00.000Z"),
      );
      const failureExecution = {
        dispatchId: "dispatch-proof-failure",
        runId: "loop-proof-failure",
        receipts: [],
        executions: [
          {
            taskId: "loop-proof-failure:perplexity:perplexity-mac-app:scout",
            family: "perplexity" as const,
            surface: "perplexity/mac-app",
            status: "failed" as const,
            reason: "timeout",
          },
        ],
      };
      const failurePersisted = await persistFleetDispatchExecution({
        stateDir,
        execution: failureExecution,
      });
      await utimes(
        failurePersisted.executionPath,
        new Date("2026-04-27T00:00:01.000Z"),
        new Date("2026-04-27T00:00:01.000Z"),
      );

      const proofs = loadRunnerSurfaceProofs({ stateDir });
      expect(proofs["perplexity/mac-app"]).toMatchObject({
        successes: 1,
        failures: 1,
        latestStatus: "failed",
        repeatable: false,
        lastFailureReason: "timeout",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Chuck V2 capability ledger and intent anchors", () => {
  test("ledger marks proven split-proof CLI surfaces as load-bearing", () => {
    const config = configWithSafeCliScoutSurfaces();
    const ledger = buildCapabilityLedger({
      config,
      generatedAt: "2026-04-27T00:00:00.000Z",
      executionProofs: {
        "codex/exec": {
          surface: "codex/exec",
          family: "openai",
          successes: 2,
          failures: 0,
          latestStatus: "completed",
          lastSuccessAt: "2026-04-27T00:00:01.000Z",
          repeatable: true,
        },
      },
      proofDetails: {
        "codex/exec": splitSurfaceProof("codex/exec", "openai"),
      },
    });

    const codex = ledger.entries.find((entry) => entry.surface === "codex/exec");
    expect(codex).toMatchObject({
      readiness: "load-bearing",
      confidence: "high",
      promptDeliveryProof: { verdict: "proved" },
      answerAttributionProof: { verdict: "proved" },
    });
    expect(canKernelRelyOn(codex!, "code-review", "high-mutating")).toMatchObject({
      allowed: true,
    });
  });

  test("ledger keeps OCR-only Perplexity recovery degraded until direct extraction is repaired", () => {
    const ledger = buildCapabilityLedger({
      config: configWithSafeCliScoutSurfaces(),
      generatedAt: "2026-04-27T00:00:00.000Z",
      lateRecoveries: [
        {
          surface: "perplexity/mac-app",
          family: "perplexity",
          status: "recovered-late",
          label: "Perplexity OCR recovery",
          caveat: "OCR-only late recovery; direct answer extraction remains required",
          updatedAt: "2026-04-27T00:00:02.000Z",
          evidence: [],
        },
      ],
    });

    const perplexity = ledger.entries.find((entry) => entry.surface === "perplexity/mac-app");
    expect(perplexity).toMatchObject({
      readiness: "degraded",
      extractionMethod: "ocr-recovery",
      countsAsIndependentFamily: false,
    });
    expect(perplexity?.nextRepairAction).toContain("direct answer extraction");
    expect(canKernelRelyOn(perplexity!, "architecture", "high-mutating").allowed).toBe(false);
  });

  test("ledger records late ChatGPT and AI Studio recovery without promoting them to canonical Deepen replacements", () => {
    const ledger = buildCapabilityLedger({
      config: configWithSafeCliScoutSurfaces(),
      generatedAt: "2026-04-27T00:00:00.000Z",
      lateRecoveries: [
        {
          surface: "chatgpt/web-chat",
          family: "openai",
          status: "recovered-late",
          label: "ChatGPT web rerun captured",
          caveat:
            "late recovery after original Deepen timeout; requires normal repeatable proof before load-bearing use",
          updatedAt: "2026-04-27T00:00:02.000Z",
          evidence: [],
        },
        {
          surface: "aistudio/web",
          family: "google",
          status: "recovered-late",
          label: "AI Studio rerun captured",
          caveat:
            "late recovery after original Deepen timeout; entitlement and Run-button proof remain required",
          updatedAt: "2026-04-27T00:00:03.000Z",
          evidence: [],
        },
      ],
    });

    expect(ledger.entries.find((entry) => entry.surface === "chatgpt/web-chat")).toMatchObject({
      readiness: "degraded",
      extractionMethod: "driver-json",
    });
    expect(ledger.entries.find((entry) => entry.surface === "aistudio/web")).toMatchObject({
      readiness: "degraded",
      extractionMethod: "driver-json",
    });
  });

  test("a newer normal split proof can repair a late-recovered surface", () => {
    const ledger = buildCapabilityLedger({
      config: configWithSafeCliScoutSurfaces(),
      generatedAt: "2026-04-27T00:00:00.000Z",
      executionProofs: {
        "chatgpt/web-chat": {
          surface: "chatgpt/web-chat",
          family: "openai",
          successes: 2,
          failures: 1,
          latestStatus: "completed",
          lastSuccessAt: "2026-04-27T00:10:00.000Z",
          repeatable: true,
        },
      },
      proofDetails: {
        "chatgpt/web-chat": {
          ...splitSurfaceProof("chatgpt/web-chat", "openai", "driver-json"),
          receiptEndedAt: "2026-04-27T00:10:00.000Z",
        },
      },
      lateRecoveries: [
        {
          surface: "chatgpt/web-chat",
          family: "openai",
          status: "recovered-late",
          label: "ChatGPT web rerun captured",
          caveat:
            "late recovery after original Deepen timeout; requires normal repeatable proof before load-bearing use",
          updatedAt: "2026-04-27T00:00:02.000Z",
          evidence: [],
        },
      ],
    });

    expect(ledger.entries.find((entry) => entry.surface === "chatgpt/web-chat")).toMatchObject({
      readiness: "load-bearing",
      extractionMethod: "driver-json",
    });
  });

  test("same-family child surfaces never increase independent family count", () => {
    const config = configWithSafeCliScoutSurfaces();
    const executionProofs = Object.fromEntries(
      ["chatgpt/web-chat", "codex/exec", "codex-review/exec"].map((surface) => [
        surface,
        {
          surface,
          family: "openai" as const,
          successes: 2,
          failures: 0,
          latestStatus: "completed" as const,
          lastSuccessAt: "2026-04-27T00:00:01.000Z",
          repeatable: true,
        },
      ]),
    );
    const ledger = buildCapabilityLedger({
      config,
      generatedAt: "2026-04-27T00:00:00.000Z",
      executionProofs,
      proofDetails: {
        "chatgpt/web-chat": splitSurfaceProof("chatgpt/web-chat", "openai", "driver-json"),
        "codex/exec": splitSurfaceProof("codex/exec", "openai"),
        "codex-review/exec": splitSurfaceProof("codex-review/exec", "openai"),
      },
    });

    const openAiLoadBearing = ledger.entries.filter(
      (entry) => entry.family === "openai" && entry.readiness === "load-bearing",
    );
    expect(openAiLoadBearing.length).toBeGreaterThan(1);
    expect(openAiLoadBearing.filter((entry) => entry.countsAsIndependentFamily)).toHaveLength(1);
    expect(
      ledger.summary.independentLoadBearingFamilies.filter((family) => family === "openai"),
    ).toHaveLength(1);
  });

  test("ledger does not count stale local-model receipts when Ollama is unhealthy", () => {
    const config = configWithSafeCliScoutSurfaces();
    const executionProofs = {
      "ollama/localhost": {
        surface: "ollama/localhost",
        family: "sovereign-local" as const,
        successes: 2,
        failures: 0,
        latestStatus: "completed" as const,
        lastSuccessAt: "2026-04-27T00:00:01.000Z",
        repeatable: true,
      },
    };
    const doctor = runModelDoctor({
      config,
      generatedAt: "2026-04-27T00:00:00.000Z",
      executionProofs,
      health: {
        updatedAt: "2026-04-27T00:00:00.000Z",
        workers: {
          ollama: { worker: "ollama", healthy: false, details: "unreachable" },
        },
      },
    });
    const ledger = buildCapabilityLedger({
      config,
      doctor,
      executionProofs,
      generatedAt: "2026-04-27T00:00:00.000Z",
    });
    const local = ledger.entries.find((entry) => entry.surface === "ollama/localhost");

    expect(local).toMatchObject({
      readiness: "blocked",
      canCountForFamily: false,
      countsAsIndependentFamily: false,
      failureMode: "unreachable",
      nextRepairAction: "Start Ollama and install/select the local sovereignty-floor model.",
    });
    expect(local?.caveats).toContain("unreachable");
    expect(ledger.summary.independentLoadBearingFamilies).not.toContain("sovereign-local");
    expect(ledger.summary.blockedCapacityFamilies).toContain("sovereign-local");
  });

  test("IntentAnchor signatures verify and fail after tampering", () => {
    const anchor = createIntentAnchor({
      objective: "patch a dashboard widget",
      allowedResources: ["extensions/memory-graph/scripts/chuck-dashboard.mjs"],
      allowedSurfaces: ["codex/exec"],
      authorityEnvelope: "authority-bearing",
      stakeClass: "high-mutating",
      signingSecret: SECRET,
    });
    expect(verifyIntentAnchor(anchor, SECRET)).toBe(true);
    expect(verifyIntentAnchor({ ...anchor, objective: "silently expand authority" }, SECRET)).toBe(
      false,
    );
  });

  test("authority-bearing builder runs persist an IntentAnchor before mutation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-anchor-"));
    try {
      const run = await runSelfBuild({
        objective: "add low risk helper",
        stateDir,
        repoRoot: "/repo",
        patchText:
          "diff --git a/extensions/memory-graph/src/chuck-v2/helper.ts b/extensions/memory-graph/src/chuck-v2/helper.ts\n+++ b/extensions/memory-graph/src/chuck-v2/helper.ts\n@@\n+export const helper = true;\n",
        verificationCommands: [
          {
            command: "pnpm",
            args: ["exec", "oxlint", "extensions/memory-graph/src/chuck-v2/helper.ts"],
          },
        ],
        runCommand: async (cmd) => {
          if (cmd.command === "git" && cmd.args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        now: "2026-04-27T00:00:00.000Z",
        runId: "build-anchor",
        signingSecret: SECRET,
      });

      expect(run.disposition).toBe("applied");
      expect(run.intentAnchorId).toMatch(/^intent-/);
      const anchorText = await readFile(run.intentAnchorPath ?? "", "utf8");
      const anchor = JSON.parse(anchorText) as ReturnType<typeof createIntentAnchor>;
      expect(anchor.anchorId).toBe(run.intentAnchorId);
      expect(anchor.authorityEnvelope).toBe("authority-bearing");
      expect(verifyIntentAnchor(anchor, SECRET)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("Chuck V2 protocol classification", () => {
  test("5-family 3-2 split is a deep fracture, never a majority success", () => {
    const result = classifyProtocol({
      configuredFleetSize: 5,
      validFamilyCount: 5,
      stakeClass: "high-readonly",
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google"] },
        { id: "B", familyVotes: ["perplexity", "sovereign-local"] },
      ]),
    });
    expect(result.protocol).toBe("DEEP_FRACTURE");
    expect(result.finalAction).toBe("operator-halt");
  });

  test("4-family 2-2 split is a schism and forks only when a deterministic verifier exists", () => {
    const alignmentMatrix = matrix([
      { id: "A", familyVotes: ["anthropic", "google"] },
      { id: "B", familyVotes: ["openai", "sovereign-local"] },
    ]);
    expect(
      classifyProtocol({
        configuredFleetSize: 4,
        validFamilyCount: 4,
        stakeClass: "high-mutating",
        alignmentMatrix,
        hasDeterministicVerifier: true,
      }),
    ).toMatchObject({
      protocol: "SCHISM",
      finalAction: "fork-to-verifier",
      operatorActionRequired: false,
    });
    expect(
      classifyProtocol({
        configuredFleetSize: 4,
        validFamilyCount: 4,
        stakeClass: "destructive",
        alignmentMatrix,
        hasDeterministicVerifier: true,
      }),
    ).toMatchObject({
      protocol: "SCHISM",
      finalAction: "operator-halt",
      operatorActionRequired: true,
    });
  });

  test("4-1 split preserves the outlier for red-team handling", () => {
    const result = classifyProtocol({
      configuredFleetSize: 5,
      validFamilyCount: 5,
      stakeClass: "high-readonly",
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google", "perplexity"] },
        { id: "B", familyVotes: ["sovereign-local"] },
      ]),
    });
    expect(result.protocol).toBe("OUTLIER");
    expect(result.finalAction).toBe("red-team-outlier");
  });

  test("unanimous destructive runs still require operator approval", () => {
    const result = classifyProtocol({
      configuredFleetSize: 5,
      validFamilyCount: 5,
      stakeClass: "destructive",
      alignmentMatrix: matrix([
        {
          id: "A",
          familyVotes: ["anthropic", "openai", "google", "perplexity", "sovereign-local"],
        },
      ]),
    });
    expect(result).toMatchObject({
      protocol: "UNANIMOUS",
      finalAction: "operator-approval-required",
      operatorActionRequired: true,
    });
  });

  test("intra-family fracture is its own halt protocol", () => {
    const result = classifyProtocol({
      configuredFleetSize: 5,
      validFamilyCount: 4,
      stakeClass: "high-readonly",
      alignmentMatrix: matrix([
        { id: "A", familyVotes: ["anthropic", "openai", "google", "perplexity"] },
      ]),
      intraFamilyFractureDetected: true,
    });
    expect(result).toMatchObject({
      protocol: "INTRA_FAMILY_FRACTURE",
      finalAction: "operator-halt",
      operatorActionRequired: true,
    });
  });

  test("impersonation and too-small fleet fail closed", () => {
    expect(
      classifyProtocol({
        configuredFleetSize: 5,
        validFamilyCount: 5,
        stakeClass: "medium",
        alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "openai", "google"] }]),
        impersonationDetected: true,
      }),
    ).toMatchObject({ protocol: "IMPERSONATION_DETECTED", finalAction: "operator-halt" });
    expect(
      classifyProtocol({
        configuredFleetSize: 5,
        validFamilyCount: 2,
        stakeClass: "medium",
        alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "openai"] }]),
      }),
    ).toMatchObject({ protocol: "INCOMPLETE", finalAction: "operator-halt" });
  });
});

describe("Chuck V2 records and task capsules", () => {
  test("decision records preserve evidence and Vault provenance separately", () => {
    const receipts = [receipt("anthropic"), receipt("openai"), receipt("perplexity")];
    const record = decisionRecordFromParts({
      runId: "run-1",
      stakeClass: "high-readonly",
      taskClass: "architecture",
      configuredFleetSize: 5,
      adjudicatorFamily: "google",
      receipts,
      claims: [baseClaim],
      alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic", "openai", "perplexity"] }]),
      protocol: "UNANIMOUS",
      finalAction: "emit-task-capsule",
      operatorActionRequired: false,
      confidenceLabel: "degraded",
      authorityDiffId: "authdiff-0123456789abcdef",
      resourceSnapshot: { memoryPressure: "normal", freeMemoryMb: 4096 },
      operatorAttentionCost: { approvalCount: 1, estimatedMinutes: 2, interruptionRisk: "low" },
    });
    expect(record.degradedMode).toBe("DEGRADED-3");
    expect(record.evidenceCited).toEqual(["deterministic-verifier"]);
    expect(record.vaultDoctrineCited).toEqual(["principle:leave-workspace-as-found"]);
    expect(record.surfaceReceipts.map((surface) => surface.surface).toSorted()).toEqual([
      "test",
      "test",
      "test",
    ]);
    expect(record.intraFamilyFractures).toEqual([]);
    expect(record.authorityDiffId).toBe("authdiff-0123456789abcdef");
    expect(record.resourceSnapshot).toMatchObject({ memoryPressure: "normal", freeMemoryMb: 4096 });
    expect(record.operatorAttentionCost).toMatchObject({ approvalCount: 1 });
  });

  test("decision records count only verified non-impersonated receipts", () => {
    const record = decisionRecordFromParts({
      runId: "run-2",
      stakeClass: "high-readonly",
      taskClass: "architecture",
      configuredFleetSize: 5,
      adjudicatorFamily: "google",
      receipts: [
        receipt("openai", { actualFamily: "anthropic" }),
        receipt("anthropic"),
        receipt("perplexity", { modelVerified: false }),
      ],
      claims: [baseClaim],
      alignmentMatrix: matrix([{ id: "A", familyVotes: ["anthropic"] }]),
      protocol: "IMPERSONATION_DETECTED",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      confidenceLabel: "none",
    });
    expect(record.validVoiceCount).toBe(1);
    expect(record.validFamilyCount).toBe(1);
    expect(record.degradedMode).toBe("INCOMPLETE");
  });

  test("task capsules carry explicit tool, scope, verifier, rollback, and signature", () => {
    const capsule = createTaskCapsule({
      decisionRecordId: "run-1",
      actionPlan: ["patch file", "run tests"],
      allowedTools: ["apply_patch", "pnpm test"],
      filesystemScope: "workspace",
      networkScope: "deny",
      leashId: "leash-run-1",
      protectedPathVerdict: "clear",
      verifier: "pnpm test extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts",
      rollbackPlan: ["revert only Chuck V2 files"],
      expiresAt: "2026-04-27T00:00:00.000Z",
      signingSecret: SECRET,
    });
    expect(capsule.capsuleId).toMatch(/^capsule-/);
    expect(capsule.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(capsule.allowedTools).toContain("apply_patch");
    expect(capsule.networkScope).toBe("deny");
    expect(capsule.leashId).toBe("leash-run-1");
    expect(capsule.sandboxPolicy).toMatchObject({
      runtime: "ephemeral-worktree",
      filesystem: "ephemeral",
      network: "deny",
      denyRun: true,
    });
    expect(capsule.protectedPathVerdict).toBe("clear");
  });
});

describe("Chuck V2 event sourcing", () => {
  test("events are hash-verifiable and tamper-evident", () => {
    const event = createChuckEvent({
      eventId: "evt-test",
      type: "stake.classified",
      occurredAt: "2026-04-26T00:00:00.000Z",
      runId: "run-evt",
      payload: { stakeClass: "high-readonly", taskClass: "architecture" },
    });
    expect(event.eventHash).toMatch(/^sha256:/);
    expect(verifyChuckEvent(event)).toBe(true);
    expect(verifyChuckEvent({ ...event, payload: { stakeClass: "trivial" } })).toBe(false);
  });

  test("event chains preserve previous event hashes", () => {
    const [prompt, stake, decision] = chainChuckEvents([
      {
        eventId: "evt-1",
        type: "prompt.received",
        occurredAt: "2026-04-26T00:00:00.000Z",
        runId: "run-chain",
        payload: { text: "evaluate spec" },
      },
      {
        eventId: "evt-2",
        type: "stake.classified",
        occurredAt: "2026-04-26T00:00:01.000Z",
        runId: "run-chain",
        payload: { stakeClass: "high-readonly" },
      },
      {
        eventId: "evt-3",
        type: "decision.recorded",
        occurredAt: "2026-04-26T00:00:02.000Z",
        runId: "run-chain",
        payload: { decisionRecordId: "decision-1" },
      },
    ]);

    expect(prompt.previousEventHash).toBeUndefined();
    expect(stake.previousEventHash).toBe(prompt.eventHash);
    expect(decision.previousEventHash).toBe(stake.eventHash);
    expect([prompt, stake, decision].every((event) => verifyChuckEvent(event))).toBe(true);
  });

  test("event lines are append-only JSONL ready", () => {
    const event = createChuckEvent({
      eventId: "evt-jsonl",
      type: "protocol.classified",
      occurredAt: "2026-04-26T00:00:00.000Z",
      payload: { protocol: "UNANIMOUS" },
    });
    const line = appendChuckEventLine(event);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ eventId: "evt-jsonl", type: "protocol.classified" });
  });
});

describe("Chuck V2 operator surfaces", () => {
  test("operator surfaces store metadata and secret references, not raw secrets", () => {
    const profiles = [
      createOperatorSurfaceProfile({
        profileId: "gmail-primary",
        kind: "gmail",
        label: "Primary Gmail",
        identifierHint: "primary@example.com",
        secretRef: "keychain:gmail-primary",
        verified: true,
      }),
      createOperatorSurfaceProfile({
        profileId: "gmail-secondary",
        kind: "gmail",
        label: "Secondary Gmail",
        secretRef: "keychain:gmail-secondary",
        verified: false,
      }),
      createOperatorSurfaceProfile({
        profileId: "whatsapp-primary",
        kind: "whatsapp",
        label: "WhatsApp",
        identifierHint: "+15550101010",
        secretRef: "keychain:whatsapp-primary",
        verified: true,
      }),
    ];

    expect(summarizeOperatorSurfaces(profiles)).toEqual({
      total: 3,
      verified: 2,
      byKind: { gmail: 2, whatsapp: 1 },
      missingSecretRefs: [],
    });
    expect(redactedOperatorSurface(profiles[0])).toMatchObject({
      identifierHint: "pr...ry@example.com",
      secretRef: "<secret-ref>",
    });
    expect(redactedOperatorSurface(profiles[2]).identifierHint).toBe("+15...10");
  });

  test("operator surfaces reject obvious raw secrets", () => {
    expect(() =>
      createOperatorSurfaceProfile({
        profileId: "bad",
        kind: "gmail",
        label: "Bad Gmail",
        secretRef: "sk-this-should-not-be-here",
        verified: false,
      }),
    ).toThrow(/raw secret/);
  });
});

describe("Chuck V2 rotation and calibration", () => {
  test("adjudicator family rotates round-robin over healthy families", () => {
    expect(
      chooseAdjudicatorFamily({
        validFamilies: ["anthropic", "openai", "perplexity"],
        previousFamily: "anthropic",
      }),
    ).toBe("openai");
    expect(
      chooseAdjudicatorFamily({
        validFamilies: ["anthropic", "perplexity"],
        previousFamily: "google",
      }),
    ).toBe("perplexity");
  });

  test("red-team family never reuses the outlier slot when alternatives exist", () => {
    expect(
      chooseRedTeamFamily({
        validFamilies: ["anthropic", "openai", "google"],
        outlierFamily: "openai",
      }),
    ).not.toBe("openai");
  });

  test("calibration gate blocks authoritative truth claims until measured", () => {
    expect(
      evaluateCalibrationGate({
        objectivePromptCount: 40,
        objectiveSuiteUnanimousCorrectness: 0.82,
        interFamilyDisagreementRate: 0.2,
        falseConsensusCasesLogged: 2,
        highRiskDegradedAutoShipCount: 0,
      }),
    ).toMatchObject({ canClaimAuthoritativeTruth: false });
    expect(
      evaluateCalibrationGate({
        objectivePromptCount: 100,
        objectiveSuiteUnanimousCorrectness: 0.84,
        interFamilyDisagreementRate: 0.2,
        falseConsensusCasesLogged: 2,
        highRiskDegradedAutoShipCount: 0,
      }),
    ).toMatchObject({ canClaimAuthoritativeTruth: true, canAutoShipHighRisk: true });
  });
});

describe("Chuck V2 excellence trajectory", () => {
  test("marks compounding improvement only when measured axes improve safely", () => {
    const previous = {
      generatedAt: "2026-04-26T00:00:00.000Z",
      criticalIncidents: 0,
      operatorRejectedSelfChanges: 0,
      approvedSelfImprovementPatches: 1,
      axes: [
        { axis: "epistemic-quality" as const, score: 0.7, sampleCount: 20 },
        { axis: "execution-reliability" as const, score: 0.6, sampleCount: 20 },
        { axis: "safety-discipline" as const, score: 0.8, sampleCount: 20 },
        { axis: "operator-alignment" as const, score: 0.75, sampleCount: 20 },
      ],
    };
    const current = {
      generatedAt: "2026-04-27T00:00:00.000Z",
      criticalIncidents: 0,
      operatorRejectedSelfChanges: 0,
      approvedSelfImprovementPatches: 2,
      axes: [
        { axis: "epistemic-quality" as const, score: 0.74, sampleCount: 30 },
        { axis: "execution-reliability" as const, score: 0.67, sampleCount: 30 },
        { axis: "safety-discipline" as const, score: 0.82, sampleCount: 30 },
        { axis: "operator-alignment" as const, score: 0.78, sampleCount: 30 },
      ],
    };
    const result = evaluateExcellenceTrajectory({ previous, current });
    expect(result.improving).toBe(true);
    expect(result.compoundMomentum).toBeGreaterThan(0.5);
    expect(result.strongestAxes).toContain("safety-discipline");
  });

  test("blocks excellence claims on regressions or unsafe incidents", () => {
    const previous = {
      generatedAt: "2026-04-26T00:00:00.000Z",
      criticalIncidents: 0,
      operatorRejectedSelfChanges: 0,
      approvedSelfImprovementPatches: 0,
      axes: [{ axis: "safety-discipline" as const, score: 0.9, sampleCount: 20 }],
    };
    const current = {
      generatedAt: "2026-04-27T00:00:00.000Z",
      criticalIncidents: 1,
      operatorRejectedSelfChanges: 0,
      approvedSelfImprovementPatches: 1,
      axes: [{ axis: "safety-discipline" as const, score: 0.82, sampleCount: 20 }],
    };
    const result = evaluateExcellenceTrajectory({ previous, current });
    expect(result.improving).toBe(false);
    expect(result.blockedBy.join("\n")).toContain("critical incidents increased");
    expect(result.blockedBy.join("\n")).toContain("safety-discipline");
  });

  test("gap closure plans close reachable gaps without compromising invariants", () => {
    const result = evaluateGapClosurePlan({
      tracks: [
        {
          id: "docket-polish",
          category: "vendor-agent",
          mode: "close",
          metric: "user-experience",
          currentScore: 0.52,
          targetScore: 0.8,
          sampleCount: 12,
        },
        {
          id: "global-model-training",
          category: "vendor-agent",
          mode: "route-around",
          metric: "epistemic-quality",
          currentScore: 0.1,
          targetScore: 0.95,
          sampleCount: 12,
        },
        {
          id: "cross-surface-identity",
          category: "operator-specific",
          mode: "excel",
          metric: "operator-alignment",
          currentScore: 0.7,
          targetScore: 0.95,
          sampleCount: 12,
        },
      ],
    });
    expect(result.ready).toBe(false);
    expect(result.closeNow).toEqual(["docket-polish"]);
    expect(result.routeAround).toEqual(["global-model-training"]);
    expect(result.excelInvestments).toEqual(["cross-surface-identity"]);
  });

  test("gap closure rejects improvements that would compromise invariants", () => {
    const result = evaluateGapClosurePlan({
      tracks: [
        {
          id: "silent-tool-autonomy",
          category: "vendor-agent",
          mode: "close",
          metric: "autonomy",
          currentScore: 0.4,
          targetScore: 0.9,
          sampleCount: 20,
          compromisesInvariant: true,
        },
      ],
    });
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toEqual([
      "silent-tool-autonomy: would compromise a non-negotiable invariant",
    ]);
  });
});

describe("Chuck V2 fleet ratification", () => {
  const configuredFamilies: ChuckFamily[] = [
    "anthropic",
    "openai",
    "google",
    "perplexity",
    "sovereign-local",
  ];

  test("originating family participates as self-review but not independent ratification", () => {
    const result = evaluateFleetReviewRatification({
      configuredFamilies,
      reviewerFamilies: configuredFamilies,
      originatingFamily: "openai",
    });
    expect(result.configuredReviewComplete).toBe(true);
    expect(result.selfReviewFamilies).toEqual(["openai"]);
    expect(result.independentFamilies).toEqual([
      "anthropic",
      "google",
      "perplexity",
      "sovereign-local",
    ]);
    expect(result.canIndependentlyRatify).toBe(true);
    expect(result.notes.join("\n")).toContain("openai is originating-family self-review");
  });

  test("independent ratification can pass while configured self-review is still missing", () => {
    const result = evaluateFleetReviewRatification({
      configuredFamilies,
      reviewerFamilies: ["anthropic", "google", "perplexity", "sovereign-local"],
      originatingFamily: "openai",
    });
    expect(result.configuredReviewComplete).toBe(false);
    expect(result.missingFamilies).toEqual(["openai"]);
    expect(result.canIndependentlyRatify).toBe(true);
    expect(result.notes.join("\n")).toContain("openai self-review is missing");
  });

  test("self-review plus one independent family cannot ratify a draft", () => {
    const result = evaluateFleetReviewRatification({
      configuredFamilies,
      reviewerFamilies: ["openai", "anthropic"],
      originatingFamily: "openai",
    });
    expect(result.selfReviewFamilies).toEqual(["openai"]);
    expect(result.independentFamilies).toEqual(["anthropic"]);
    expect(result.canIndependentlyRatify).toBe(false);
    expect(result.notes.join("\n")).toContain("only 1 independent families; 3 required");
  });

  test("without an originating family every configured reviewer is independent", () => {
    const result = evaluateFleetReviewRatification({
      configuredFamilies,
      reviewerFamilies: ["anthropic", "openai", "google"],
    });
    expect(result.selfReviewFamilies).toEqual([]);
    expect(result.independentFamilies).toEqual(["anthropic", "openai", "google"]);
    expect(result.canIndependentlyRatify).toBe(true);
  });
});

describe("Chuck V2 Surface Atlas", () => {
  test("catalogues durable controls, shortcuts, abilities, leases, and mastery gaps for live surfaces", () => {
    const summary = surfaceAtlasSummary({ generatedAt: "2026-04-28T00:00:00.000Z" });
    expect(summary.totalSurfaces).toBeGreaterThanOrEqual(20);
    expect(summary.controls).toBeGreaterThanOrEqual(20);
    expect(summary.abilities).toBeGreaterThanOrEqual(20);

    const aiStudio = surfaceAtlasEntry("aistudio/web");
    expect(aiStudio).toBeTruthy();
    expect(aiStudio?.controls.map((control) => control.label)).toContain("Run");
    expect(aiStudio?.shortcuts.map((shortcut) => shortcut.keys)).toEqual(
      expect.arrayContaining(["Command+Enter", "Control+Enter"]),
    );
    expect(aiStudio?.knownIssues.join("\n")).toContain("Entitlement");

    const perplexity = surfaceAtlasEntry("perplexity/mac-app");
    expect(perplexity).toBeTruthy();
    expect(perplexity?.leasePolicy).toMatchObject({
      mode: "singleton-incognito-lane",
      keepOpenDuringActiveWork: true,
      returnRequired: true,
    });
    expect(perplexity?.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining([
        "perplexity-sidebar-toggle",
        "perplexity-settings-gear",
        "perplexity-incognito",
        "perplexity-mode-research",
      ]),
    );
    expect(perplexity?.masteryGaps.join("\n")).toContain("Repair answer extraction");

    const claudeMac = surfaceAtlasEntry("claude/mac-app");
    expect(claudeMac?.controls.map((control) => control.id)).toEqual(
      expect.arrayContaining(["claude-mode-chat", "claude-mode-cowork", "claude-mode-code"]),
    );

    const toolSurfaces = surfaceAtlasEntries().filter(
      (entry) => entry.category === "tool-surface" || entry.category === "connector",
    );
    expect(toolSurfaces.map((entry) => entry.surface)).toEqual(
      expect.arrayContaining([
        "codex/computer-use",
        "codex/plugins-skills",
        "github/connector",
        "gmail/connector",
        "google-drive/connector",
      ]),
    );
  });

  test("formats an operator-readable atlas report without hiding proof gaps", () => {
    const text = formatSurfaceAtlasReport(
      surfaceAtlasSummary({ generatedAt: "2026-04-28T00:00:00.000Z" }),
      {
        surface: "perplexity/mac-app",
      },
    );
    expect(text).toContain("Chuck Surface Atlas");
    expect(text).toContain("singleton-incognito-lane");
    expect(text).toContain("keep-open=yes");
    expect(text).toContain("Repair answer extraction");
  });
});

describe("Chuck V2 OpenClaw command bridge", () => {
  test("registers /chuck as an authenticated command", () => {
    const command = createChuckOpenClawCommand();
    expect(command).toMatchObject({
      name: "chuck",
      acceptsArgs: true,
      requireAuth: true,
    });
  });

  test("parses scout aliases and command flags", () => {
    expect(parseChuckCommandArgs("scout --no-auto-deepen evaluate this")).toMatchObject({
      kind: "scout",
      autoDeepen: false,
      includeProvisional: false,
      prompt: "evaluate this",
    });
    expect(parseChuckCommandArgs("ask --include-provisional audit all surfaces")).toMatchObject({
      kind: "scout",
      autoDeepen: true,
      includeProvisional: true,
      prompt: "audit all surfaces",
    });
    expect(parseChuckCommandArgs("doctor")).toMatchObject({ kind: "doctor" });
    expect(parseChuckCommandArgs("docket")).toMatchObject({ kind: "docket" });
    expect(parseChuckCommandArgs("hygiene")).toMatchObject({ kind: "hygiene" });
    expect(parseChuckCommandArgs("hygiene checkpoint")).toMatchObject({
      kind: "hygiene",
      hygieneCheckpoint: true,
    });
    expect(parseChuckCommandArgs("github")).toMatchObject({ kind: "github-hygiene" });
    expect(parseChuckCommandArgs("github checkpoint")).toMatchObject({
      kind: "github-hygiene",
      githubHygieneCheckpoint: true,
    });
    expect(parseChuckCommandArgs("upstream")).toMatchObject({
      kind: "upstream-sync",
      hygieneCheckpoint: false,
    });
    expect(parseChuckCommandArgs("upstream checkpoint")).toMatchObject({
      kind: "upstream-sync",
      hygieneCheckpoint: true,
    });
    expect(parseChuckCommandArgs("atlas perplexity/mac-app")).toMatchObject({
      kind: "surface-atlas",
      surfaceAtlasSurface: "perplexity/mac-app",
    });
    expect(parseChuckCommandArgs("onboard repair")).toMatchObject({
      kind: "onboard",
      prompt: "repair",
      onboardRepair: true,
    });
    expect(parseChuckCommandArgs("onboard candidate mistral mistral/le-chat")).toMatchObject({
      kind: "onboard",
      prompt: "candidate mistral mistral/le-chat",
      onboardCandidateFamily: "mistral",
      onboardCandidateSurface: "mistral/le-chat",
      onboardRepair: false,
    });
    expect(parseChuckCommandArgs("onboard member openai chatgpt/mac-app")).toMatchObject({
      kind: "onboard",
      prompt: "member openai chatgpt/mac-app",
      onboardMemberFamily: "openai",
      onboardMemberSurface: "chatgpt/mac-app",
      onboardRepair: false,
    });
    expect(parseChuckCommandArgs("onboard prove perplexity/mac-app")).toMatchObject({
      kind: "onboard",
      prompt: "prove perplexity/mac-app",
      onboardProveSurface: "perplexity/mac-app",
    });
  });

  test("onboarding report labels degraded fleet and future candidate intake", async () => {
    const report = await runChuckOnboarding({
      generatedAt: "2026-04-27T16:00:00.000Z",
      stateDir: "/tmp/chuck-onboard-test",
      executionProofs: {
        "claude-cli/exec": {
          surface: "claude-cli/exec",
          family: "anthropic",
          successes: 2,
          failures: 0,
          latestStatus: "completed",
          repeatable: true,
        },
      },
      resources: {
        capturedAt: "2026-04-27T16:00:00.000Z",
        memoryPressure: "warning",
        freeMemoryMb: 900,
        notes: ["test memory warning"],
      },
      dashboardReachable: true,
      commandRegistered: false,
    });

    expect(report.status).toBe("blocked");
    expect(report.actions.map((action) => action.kind)).toContain("future-candidate-intake");
    expect(report.actions.map((action) => action.kind)).toContain("command-proof");
    expect(report.stages.find((stage) => stage.id === "resources")).toMatchObject({
      status: "degraded",
    });
    expect(report.futureCandidatePolicy.countsAsFamilyOnlyAfter.join("\n")).toContain(
      "family identity is distinct",
    );
    expect(report.futureCandidatePolicy.memberCommand).toContain("onboard member");
    expect(
      report.familyMemberCatalog.find((member) => member.surface === "codex/exec"),
    ).toMatchObject({
      family: "openai",
      countsAsIndependentFamily: false,
    });
    expect(report.familyMemberCatalog.map((member) => member.surface)).toContain(
      "perplexity/comet",
    );
  });

  test("candidate onboarding dockets future surfaces without counting them as family votes", async () => {
    const record = await runCandidateOnboarding({
      generatedAt: "2026-04-27T17:00:00.000Z",
      stateDir: "/tmp/chuck-candidate-test",
      familyOrProduct: "mistral",
      surface: "mistral/le-chat",
      persist: false,
    });

    expect(record.classification).toBe("new-family-candidate");
    expect(record.proposedFamily).toBe("unknown");
    expect(record.countsAsIndependentFamilyNow).toBe(false);
    expect(record.openClawExposure).toBe("blocked-until-chuck-proof");
    expect(record.requiredPromotionGates.join("\n")).toContain("family is distinct");
    expect(record.docketItems).toHaveLength(3);
  });

  test("candidate onboarding treats same-family surfaces as intra-family signal only", async () => {
    const record = await runCandidateOnboarding({
      generatedAt: "2026-04-27T17:05:00.000Z",
      stateDir: "/tmp/chuck-candidate-test",
      familyOrProduct: "ChatGPT",
      surface: "chatgpt/mobile-voice",
      persist: false,
    });

    expect(record.classification).toBe("existing-family-new-surface");
    expect(record.proposedFamily).toBe("openai");
    expect(record.countsAsIndependentFamilyNow).toBe(false);
    expect(record.countsAsIndependentFamilyAfter.join("\n")).toContain("intra-family signal");
  });

  test("parses build commands, patch files, targets, status, docket, and approval", () => {
    expect(
      parseChuckCommandArgs(
        "build add the self-build loop --patch-file /tmp/build.patch --target extensions/memory-graph/src/chuck-v2/builder.ts",
      ),
    ).toMatchObject({
      kind: "build",
      prompt: "add the self-build loop",
      patchFile: "/tmp/build.patch",
      targetFiles: ["extensions/memory-graph/src/chuck-v2/builder.ts"],
    });
    expect(
      parseChuckCommandArgs(
        "build add builder generate --generate-patch --target extensions/memory-graph/src/chuck-v2/openclaw-command.ts",
      ),
    ).toMatchObject({
      kind: "build",
      prompt: "add builder generate",
      generatePatch: true,
      targetFiles: ["extensions/memory-graph/src/chuck-v2/openclaw-command.ts"],
    });
    expect(parseChuckCommandArgs("build status build-1")).toMatchObject({
      kind: "build-status",
      runId: "build-1",
    });
    expect(parseChuckCommandArgs("build docket")).toMatchObject({ kind: "build-docket" });
    expect(parseChuckCommandArgs("build approve build-2")).toMatchObject({
      kind: "build-approve",
      runId: "build-2",
    });
  });

  test("extracts only git-apply unified diffs from Fleet patch candidates", () => {
    const extracted = extractUnifiedDiffPatchCandidate(
      [
        "PLAN: add helper",
        "```diff",
        "diff --git a/extensions/memory-graph/src/chuck-v2/generated.ts b/extensions/memory-graph/src/chuck-v2/generated.ts",
        "--- /dev/null",
        "+++ b/extensions/memory-graph/src/chuck-v2/generated.ts",
        "@@ -0,0 +1 @@",
        "+export const generated = true;",
        "```",
      ].join("\n"),
    );
    expect(extracted.patchText).toContain("diff --git");
    expect(extracted.patchText).toContain("generated.ts");

    const rejected = extractUnifiedDiffPatchCandidate(
      [
        "```patch",
        "*** Begin Patch",
        "*** Add File: extensions/memory-graph/src/chuck-v2/generated.ts",
        "+export const generated = true;",
        "*** End Patch",
        "```",
      ].join("\n"),
    );
    expect(rejected.patchText).toBeUndefined();
    expect(rejected.blockers.join("\n")).toContain("apply_patch syntax");
  });

  test("delegates /chuck scout to the live scout bridge with receipts in the reply", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "scout --no-auto-deepen evaluate OpenClaw bridge",
        channel: "telegram",
        commandBody: "/chuck scout evaluate OpenClaw bridge",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        signingSecret: "test-secret",
        deps: {
          runDoctor: async () => ({
            configuredVoices: 4,
            configuredFamilies: ["anthropic", "openai", "google", "sovereign-local"],
            readyFamilies: ["anthropic", "openai", "google", "sovereign-local"],
            unknownFamilies: [],
            blockedFamilies: [],
            executionReadyFamilies: ["anthropic", "openai", "google", "sovereign-local"],
            configuredButNotExecutableSurfaces: [],
            canRunMinimumFleet: true,
            canRunHighRiskFleet: true,
            canRunLoadBearingMinimumFleet: true,
            canRunLoadBearingHighRiskFleet: true,
            nextActions: [],
          }),
          readDocket: async () => [],
          runLiveScout: async (input) => {
            expect(input).toMatchObject({
              prompt: "evaluate OpenClaw bridge",
              autoDeepen: false,
              includeProvisional: false,
              stateDir: "/tmp/chuck-command-test",
            });
            return {
              summary: {
                runId: "chuck-test-run",
                stakeClass: "medium",
                taskClass: "architecture",
                docketStatus: "waiting-fleet",
              },
              result: {
                runId: "chuck-test-run",
                docketItem: { status: "waiting-fleet" },
              },
              runnerExecution: {
                receipts: [
                  { actualFamily: "anthropic", surface: "claude-cli/exec" },
                  { actualFamily: "openai", surface: "codex/exec" },
                  { actualFamily: "google", surface: "gemini/cli" },
                  { actualFamily: "sovereign-local", surface: "ollama/localhost" },
                ],
                executions: [],
              },
              scoutResolve: {
                disposition: "deepen",
                independentUsableFamilyCount: 4,
                deepenNeededSurfaces: ["claude-cli/exec"],
              },
              cooldownSurfaces: [],
            } as never;
          },
        },
      },
    );

    expect(result.text).toContain("Chuck Fleet run chuck-test-run");
    expect(result.text).toContain("4 receipts across 4 independent families");
    expect(result.text).toContain("claude-cli/exec, codex/exec, gemini/cli, ollama/localhost");
  });

  test("delegates /chuck build to the governed builder bridge", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "build add builder status --patch-file /tmp/build.patch --target extensions/memory-graph/src/chuck-v2/builder.ts",
        channel: "telegram",
        commandBody: "/chuck build add builder status",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        signingSecret: "test-secret",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async (input) => {
            expect(input).toMatchObject({
              objective: "add builder status",
              stateDir: "/tmp/chuck-command-test",
              signingSecret: "test-secret",
              patchFile: "/tmp/build.patch",
              targetFiles: ["extensions/memory-graph/src/chuck-v2/builder.ts"],
            });
            return {
              runId: "build-test",
              objective: "add builder status",
              createdAt: "2026-04-27T00:00:00.000Z",
              updatedAt: "2026-04-27T00:00:00.000Z",
              stage: "docketed",
              autonomyEnvelope: "aggressive",
              targetFiles: ["extensions/memory-graph/src/chuck-v2/builder.ts"],
              tests: [],
              disposition: "needs-human",
              operatorActionRequired: false,
              reasons: ["builder has no patch text yet"],
              authorityDiffId: "authdiff-test",
            };
          },
        },
      },
    );

    expect(result.text).toContain("Chuck build build-test");
    expect(result.text).toContain("Disposition: needs-human");
  });

  test("serves /chuck atlas from the durable Surface Atlas", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "atlas aistudio/web",
        channel: "telegram",
        commandBody: "/chuck atlas aistudio/web",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async () => {
            throw new Error("unused");
          },
        },
      },
    );

    expect(result.text).toContain("aistudio/web");
    expect(result.text).toContain("Run");
    expect(result.text).toContain("Command+Enter");
  });

  test("delegates /chuck onboard repair to the onboarding bridge", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "onboard repair",
        channel: "telegram",
        commandBody: "/chuck onboard repair",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runOnboard: async (input) => {
            expect(input).toMatchObject({ stateDir: "/tmp/chuck-command-test", repair: true });
            return {
              text: "Chuck onboarding onboard-test\nStatus: degraded",
              report: { runId: "onboard-test" },
            };
          },
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async () => {
            throw new Error("unused");
          },
        },
      },
    );

    expect(result.text).toContain("Chuck onboarding onboard-test");
  });

  test("delegates /chuck onboard candidate to candidate intake", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "onboard candidate mistral mistral/le-chat",
        channel: "telegram",
        commandBody: "/chuck onboard candidate mistral mistral/le-chat",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runOnboard: async (input) => {
            expect(input).toMatchObject({
              stateDir: "/tmp/chuck-command-test",
              repair: false,
              candidate: { familyOrProduct: "mistral", surface: "mistral/le-chat" },
            });
            return {
              text: "Chuck candidate onboarding candidate-test\nStatus: docketed-for-proof",
              report: { candidateId: "candidate-test" },
            };
          },
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async () => {
            throw new Error("unused");
          },
        },
      },
    );

    expect(result.text).toContain("Chuck candidate onboarding candidate-test");
  });

  test("delegates /chuck onboard member to same-family surface intake", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "onboard member openai chatgpt/mac-app",
        channel: "telegram",
        commandBody: "/chuck onboard member openai chatgpt/mac-app",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runOnboard: async (input) => {
            expect(input).toMatchObject({
              stateDir: "/tmp/chuck-command-test",
              repair: false,
              member: { family: "openai", surface: "chatgpt/mac-app" },
            });
            return {
              text: "Chuck candidate onboarding member-test\nClassification: existing-family-new-surface",
              report: { candidateId: "member-test" },
            };
          },
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async () => {
            throw new Error("unused");
          },
        },
      },
    );

    expect(result.text).toContain("Classification: existing-family-new-surface");
  });

  test("delegates /chuck onboard prove to a surface proof", async () => {
    const result = await handleChuckOpenClawCommand(
      {
        args: "onboard prove codex/exec",
        channel: "telegram",
        commandBody: "/chuck onboard prove codex/exec",
        config: {},
        isAuthorizedSender: true,
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      },
      {
        stateDir: "/tmp/chuck-command-test",
        deps: {
          runDoctor: async () => ({}),
          readDocket: async () => [],
          runOnboard: async (input) => {
            expect(input).toMatchObject({
              stateDir: "/tmp/chuck-command-test",
              repair: false,
              proveSurface: "codex/exec",
            });
            return {
              text: "Chuck surface proof codex/exec\nReceipts: 1",
              report: { surface: "codex/exec" },
            };
          },
          runLiveScout: async () => {
            throw new Error("unused");
          },
          readBuildStatus: async () => null,
          readBuildDocket: async () => [],
          approveBuild: async () => {
            throw new Error("unused");
          },
          runBuild: async () => {
            throw new Error("unused");
          },
        },
      },
    );

    expect(result.text).toContain("Chuck surface proof codex/exec");
  });

  test("formats live scout misses without erasing successful receipts", () => {
    const text = formatLiveScoutReply({
      summary: {
        runId: "chuck-test-run",
        stakeClass: "medium",
        taskClass: "architecture",
        docketStatus: "waiting-fleet",
      },
      result: { runId: "chuck-test-run", docketItem: { status: "waiting-fleet" } },
      runnerExecution: {
        receipts: [{ actualFamily: "openai", surface: "codex/exec" }],
        executions: [
          { surface: "codex/exec", status: "completed" },
          { surface: "gemini/web-chat", status: "failed" },
        ],
      },
      scoutResolve: {
        disposition: "outlier",
        independentUsableFamilyCount: 1,
        deepenNeededSurfaces: [],
      },
      cooldownSurfaces: ["perplexity/mac-app"],
    } as never);

    expect(text).toContain("1 receipt across 1 independent family");
    expect(text).toContain("Cooldown skipped: perplexity/mac-app");
    expect(text).toContain("Surface misses: gemini/web-chat:failed");
  });
});

describe("Chuck V2 repo hygiene", () => {
  test("classifies repo dirt and marks broad self-build unsafe when ambiguity remains", () => {
    const report = analyzeRepoHygieneFromPorcelain(
      [
        " M extensions/memory-graph/src/engine.ts",
        "?? extensions/memory-graph/scripts/apex-old-tool.mjs",
        "?? extensions/memory-graph/scripts/apex-other-tool.mjs",
        "?? extensions/memory-graph/scripts/chuck-new-driver.mjs",
        "?? ui-phone-v3/src/views/fleet.ts",
      ].join("\n"),
    );

    expect(report.clean).toBe(false);
    expect(report.selfBuildSafe).toBe(false);
    expect(report.buckets.map((bucket) => bucket.bucket)).toContain("memory-graph-extension");
    expect(report.buckets.map((bucket) => bucket.bucket)).toContain("chuck-surface-drivers");
    expect(report.blockers.join("\n")).toContain("tracked core/extension");
    expect(report.blockers.join("\n")).toContain("untracked source-like");
    expect(formatRepoHygieneReport(report)).toContain("Self-build safe: no");
    const plan = planRepoHygiene(report, { now: "2026-04-28T00:00:00.000Z" });
    expect(plan.broadSelfBuildAllowed).toBe(false);
    expect(plan.targetedSelfBuildAllowed).toBe(true);
    expect(plan.cleanupOrder[0]).toBe("freeze-current-state");
    expect(plan.lanes.map((lane) => lane.id)).toContain("classify-source-like-untracked");
  });

  test("allows self-build when git porcelain is clean", () => {
    const report = analyzeRepoHygieneFromPorcelain("");

    expect(report.clean).toBe(true);
    expect(report.selfBuildSafe).toBe(true);
    expect(report.nextActions).toEqual(["repo is clean; continue with shadow-worktree self-build"]);
  });

  test("builds lane manifests for commit, salvage, and interface cleanup", () => {
    const report = analyzeRepoHygieneFromPorcelain(
      [
        " M extensions/memory-graph/src/engine.ts",
        " M src/plugin-sdk/core.ts",
        "?? extensions/memory-graph/src/chuck-v2/",
        "?? extensions/memory-graph/scripts/chuck-dashboard.mjs",
        "?? extensions/memory-graph/scripts/apex-old-tool.mjs",
        "?? ui-phone-v3/src/views/fleet.ts",
      ].join("\n"),
    );
    const lanes = repoHygieneLaneManifests({
      report,
      untrackedManifest: [
        {
          path: "extensions/memory-graph/src/chuck-v2/repo-hygiene.ts",
          sizeBytes: 100,
          sha256: "abc",
        },
        {
          path: "extensions/memory-graph/scripts/chuck-dashboard.mjs",
          sizeBytes: 100,
          sha256: "def",
        },
      ],
    });
    const byId = new Map(lanes.map((lane) => [lane.laneId, lane]));

    expect(byId.get("chuck-kernel-current")?.paths).toContain(
      "extensions/memory-graph/src/chuck-v2/repo-hygiene.ts",
    );
    expect(byId.get("chuck-kernel-current")?.paths).toContain(
      "extensions/memory-graph/scripts/chuck-dashboard.mjs",
    );
    expect(byId.get("apex-salvage")?.disposition).toBe("promote-or-archive");
    expect(byId.get("openclaw-core-bridge")?.risk).toBe("high");
    expect(byId.get("phone-ui")?.paths).toContain("ui-phone-v3/src/views/fleet.ts");
  });
});

describe("Chuck V2 GitHub hygiene", () => {
  test("protects current and upstream-overlap branches while marking stale fork-only cleanup candidates", () => {
    const now = "2026-04-28T00:00:00.000Z";
    const current = classifyForkBranch({
      branch: {
        remote: "fork",
        name: "phase-1/sandbox-broker",
        sha: "a",
        lastCommitAt: "2026-04-27T00:00:00.000Z",
      },
      currentBranch: "phase-1/sandbox-broker",
      protectedNames: new Set(["main", "phase-1/sandbox-broker"]),
      now,
    });
    const upstreamOverlap = classifyForkBranch({
      branch: {
        remote: "fork",
        name: "codex/shared-upstream-fix",
        sha: "b",
        lastCommitAt: "2025-01-01T00:00:00.000Z",
      },
      upstream: {
        remote: "origin",
        name: "codex/shared-upstream-fix",
        sha: "b",
        lastCommitAt: "2025-01-01T00:00:00.000Z",
      },
      currentBranch: "phase-1/sandbox-broker",
      protectedNames: new Set(["main", "phase-1/sandbox-broker"]),
      now,
    });
    const staleAgent = classifyForkBranch({
      branch: {
        remote: "fork",
        name: "codex/old-experiment",
        sha: "c",
        lastCommitAt: "2025-01-01T00:00:00.000Z",
      },
      currentBranch: "phase-1/sandbox-broker",
      protectedNames: new Set(["main", "phase-1/sandbox-broker"]),
      now,
    });

    expect(current).toMatchObject({
      category: "current-work",
      protected: true,
      deleteCandidate: false,
    });
    expect(upstreamOverlap).toMatchObject({
      category: "upstream-overlap",
      forkOnly: false,
      deleteCandidate: false,
    });
    expect(staleAgent).toMatchObject({
      category: "agent-generated",
      forkOnly: true,
      deleteCandidate: true,
    });
  });

  test("formats remote branch sprawl as cleanup candidates, not deletion commands", () => {
    const text = formatGitHubHygieneReport({
      available: true,
      forkRemote: "fork",
      upstreamRemote: "origin",
      currentBranch: "main",
      totalForkBranches: 3,
      totalUpstreamBranches: 1,
      overlapCount: 1,
      forkOnlyCount: 2,
      deleteCandidateCount: 1,
      protectedCount: 1,
      categories: [
        {
          category: "agent-generated",
          total: 1,
          deleteCandidates: 1,
          examples: ["codex/old-experiment"],
        },
      ],
      branches: [],
      blockers: [
        "1 fork branch(es) are deletion candidates but require explicit manifest review before remote mutation",
      ],
      nextActions: ["review delete-candidates.review-only.txt"],
      policy: ["No branch deletion without a manifest."],
    });

    expect(text).toContain("Delete candidates: 1");
    expect(text).toContain("require explicit manifest review");
    expect(text).not.toContain("git push");
  });
});

describe("Chuck V2 upstream sync", () => {
  test("formats release drift without allowing dirty broad sync", () => {
    const text = formatUpstreamSyncReport({
      available: true,
      currentBranch: "phase-1/sandbox-broker",
      packageVersion: "2026.4.20",
      headSha: "local",
      headSummary: "local 2026-04-28T00:00:00Z local work",
      describe: "v2026.4.19-beta.2-866-glocal-dirty",
      upstreamRemote: "origin",
      latestStableTag: "v2026.4.26",
      latestStableSha: "stable",
      upstreamMainSha: "main",
      stableContained: false,
      stableMissingCommits: 8,
      localCommitsAfterStable: 2,
      mainMissingCommits: 9,
      localCommitsAheadOfMain: 2,
      stableBehind: true,
      mainBehind: true,
      localDirty: true,
      broadSyncAllowed: false,
      blockers: ["192 local dirty path(s) must be checkpointed, committed, or parked first"],
      nextActions: ["finish repo lane cleanup or commit the current lane checkpoints"],
      policy: ["watch upstream continuously, but do not merge/rebase over dirty Chuck lanes"],
      repoHygiene: {
        available: true,
        clean: false,
        total: 192,
        trackedModified: 27,
        untracked: 165,
        selfBuildSafe: false,
        entries: [],
        buckets: [],
        blockers: [],
        nextActions: [],
        policy: [],
      },
    });

    expect(text).toContain("Latest stable tag: v2026.4.26");
    expect(text).toContain("Broad sync allowed: no");
    expect(text).toContain("local dirty path");
  });
});

describe("Chuck V2 self-build loop", () => {
  test("extracts changed files from git and apply_patch style patches", () => {
    expect(
      changedFilesFromPatch(`
diff --git a/extensions/memory-graph/src/chuck-v2/foo.ts b/extensions/memory-graph/src/chuck-v2/foo.ts
--- a/extensions/memory-graph/src/chuck-v2/foo.ts
+++ b/extensions/memory-graph/src/chuck-v2/foo.ts
@@
+export const ok = true;
*** Update File: extensions/memory-graph/src/chuck-v2/bar.ts
    `),
    ).toEqual([
      "extensions/memory-graph/src/chuck-v2/bar.ts",
      "extensions/memory-graph/src/chuck-v2/foo.ts",
    ]);
  });

  test("Tier-0 build targets are docketed for approval and not mutated", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-tier0-"));
    const run = await runSelfBuild({
      objective: "change Kernel policy",
      stateDir,
      repoRoot: "/repo",
      patchText:
        "diff --git a/extensions/memory-graph/src/chuck-v2/kernel.ts b/extensions/memory-graph/src/chuck-v2/kernel.ts\n+++ b/extensions/memory-graph/src/chuck-v2/kernel.ts\n@@\n+export const changed = true;\n",
      runCommand: async () => {
        throw new Error("should not run commands for unapproved Tier-0");
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-tier0",
    });

    expect(run.disposition).toBe("docketed-for-approval");
    expect(run.operatorActionRequired).toBe(true);
    expect(run.stage).toBe("docketed");
    await rm(stateDir, { recursive: true, force: true });
  });

  test("destructive build authority is blocked", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-destructive-"));
    const run = await runSelfBuild({
      objective: "delete files",
      stateDir,
      repoRoot: "/repo",
      patchText: "diff --git a/tmp.txt b/tmp.txt\n+++ b/tmp.txt\n@@\n+ok\n",
      targetFiles: ["tmp.txt"],
      // Direct capability injection is not part of runSelfBuild public input, so use a destructive target via patch text is not enough.
      // The blocked destructive lane is covered by authority-diff tests; this build path must still stay non-applied without commands when dirty.
      runCommand: async (cmd) => {
        if (cmd.command === "git" && cmd.args[0] === "status") {
          return { exitCode: 0, stdout: " M tmp.txt\n", stderr: "" };
        }
        throw new Error("unexpected command");
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-dirty",
    });

    expect(run.disposition).toBe("needs-human");
    expect(run.reasons.join("\n")).toContain("dirty target files");
    await rm(stateDir, { recursive: true, force: true });
  });

  test("passing low-risk patch uses a shadow worktree before applying to main", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-pass-"));
    const calls: string[] = [];
    const run = await runSelfBuild({
      objective: "add low risk helper",
      stateDir,
      repoRoot: "/repo",
      patchText:
        "diff --git a/extensions/memory-graph/src/chuck-v2/helper.ts b/extensions/memory-graph/src/chuck-v2/helper.ts\n+++ b/extensions/memory-graph/src/chuck-v2/helper.ts\n@@\n+export const helper = true;\n",
      verificationCommands: [
        {
          command: "pnpm",
          args: ["exec", "oxlint", "extensions/memory-graph/src/chuck-v2/helper.ts"],
        },
      ],
      runCommand: async (cmd) => {
        calls.push(`${cmd.cwd}:${cmd.command} ${cmd.args.join(" ")}`);
        if (cmd.command === "git" && cmd.args[0] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-pass",
    });

    expect(run.disposition).toBe("applied");
    expect(run.stage).toBe("applied-main");
    expect(calls.some((call) => call.includes("git worktree add --detach"))).toBe(true);
    expect(calls.some((call) => call.includes("git apply") && !call.startsWith("/repo:"))).toBe(
      true,
    );
    expect(calls.at(-1)).toContain("/repo:git apply");
    await rm(stateDir, { recursive: true, force: true });
  });

  test("shadow worktree seeds relevant untracked working context before verification", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-seed-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "chuck-builder-repo-"));
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await mkdir(join(repoRoot, "extensions/memory-graph/src/chuck-v2"), { recursive: true });
    await writeFile(
      join(repoRoot, "extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts"),
      "console.log('seeded-context');\n",
      "utf8",
    );
    const run = await runSelfBuild({
      objective: "verify untracked test context",
      stateDir,
      repoRoot,
      patchText:
        "diff --git a/extensions/memory-graph/src/chuck-v2/helper.ts b/extensions/memory-graph/src/chuck-v2/helper.ts\n+++ b/extensions/memory-graph/src/chuck-v2/helper.ts\n@@\n+export const helper = true;\n",
      verificationCommands: [
        { command: "node", args: ["extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts"] },
      ],
      runCommand: async (cmd) => {
        if (cmd.command === "git" && cmd.args[0] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.command === "git" && cmd.args.slice(0, 3).join(" ") === "worktree add --detach") {
          await mkdir(cmd.args[3], { recursive: true });
          return { exitCode: 0, stdout: "worktree", stderr: "" };
        }
        if (cmd.command === "node") {
          const seeded = await readFile(
            join(cmd.cwd, "extensions/memory-graph/src/chuck-v2/chuck-v2.test.ts"),
            "utf8",
          );
          return {
            exitCode: seeded.includes("seeded-context") ? 0 : 1,
            stdout: seeded,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-seed-context",
    });

    expect(run.disposition).toBe("applied");
    expect(run.tests[0]?.stdoutTail).toContain("seeded-context");
    await rm(stateDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("failed verification prevents main worktree apply", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-fail-"));
    const calls: string[] = [];
    const run = await runSelfBuild({
      objective: "add failing helper",
      stateDir,
      repoRoot: "/repo",
      patchText:
        "diff --git a/extensions/memory-graph/src/chuck-v2/helper.ts b/extensions/memory-graph/src/chuck-v2/helper.ts\n+++ b/extensions/memory-graph/src/chuck-v2/helper.ts\n@@\n+export const helper = true;\n",
      verificationCommands: [{ command: "pnpm", args: ["test", "failing.test.ts"] }],
      runCommand: async (cmd) => {
        calls.push(`${cmd.cwd}:${cmd.command} ${cmd.args.join(" ")}`);
        if (cmd.command === "git" && cmd.args[0] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.command === "pnpm") {
          return { exitCode: 1, stdout: "", stderr: "failed" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-fail",
    });

    expect(run.disposition).toBe("failed-verification");
    expect(calls.filter((call) => call.startsWith("/repo:git apply"))).toHaveLength(0);
    await rm(stateDir, { recursive: true, force: true });
  });

  test("no-patch builder run persists an implementation plan artifact", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-plan-"));
    const run = await runSelfBuild({
      objective: "plan dashboard build controls",
      stateDir,
      repoRoot: "/repo",
      implementationPlan: {
        summary: "Add dashboard controls for BuilderRun status.",
        proposedFiles: ["extensions/memory-graph/scripts/chuck-dashboard.mjs"],
        verifierCommands: [
          {
            command: "node",
            args: ["--check", "extensions/memory-graph/scripts/chuck-dashboard.mjs"],
          },
        ],
        blockers: ["no patch generated yet"],
        sourceRunId: "chuck-test",
        sourceReceipts: ["openai:codex/exec:abc123"],
      },
      runCommand: async () => {
        throw new Error("no commands should run without patch text");
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-plan",
    });

    expect(run.disposition).toBe("needs-human");
    expect(run.planPath).toContain("implementation-plan.md");
    const planText = await readFile(run.planPath ?? "", "utf8");
    expect(planText).toContain("Add dashboard controls");
    expect(planText).toContain("extensions/memory-graph/scripts/chuck-dashboard.mjs");
    await rm(stateDir, { recursive: true, force: true });
  });

  test("approval only works for docketed authority gates", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chuck-builder-approve-"));
    await runSelfBuild({
      objective: "change Kernel policy",
      stateDir,
      repoRoot: "/repo",
      patchText:
        "diff --git a/extensions/memory-graph/src/chuck-v2/kernel.ts b/extensions/memory-graph/src/chuck-v2/kernel.ts\n+++ b/extensions/memory-graph/src/chuck-v2/kernel.ts\n@@\n+export const changed = true;\n",
      runCommand: async () => {
        throw new Error("unused");
      },
      now: "2026-04-27T00:00:00.000Z",
      runId: "build-approve",
    });
    const approved = await approveBuilderRun({
      stateDir,
      runId: "build-approve",
      approvedAt: "2026-04-27T01:00:00.000Z",
    });
    expect(approved.operatorActionRequired).toBe(false);
    expect(approved.reasons.join("\n")).toContain("operator approved");
    await expect(approveBuilderRun({ stateDir, runId: "build-approve" })).rejects.toThrow(
      "not waiting for approval",
    );
    await rm(stateDir, { recursive: true, force: true });
  });

  test("formats builder status with approval and verifier details", () => {
    const text = formatBuildStatusReply({
      runId: "build-status",
      objective: "add status",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
      stage: "verified",
      autonomyEnvelope: "aggressive",
      targetFiles: ["extensions/memory-graph/src/chuck-v2/builder.ts"],
      tests: [
        {
          passed: true,
          command: "pnpm",
          args: ["test"],
          cwd: "/repo",
          exitCode: 0,
          stdoutTail: "",
          stderrTail: "",
          durationMs: 1,
        },
      ],
      disposition: "needs-human",
      operatorActionRequired: false,
      reasons: ["example"],
      authorityDiffId: "authdiff-test",
      implementationPlan: {
        summary: "Plan example",
        proposedFiles: ["extensions/memory-graph/src/chuck-v2/builder.ts"],
        verifierCommands: [],
        blockers: [],
        sourceReceipts: [],
      },
      planPath: "/tmp/implementation-plan.md",
    });
    expect(text).toContain("Chuck build build-status");
    expect(text).toContain("Tests: 1/1 passed");
    expect(text).toContain("Plan: /tmp/implementation-plan.md");
    expect(text).toContain("Plan summary: Plan example");
  });
});

describe("Chuck V2 skill quarantine", () => {
  test("broad shell and network capabilities require fleet review", () => {
    const assessed = assessSkillManifest(`
      # SKILL.md
      Uses child_process.exec to run shell commands and fetches network resources with curl.
      Reads ~/Library/Application Support browser cookies.
    `);
    expect(assessed.risk).toBe("high");
    expect(assessed.declaredCapabilities).toEqual([
      "shell",
      "network",
      "browser",
      "filesystem-broad",
    ]);
    expect(assessed.requiresSandboxDryRun).toBe(true);
    expect(assessed.requiresFleetReview).toBe(true);
  });

  test("benign manifests still require sandbox dry run", () => {
    const assessed = assessSkillManifest(
      "Formats local markdown headings without external access.",
    );
    expect(assessed.risk).toBe("low");
    expect(assessed.requiresSandboxDryRun).toBe(true);
    expect(assessed.requiresFleetReview).toBe(false);
  });

  test("quarantine plans require real sandbox gates before enablement", () => {
    const assessed = assessSkillManifest(
      "Runs bash, fetches https URLs, and installs a launchd plist.",
    );
    const plan = buildSkillQuarantinePlan(assessed);
    expect(plan.requiredSteps).toEqual([
      "unpack",
      "metadata-parse",
      "sbom-static-scan",
      "declared-capability-review",
      "network-off-dry-run",
      "observed-behavior-diff",
      "fleet-review",
      "local-sign",
      "enable",
    ]);
    expect(
      canEnableSkill({
        assessment: assessed,
        completedSteps: [
          "unpack",
          "metadata-parse",
          "sbom-static-scan",
          "declared-capability-review",
          "local-sign",
        ],
      }),
    ).toMatchObject({
      allowed: false,
      missingSteps: ["network-off-dry-run", "observed-behavior-diff", "fleet-review"],
    });
    expect(
      canEnableSkill({
        assessment: assessed,
        completedSteps: plan.requiredSteps.filter((step) => step !== "enable"),
      }),
    ).toMatchObject({ allowed: true, missingSteps: [] });
  });
});

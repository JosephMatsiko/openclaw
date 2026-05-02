// Core mechanical mapper — runner-execution item → posterior delta.

import { join } from "node:path";
import type { PosteriorDeltaConfig } from "./config.js";
import { extractRecommendations, parseScoutSections } from "./sections.js";
import type {
  AuthorityImpact,
  Claim,
  Confidence,
  EvidenceRef,
  PosteriorDelta,
  PriorRecord,
  Producer,
  RunRecord,
  RunnerExecution,
  RunnerExecutionItem,
  TaskRecord,
} from "./types.js";
import {
  compactTimestamp,
  fileSha,
  normalizeSha,
  pathExists,
  sha256,
  stableStringify,
} from "./util.js";

export function confidenceForExecution(item: RunnerExecutionItem): Confidence {
  if (item.status !== "completed") return "low";
  if (item.countingEligible === true && item.calibration?.verdict === "usable") return "high";
  if (item.countingEligible === true) return "medium";
  return "low";
}

function statusOpenQuestions(item: RunnerExecutionItem): string[] {
  if (item.status === "failed") {
    return [
      `Investigate ${item.surface ?? "unknown surface"} failure: ${item.reason ?? "unknown reason"}`,
    ];
  }
  if (item.countingEligible !== true) {
    return [
      `Harden ${item.surface ?? "unknown surface"} so it returns the required scout structure.`,
    ];
  }
  return [];
}

export interface BuildDeltaInput {
  execution: RunnerExecution;
  run: RunRecord | null;
  task: TaskRecord | null;
  prior: PriorRecord | null;
  item: RunnerExecutionItem;
  executionPath: string;
}

export function buildEvidence(
  config: PosteriorDeltaConfig,
  input: BuildDeltaInput,
  deltaId: string,
): EvidenceRef[] {
  const { item, run, task, prior, executionPath } = input;
  const evidence: EvidenceRef[] = [];
  const receipt = item.receipt ?? {};
  if (receipt.transcriptPath) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-transcript`,
      kind: "transcript",
      ref: receipt.transcriptPath,
      sha256: normalizeSha(receipt.transcriptSha256),
      observedAt: receipt.endedAt ?? receipt.startedAt ?? null,
    });
  }
  evidence.push({
    evidenceId: `${deltaId}:evidence-runner-execution`,
    kind: "run",
    ref: executionPath,
    sha256: fileSha(executionPath),
    observedAt: null,
  });
  if (run?.runId) {
    const runPath = join(config.runsDir, `${run.runId}.json`);
    if (pathExists(runPath)) {
      evidence.push({
        evidenceId: `${deltaId}:evidence-run`,
        kind: "run",
        ref: runPath,
        sha256: fileSha(runPath),
        observedAt: run.createdAt ?? null,
      });
    }
  }
  if (task?._path) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-task`,
      kind: "file",
      ref: task._path,
      sha256: fileSha(task._path),
      observedAt: task.updatedAt ?? task.createdAt ?? null,
    });
  }
  if (prior?._path) {
    evidence.push({
      evidenceId: `${deltaId}:evidence-prior`,
      kind: "file",
      ref: prior._path,
      sha256: fileSha(prior._path),
      observedAt: prior.createdAt ?? null,
    });
  }
  return evidence;
}

interface BuildClaimsInput {
  deltaId: string;
  item: RunnerExecutionItem;
  sections: ReturnType<typeof parseScoutSections>;
  producer: Producer;
  evidence: EvidenceRef[];
  maxClaims: number;
}

export function buildClaims(input: BuildClaimsInput): Claim[] {
  const evidenceRefs = input.evidence.map((entry) => entry.evidenceId);
  const sectionClaims = input.sections.claims.slice(0, input.maxClaims).map((text, index) => ({
    claimId: `${input.deltaId}:claim-${index + 1}`,
    text,
    status: input.item.countingEligible === true ? ("supported" as const) : ("proposed" as const),
    confidence: confidenceForExecution(input.item),
    evidenceRefs,
    dissentRefs: [],
  }));
  if (sectionClaims.length > 0) return sectionClaims;
  const surface = input.producer.surface;
  const reason = input.item.reason ?? "unknown failure";
  const statusText =
    input.item.status === "failed"
      ? `${surface} failed to produce a usable family posterior: ${reason}`
      : `${surface} produced a non-counting or weakly structured family posterior.`;
  return [
    {
      claimId: `${input.deltaId}:claim-1`,
      text: statusText,
      status: input.item.status === "failed" ? "contested" : "proposed",
      confidence: "low",
      evidenceRefs,
      dissentRefs: [],
    },
  ];
}

export function buildDelta(config: PosteriorDeltaConfig, input: BuildDeltaInput): PosteriorDelta {
  const { execution, run, task, prior, item, executionPath } = input;
  const receipt = item.receipt ?? {};
  const createdAt =
    receipt.endedAt ?? receipt.startedAt ?? run?.createdAt ?? new Date().toISOString();
  const priorId = task?.priorCapsuleBefore?.priorId ?? prior?.priorId ?? "prior-unknown";
  const text = String(item.text ?? item.reason ?? "");
  const sections = parseScoutSections(text);
  const producer: Producer = {
    family: item.family ?? receipt.actualFamily ?? "unknown",
    surface: item.surface ?? receipt.surface ?? "unknown",
    voice: receipt.declaredVoice ?? null,
    modelClaimed: receipt.modelClaimed ?? null,
    modelVerified: typeof receipt.modelVerified === "boolean" ? receipt.modelVerified : null,
  };
  const seed = stableStringify({
    priorId,
    runId: execution.runId ?? run?.runId ?? null,
    dispatchId: execution.dispatchId ?? null,
    family: producer.family,
    surface: producer.surface,
    transcriptSha256: receipt.transcriptSha256 ?? null,
    status: item.status ?? null,
  });
  const suffix = sha256(seed).slice(0, 12);
  const deltaId = `delta-${compactTimestamp(createdAt)}-${suffix}`;
  const taskId = String(
    task?.id ??
      task?.taskId ??
      run?.docketItem?.docketId ??
      run?.runId ??
      execution.runId ??
      "task-unknown",
  );
  const evidence = buildEvidence(config, input, deltaId);
  const claims = buildClaims({
    deltaId,
    item,
    sections,
    producer,
    evidence,
    maxClaims: config.maxClaimsPerDelta,
  });
  const recommendedNextActions = extractRecommendations(text, sections, config.maxRecommendations);
  const openQuestions = [...sections.missingEvidence, ...statusOpenQuestions(item)].slice(
    0,
    config.maxOpenQuestions,
  );
  const confidence = confidenceForExecution(item);
  const authorityImpact: AuthorityImpact =
    item.status === "failed" ? "blocked" : recommendedNextActions.length > 0 ? "proposal" : "none";
  return {
    schemaVersion: "chuck.posterior-delta.v1",
    deltaId,
    priorId,
    producer,
    taskId,
    createdAt,
    claims,
    changedFiles: [],
    evidence,
    dissent: [],
    openQuestions,
    recommendedNextActions,
    confidence,
    authorityImpact,
    mergePolicy: {
      mode: "append-only",
      mayMutatePriorBody: false,
      requiresCompactionGate: true,
      notes:
        "This delta is evidence-bearing input to the shared prior. It cannot rewrite the compact prior body without a separate compaction decision.",
    },
  };
}

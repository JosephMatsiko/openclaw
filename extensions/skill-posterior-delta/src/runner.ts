// runFromExecution — orchestrator equivalent to chuck-posterior-delta.mjs main().

import { join } from "node:path";
import type { PosteriorDeltaConfig } from "./config.js";
import { buildDelta } from "./delta.js";
import { buildReadMarker } from "./readmarker.js";
import type {
  PosteriorDelta,
  PriorRecord,
  ReadMarker,
  RunFromExecutionOptions,
  RunnerExecution,
  RunRecord,
  RunReceipt,
  TaskRecord,
} from "./types.js";
import { ensureDir, expandPath, pathExists, readJson, writeJsonAtomic } from "./util.js";
import { createValidators, validateOrThrow, type PosteriorValidators } from "./validators.js";

function readRunForExecution(execution: RunnerExecution, runsDir: string): RunRecord | null {
  const runId = execution?.runId;
  if (!runId) return null;
  const path = join(runsDir, `${runId}.json`);
  if (!pathExists(path)) return null;
  return readJson<RunRecord>(path);
}

export interface WrittenDelta {
  deltaId: string;
  path: string;
}

export interface WrittenReadMarker {
  markerId: string;
  path: string;
}

export function writeDelta(config: PosteriorDeltaConfig, delta: PosteriorDelta): WrittenDelta {
  ensureDir(config.deltasDir);
  const path = join(config.deltasDir, `${delta.deltaId}.json`);
  writeJsonAtomic(path, delta);
  return { deltaId: delta.deltaId, path };
}

export function writeReadMarker(
  config: PosteriorDeltaConfig,
  marker: ReadMarker,
): WrittenReadMarker {
  ensureDir(config.readMarkersDir);
  const path = join(config.readMarkersDir, `${marker.markerId}.json`);
  writeJsonAtomic(path, marker);
  return { markerId: marker.markerId, path };
}

export interface RunFromExecutionDeps {
  /** Inject precompiled validators (skip schema disk reads in tests). */
  validators?: PosteriorValidators;
}

function resolvePriorPath(
  config: PosteriorDeltaConfig,
  priorPath: string | undefined,
): string | undefined {
  if (!priorPath || priorPath === "latest") return config.latestPriorPath;
  return expandPath(priorPath);
}

export async function runFromExecution(
  config: PosteriorDeltaConfig,
  options: RunFromExecutionOptions,
  deps: RunFromExecutionDeps = {},
): Promise<{
  receipt: RunReceipt;
  deltas: PosteriorDelta[];
  readMarkers: ReadMarker[];
  writtenDeltas: WrittenDelta[];
  writtenReadMarkers: WrittenReadMarker[];
}> {
  const executionPath = expandPath(options.executionPath) ?? options.executionPath;
  if (!executionPath) throw new Error("executionPath is required");
  const includeNonCounting = options.includeNonCounting !== false;
  const writeReadMarkers = options.writeReadMarkers !== false;
  const validators = deps.validators ?? createValidators(config);

  const execution = readJson<RunnerExecution>(executionPath);
  const runPath = expandPath(options.runPath);
  const run = runPath
    ? readJson<RunRecord>(runPath)
    : readRunForExecution(execution, config.runsDir);
  const taskPath = expandPath(options.taskPath);
  const task = taskPath && pathExists(taskPath) ? readJson<TaskRecord>(taskPath) : null;
  const priorPath = resolvePriorPath(config, options.priorPath);
  const prior = priorPath && pathExists(priorPath) ? readJson<PriorRecord>(priorPath) : null;

  const deltas: PosteriorDelta[] = [];
  const readMarkers: ReadMarker[] = [];
  for (const item of Array.isArray(execution.executions) ? execution.executions : []) {
    if (!includeNonCounting && item.countingEligible !== true) continue;
    const delta = buildDelta(config, { execution, run, task, prior, item, executionPath });
    validateOrThrow(
      validators.validateDelta,
      delta,
      `posterior delta for ${item.surface ?? "unknown"}`,
    );
    deltas.push(delta);
    const marker = buildReadMarker({ task, prior, item, delta });
    if (marker) {
      validateOrThrow(
        validators.validateReadMarker,
        marker,
        `read marker for ${item.surface ?? "unknown"}`,
      );
      readMarkers.push(marker);
    }
  }

  const writtenDeltas = options.write ? deltas.map((delta) => writeDelta(config, delta)) : [];
  const writtenReadMarkers =
    options.write && writeReadMarkers
      ? readMarkers.map((marker) => writeReadMarker(config, marker))
      : [];

  const receipt: RunReceipt = {
    ok: true,
    executionPath,
    runId: execution.runId ?? run?.runId ?? null,
    priorId: prior?.priorId ?? task?.priorCapsuleBefore?.priorId ?? "prior-unknown",
    deltaCount: deltas.length,
    readMarkerCount: writeReadMarkers ? readMarkers.length : 0,
    deltas: deltas.map((delta, index) => ({
      deltaId: delta.deltaId,
      path: writtenDeltas[index]?.path ?? null,
      family: delta.producer.family,
      surface: delta.producer.surface,
      confidence: delta.confidence,
      authorityImpact: delta.authorityImpact,
      claimCount: delta.claims.length,
      openQuestionCount: delta.openQuestions.length,
      recommendedNextActionCount: delta.recommendedNextActions.length,
    })),
    readMarkers: readMarkers.map((marker, index) => ({
      markerId: marker.markerId,
      path: writtenReadMarkers[index]?.path ?? null,
      family: marker.reader.family,
      surface: marker.reader.surface,
      result: marker.result,
    })),
  };
  return { receipt, deltas, readMarkers, writtenDeltas, writtenReadMarkers };
}

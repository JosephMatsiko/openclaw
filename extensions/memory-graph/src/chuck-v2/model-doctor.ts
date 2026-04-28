import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHUCK_V2_STATE_DIR, DEFAULT_CHUCK_CONFIG } from "./config.js";
import type {
  ChuckConfig,
  ChuckFamily,
  ChuckFleetEntry,
  DocketItem,
  WorkerHealthSnapshot,
} from "./types.js";

export type SurfaceSetupStatus = "ready" | "unknown" | "blocked";
export type SurfaceExecutionStatus = "registered" | "proven" | "provisional" | "not-registered";

export type RunnerSurfaceProof = {
  surface: string;
  family: ChuckFamily;
  successes: number;
  failures: number;
  latestStatus: "completed" | "failed" | "skipped" | "none";
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  repeatable: boolean;
};

export type SurfaceSetupGuide = {
  family: ChuckFamily;
  surface: string;
  label: string;
  authStorage:
    | "app-session"
    | "cli-auth-store"
    | "browser-profile"
    | "local-daemon"
    | "keychain-ref";
  preferredProbe: string;
  setupAction: string;
  windowPolicy: string;
  notes: string[];
};

export type SurfaceDoctorRow = {
  family: ChuckFamily;
  voice: string;
  surface: string;
  status: SurfaceSetupStatus;
  executionStatus: SurfaceExecutionStatus;
  executionReason: string;
  healthKey: string;
  healthReason: string;
  guide: SurfaceSetupGuide;
  nextAction: string;
  countsAsFamily: boolean;
  countsAsLoadBearingFamily: boolean;
};

export type ModelDoctorReport = {
  generatedAt: string;
  stateDir: string;
  configuredVoices: number;
  configuredFamilies: ChuckFamily[];
  readyFamilies: ChuckFamily[];
  unknownFamilies: ChuckFamily[];
  blockedFamilies: ChuckFamily[];
  executionReadyFamilies: ChuckFamily[];
  configuredButNotExecutableSurfaces: string[];
  canRunMinimumFleet: boolean;
  canRunHighRiskFleet: boolean;
  canRunLoadBearingMinimumFleet: boolean;
  canRunLoadBearingHighRiskFleet: boolean;
  rows: SurfaceDoctorRow[];
};

export type ModelDoctorInput = {
  config?: ChuckConfig;
  health?: WorkerHealthSnapshot;
  executionProofs?: Record<string, RunnerSurfaceProof>;
  generatedAt?: string;
  stateDir?: string;
};

const DEFAULT_SETUP_GUIDES: SurfaceSetupGuide[] = [
  {
    family: "anthropic",
    surface: "claude-cli/exec",
    label: "Claude CLI / Claude Code",
    authStorage: "cli-auth-store",
    preferredProbe: "claude --version && run a harmless prompt probe",
    setupAction:
      "Confirm Claude Max is logged in for Claude CLI/Claude Code, then run the Anthropic surface probe.",
    windowPolicy: "CLI-first; no browser window required unless using claude.ai fallback.",
    notes: [
      "No PAYG Anthropic API key in the core path.",
      "Counts as Anthropic only when actual runner attribution remains Anthropic.",
    ],
  },
  {
    family: "anthropic",
    surface: "claude/web-chat",
    label: "Claude web",
    authStorage: "browser-profile",
    preferredProbe:
      "open claude.ai in the shared Chuck web cockpit and run a harmless web-only prompt probe",
    setupAction:
      "Confirm Claude Max is logged in on claude.ai, then run the Claude web receipt proof.",
    windowPolicy:
      "Use the shared Chuck web cockpit window; web-only proof disables protocol/API fallback.",
    notes: [
      "Same Anthropic family as Claude CLI; never increases independent family count.",
      "No PAYG Anthropic API key in the core path.",
    ],
  },
  {
    family: "anthropic",
    surface: "claude/mac-app",
    label: "Claude Mac app",
    authStorage: "app-session",
    preferredProbe: "open Claude Mac app and run a harmless prompt probe",
    setupAction:
      "Confirm Claude Max is logged in in the Claude Mac app, then run the Claude Mac receipt proof.",
    windowPolicy:
      "Native app fallback; keep one stable app window, select chat/cowork/code mode explicitly, and return focus to Codex after the probe.",
    notes: [
      "Same Anthropic family as Claude CLI; never increases independent family count.",
      "Mac-app modes are modeled as mode metadata on this surface: chat, cowork, and code.",
    ],
  },
  {
    family: "openai",
    surface: "chatgpt/web-chat",
    label: "ChatGPT web/app",
    authStorage: "browser-profile",
    preferredProbe: "open ChatGPT profile and run a harmless prompt probe",
    setupAction: "Confirm ChatGPT Pro is logged in on the shared Chuck web cockpit profile.",
    windowPolicy:
      "Use the shared Chuck web cockpit window; one ChatGPT tab, no extra app/window by default.",
    notes: [
      "No PAYG OpenAI API key in the core path.",
      "Codex CLI/app surfaces should be added as same-family surfaces, not extra family votes.",
    ],
  },
  {
    family: "openai",
    surface: "codex/exec",
    label: "Codex CLI",
    authStorage: "cli-auth-store",
    preferredProbe: "codex --version && codex exec harmless probe",
    setupAction:
      "Confirm Codex uses the paid OpenAI/ChatGPT entitlement or an operator-approved non-PAYG auth path, then run the OpenAI Codex probe.",
    windowPolicy: "CLI-first; no browser window required.",
    notes: [
      "No PAYG OpenAI API key in the core path.",
      "Same OpenAI family; useful for code-grounded intra-family signal.",
    ],
  },
  {
    family: "openai",
    surface: "codex-review/exec",
    label: "Codex review",
    authStorage: "cli-auth-store",
    preferredProbe: "codex exec harmless review-mode probe",
    setupAction:
      "Confirm Codex review-mode CLI can run read-only and uses the same subscription auth posture as Codex.",
    windowPolicy: "CLI-first; no browser window required.",
    notes: ["Same OpenAI family as ChatGPT/Codex; review signal only, never another family vote."],
  },
  {
    family: "openai",
    surface: "chatgpt/mac-app",
    label: "ChatGPT Mac app",
    authStorage: "app-session",
    preferredProbe:
      "node extensions/memory-graph/scripts/research-chatgpt-mac.mjs --calibrate --json, then run a harmless split-proof prompt",
    setupAction:
      "Confirm ChatGPT.app is installed/logged in, grant Screen Recording to the launcher if calibration reports screencapture blocked, then rerun the ChatGPT Mac receipt proof.",
    windowPolicy: "Native app fallback; only load-bearing after repeatable receipt proof.",
    notes: [
      "Same OpenAI family as ChatGPT web/Codex; never increases independent family count.",
      "Native chat pane may expose little/no Accessibility tree; answer attribution currently depends on working macOS screen capture.",
    ],
  },
  {
    family: "google",
    surface: "gemini/cli",
    label: "Gemini CLI",
    authStorage: "cli-auth-store",
    preferredProbe: "gemini --version && run quota-safe prompt probe",
    setupAction:
      "Confirm Google AI Pro/Gemini subscription access for the selected Google surface.",
    windowPolicy: "CLI-first when possible; web fallback uses the shared Chuck web cockpit window.",
    notes: [
      "No PAYG Google API key in the core path.",
      "Quota state must be tracked; exhausted quota means degraded fleet.",
    ],
  },
  {
    family: "google",
    surface: "gemini/web-chat",
    label: "Gemini browser/PWA",
    authStorage: "browser-profile",
    preferredProbe:
      "open gemini.google.com in the shared Chuck web cockpit and run a harmless prompt probe",
    setupAction:
      "Confirm Gemini Pro/AI Pro is available in the browser/PWA session, then run the Gemini web receipt proof.",
    windowPolicy:
      "Use the shared Chuck web cockpit window or Gemini PWA; same Google family, fallback when CLI quota diverges.",
    notes: [
      "No PAYG Google API key in the core path.",
      "Same Google family as Gemini CLI; never increases independent family count.",
      "Useful when browser Pro access is healthy but CLI/AI Studio quota or auth diverges.",
    ],
  },
  {
    family: "perplexity",
    surface: "perplexity/mac-app",
    label: "Perplexity Mac app",
    authStorage: "app-session",
    preferredProbe: "open Perplexity app and run source-grounded harmless probe",
    setupAction:
      "Confirm Perplexity Max Mac app is logged in and its app protocol/driver selectors still work.",
    windowPolicy:
      "Prefer the app if it is stable; the Mac app uses the shared Max profile, so keep work in Incognito session leases instead of closing threads arbitrarily.",
    notes: [
      "No PAYG Perplexity API key in the core path.",
      "Strongest use is live/source-heavy evidence; exact model routing is time-bound.",
      "Shared-Max native/Comet invariant: use Incognito for Chuck and keep long Perplexity sessions alive until completion, expiry, or operator close.",
    ],
  },
  {
    family: "perplexity",
    surface: "perplexity/web",
    label: "Perplexity web",
    authStorage: "browser-profile",
    preferredProbe:
      "open perplexity.ai in the shared Chuck web cockpit and run a harmless prompt probe",
    setupAction:
      "Confirm Perplexity web access in the browser session, then run the Perplexity web receipt proof.",
    windowPolicy:
      "Browser fallback; same-family signal only. This may be Joseph's personal account; prefer the Mac/Comet Incognito lease for shared Max work when available.",
    notes: [
      "No PAYG Perplexity API key in the core path.",
      "Same Perplexity family; strongest use is source-heavy evidence.",
    ],
  },
  {
    family: "sovereign-local",
    surface: "ollama/localhost",
    label: "Ollama local model",
    authStorage: "local-daemon",
    preferredProbe: "ollama list && ollama run selected-model harmless probe",
    setupAction: "Start Ollama and install/select the local sovereignty-floor model.",
    windowPolicy: "Local daemon; no browser window required.",
    notes: [
      "Local model is the sovereignty floor and dissent flag, not automatic equal-weight frontier voter.",
    ],
  },
  {
    family: "xai",
    surface: "grok/web-or-app",
    label: "Grok / xAI",
    authStorage: "browser-profile",
    preferredProbe: "open Grok/X profile and run current-social harmless probe",
    setupAction:
      "Confirm Grok is available in the shared Chuck web cockpit profile and decide whether it graduates.",
    windowPolicy:
      "Use the shared Chuck web cockpit window; one Grok/X tab, no extra app/window by default.",
    notes: ["Best value is X/Twitter-native and fast-moving social/current-event signal."],
  },
];

export function runModelDoctor({
  config = DEFAULT_CHUCK_CONFIG,
  health,
  executionProofs,
  generatedAt = new Date().toISOString(),
  stateDir = CHUCK_V2_STATE_DIR,
}: ModelDoctorInput = {}): ModelDoctorReport {
  const proofs = executionProofs ?? {};
  const rows = config.fleet.map((entry) => doctorRowForEntry(entry, health, proofs[entry.surface]));
  const configuredFamilies = uniqueFamilies(config.fleet.map((entry) => entry.family));
  const readyFamilies = uniqueFamilies(
    rows.filter((row) => row.status === "ready").map((row) => row.family),
  );
  const unknownFamilies = uniqueFamilies(
    rows.filter((row) => row.status === "unknown").map((row) => row.family),
  );
  const blockedFamilies = uniqueFamilies(
    rows.filter((row) => row.status === "blocked").map((row) => row.family),
  );
  const executionReadyFamilies = configuredFamilies.filter((family) =>
    rows.some((row) => row.family === family && row.countsAsLoadBearingFamily),
  );
  const configuredButNotExecutableSurfaces = rows
    .filter((row) => row.status === "ready" && !row.countsAsLoadBearingFamily)
    .map((row) => row.surface);
  return {
    generatedAt,
    stateDir,
    configuredVoices: config.fleet.length,
    configuredFamilies,
    readyFamilies,
    unknownFamilies,
    blockedFamilies,
    executionReadyFamilies,
    configuredButNotExecutableSurfaces,
    canRunMinimumFleet: readyFamilies.length >= config.thresholds.minimumFamilies,
    canRunHighRiskFleet: readyFamilies.length >= config.thresholds.highRiskMinimumFamilies,
    canRunLoadBearingMinimumFleet:
      executionReadyFamilies.length >= config.thresholds.minimumFamilies,
    canRunLoadBearingHighRiskFleet:
      executionReadyFamilies.length >= config.thresholds.highRiskMinimumFamilies,
    rows,
  };
}

export function docketItemsForModelDoctor(report: ModelDoctorReport): DocketItem[] {
  return report.rows
    .filter((row) => row.status !== "ready" || !row.countsAsLoadBearingFamily)
    .map((row) => ({
      docketId: `docket-model-${row.family}-${sanitizeId(row.surface)}`,
      runId: `model-doctor-${report.generatedAt.replaceAll(/[-:.TZ]/g, "").slice(0, 14)}`,
      createdAt: report.generatedAt,
      updatedAt: report.generatedAt,
      status: "needs-setup",
      title:
        row.status === "ready"
          ? `Prove ${row.family} via ${row.surface}`
          : `Wire ${row.family} via ${row.surface}`,
      stakeClass: "medium",
      taskClass: "unknown",
      finalAction: "operator-halt",
      operatorActionRequired: true,
      reasons: [row.healthReason, row.executionReason, row.nextAction],
    }));
}

export function modelDoctorSummary(report: ModelDoctorReport): Record<string, unknown> {
  return {
    configuredVoices: report.configuredVoices,
    configuredFamilies: report.configuredFamilies,
    readyFamilies: report.readyFamilies,
    unknownFamilies: report.unknownFamilies,
    blockedFamilies: report.blockedFamilies,
    executionReadyFamilies: report.executionReadyFamilies,
    configuredButNotExecutableSurfaces: report.configuredButNotExecutableSurfaces,
    canRunMinimumFleet: report.canRunMinimumFleet,
    canRunHighRiskFleet: report.canRunHighRiskFleet,
    canRunLoadBearingMinimumFleet: report.canRunLoadBearingMinimumFleet,
    canRunLoadBearingHighRiskFleet: report.canRunLoadBearingHighRiskFleet,
    nextActions: report.rows
      .filter((row) => row.status !== "ready" || !row.countsAsLoadBearingFamily)
      .map((row) => ({
        family: row.family,
        surface: row.surface,
        status: row.status,
        executionStatus: row.executionStatus,
        nextAction: row.nextAction,
      })),
  };
}

export function workerProbeNamesForConfig(config: ChuckConfig = DEFAULT_CHUCK_CONFIG): string[] {
  return [...new Set(config.fleet.map((entry) => healthKeyForVoice(entry.voice)))];
}

export function loadRunnerSurfaceProofs({
  stateDir = CHUCK_V2_STATE_DIR,
}: {
  stateDir?: string;
} = {}): Record<string, RunnerSurfaceProof> {
  const dir = join(stateDir, "runner-executions");
  if (!existsSync(dir)) {
    return {};
  }
  const proofs = new Map<string, RunnerSurfaceProof>();
  const files = readdirSync(dir)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => {
      const path = join(dir, filename);
      return { filename, path, mtimeMs: statSync(path).mtimeMs };
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs || a.filename.localeCompare(b.filename));
  for (const file of files) {
    const path = file.path;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      continue;
    }
    const mtime = statSync(path).mtime.toISOString();
    const executions = Array.isArray((parsed as { executions?: unknown }).executions)
      ? (parsed as { executions: unknown[] }).executions
      : [];
    for (const raw of executions) {
      if (!raw || typeof raw !== "object") {
        continue;
      }
      const item = raw as {
        family?: unknown;
        surface?: unknown;
        status?: unknown;
        countingEligible?: unknown;
        receipt?: { endedAt?: unknown };
        reason?: unknown;
      };
      const family = item.family as ChuckFamily;
      const surface = typeof item.surface === "string" ? item.surface : "";
      const status =
        item.status === "completed" || item.status === "failed" || item.status === "skipped"
          ? item.status
          : "none";
      if (!surface || !family) {
        continue;
      }
      const proof = proofs.get(surface) ?? {
        surface,
        family,
        successes: 0,
        failures: 0,
        latestStatus: "none" as const,
        repeatable: false,
      };
      if (status === "completed" && item.countingEligible === true) {
        proof.successes += 1;
        proof.lastSuccessAt =
          typeof item.receipt?.endedAt === "string" ? item.receipt.endedAt : mtime;
      } else if (status === "failed") {
        proof.failures += 1;
        proof.lastFailureAt = mtime;
        proof.lastFailureReason = typeof item.reason === "string" ? item.reason : "failed";
      }
      proof.latestStatus = status;
      proof.repeatable = proof.successes >= 2 && status === "completed";
      proofs.set(surface, proof);
    }
  }
  return Object.fromEntries(proofs);
}

function doctorRowForEntry(
  entry: ChuckFleetEntry,
  health?: WorkerHealthSnapshot,
  proof?: RunnerSurfaceProof,
): SurfaceDoctorRow {
  const healthKey = healthKeyForVoice(entry.voice);
  const healthRow = health?.workers[healthKey] ?? health?.workers[entry.voice];
  const guide = guideForEntry(entry);
  const execution = executionStatusForSurface(entry.surface, proof);
  if (!commercialPolicyAllowed(entry)) {
    return {
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      status: "blocked",
      executionStatus: execution.status,
      executionReason: execution.reason,
      healthKey,
      healthReason: `commercial policy ${entry.commercialPolicy} is not allowed for this core surface`,
      guide,
      nextAction:
        "Switch this surface to subscription-only/local-only, or create an explicit operator-approved exception outside the core path.",
      countsAsFamily: false,
      countsAsLoadBearingFamily: false,
    };
  }
  if (entry.surface === "ollama/localhost" && healthRow && !healthRow.healthy) {
    return {
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      status: "blocked",
      executionStatus: execution.status,
      executionReason: execution.reason,
      healthKey,
      healthReason: healthRow.details ?? "local model health probe failed",
      guide,
      nextAction: guide.setupAction,
      countsAsFamily: false,
      countsAsLoadBearingFamily: false,
    };
  }
  if (
    proof?.repeatable &&
    (REGISTERED_RUNNER_SURFACES.has(entry.surface) ||
      PROVISIONAL_RUNNER_SURFACES.has(entry.surface))
  ) {
    return {
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      status: "ready",
      executionStatus: execution.status,
      executionReason: execution.reason,
      healthKey,
      healthReason: `repeatable live receipt proof (${proof.successes} successes); runtime may be on-demand`,
      guide,
      nextAction: nextActionForExecutionStatus(execution.status),
      countsAsFamily: true,
      countsAsLoadBearingFamily: execution.status === "registered" || execution.status === "proven",
    };
  }
  if (!healthRow) {
    return {
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      status: "unknown",
      executionStatus: execution.status,
      executionReason: execution.reason,
      healthKey,
      healthReason: "no health probe result yet",
      guide,
      nextAction: guide.setupAction,
      countsAsFamily: false,
      countsAsLoadBearingFamily: false,
    };
  }
  if (!healthRow.healthy) {
    return {
      family: entry.family,
      voice: entry.voice,
      surface: entry.surface,
      status: "blocked",
      executionStatus: execution.status,
      executionReason: execution.reason,
      healthKey,
      healthReason: healthRow.details ?? "health probe failed",
      guide,
      nextAction: guide.setupAction,
      countsAsFamily: false,
      countsAsLoadBearingFamily: false,
    };
  }
  return {
    family: entry.family,
    voice: entry.voice,
    surface: entry.surface,
    status: "ready",
    executionStatus: execution.status,
    executionReason: execution.reason,
    healthKey,
    healthReason: healthRow.details ?? "healthy",
    guide,
    nextAction: nextActionForExecutionStatus(execution.status),
    countsAsFamily: true,
    countsAsLoadBearingFamily: execution.status === "registered" || execution.status === "proven",
  };
}

function nextActionForExecutionStatus(status: SurfaceExecutionStatus): string {
  if (status === "registered") {
    return "No setup action required. Keep quota and attribution probes current.";
  }
  if (status === "proven") {
    return "Repeatable live receipt proof exists. Keep probing for drift before high-risk runs.";
  }
  if (status === "provisional") {
    return "Account/session probe is ready and an adapter exists, but this surface needs repeatable live receipt proof before it is load-bearing.";
  }
  return "Account/session probe is ready, but this surface still needs a signed Chuck runner adapter before it is load-bearing.";
}

function executionStatusForSurface(
  surface: string,
  proof?: RunnerSurfaceProof,
): { status: SurfaceExecutionStatus; reason: string } {
  if (REGISTERED_RUNNER_SURFACES.has(surface)) {
    return { status: "registered", reason: "signed Chuck runner adapter is registered" };
  }
  if (PROVISIONAL_RUNNER_SURFACES.has(surface)) {
    if (proof?.repeatable) {
      return {
        status: "proven",
        reason: `adapter has repeatable live receipt proof (${proof.successes} successes)`,
      };
    }
    return {
      status: "provisional",
      reason: proof
        ? `adapter exists, but proof is not repeatable (successes=${proof.successes}, failures=${proof.failures}, latest=${proof.latestStatus})`
        : "adapter exists, but live receipt proof is not repeatable enough for load-bearing counting",
    };
  }
  return { status: "not-registered", reason: "no signed Chuck runner adapter registered yet" };
}

const REGISTERED_RUNNER_SURFACES = new Set([
  "ollama/localhost",
  "claude-cli/exec",
  "gemini/cli",
  "codex/exec",
]);

const PROVISIONAL_RUNNER_SURFACES = new Set([
  "chatgpt/web-chat",
  "chatgpt/mac-app",
  "codex-review/exec",
  "claude/web-chat",
  "claude/mac-app",
  "gemini/web-chat",
  "aistudio/web",
  "perplexity/web",
  "perplexity/mac-app",
  "grok/web-or-app",
]);

function commercialPolicyAllowed(entry: ChuckFleetEntry): boolean {
  if (entry.family === "sovereign-local") {
    return entry.commercialPolicy === "local-only";
  }
  return (
    entry.commercialPolicy === "subscription-only" ||
    entry.commercialPolicy === "operator-approved-exception"
  );
}

function guideForEntry(entry: ChuckFleetEntry): SurfaceSetupGuide {
  return (
    DEFAULT_SETUP_GUIDES.find(
      (guide) => guide.family === entry.family && guide.surface === entry.surface,
    ) ??
    DEFAULT_SETUP_GUIDES.find((guide) => guide.family === entry.family) ?? {
      family: entry.family,
      surface: entry.surface,
      label: `${entry.family} / ${entry.surface}`,
      authStorage: "keychain-ref",
      preferredProbe: "run configured harmless probe",
      setupAction: `Create a surface probe for ${entry.family}:${entry.surface} and store secrets as references only.`,
      windowPolicy:
        "Default to shared Chuck web cockpit for browser/PWA surfaces; otherwise prefer CLI/app surface.",
      notes: [
        "Unknown surfaces require explicit rationale, receipt attribution, and Phase 0 calibration.",
      ],
    }
  );
}

function healthKeyForVoice(voice: string): string {
  const map: Record<string, string> = {
    "claude-cli": "claude",
    "claude-ai": "claude-ai",
    "claude-mac": "claude-mac",
    "chatgpt-web": "chatgpt",
    "chatgpt-mac": "chatgpt-mac",
    codex: "codex",
    "codex-review": "codex-review",
    "gemini-cli": "gemini",
    "gemini-web": "gemini-web",
    "gemini-studio": "aistudio",
    "perplexity-mac": "perplexity",
    "perplexity-web": "perplexity",
    grok: "grok",
    "ollama-local": "ollama",
  };
  return map[voice] ?? voice;
}

function uniqueFamilies(families: ChuckFamily[]): ChuckFamily[] {
  return [...new Set(families)];
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

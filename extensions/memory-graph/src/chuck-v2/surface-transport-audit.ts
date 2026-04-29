import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityLedger, CapabilityLedgerEntry } from "./capability-ledger.js";
import { CHUCK_V2_STATE_DIR } from "./config.js";
import {
  surfaceAtlasEntries,
  type SurfaceAtlasEntry,
  type SurfaceFormKind,
} from "./surface-atlas.js";

export type SurfaceTransportCriterion =
  | "open-target"
  | "mode-switch"
  | "prompt-delivery"
  | "answer-attribution"
  | "result-extraction"
  | "workstation-return";

export type SurfaceTransportAuditEntry = {
  surface: string;
  family: string;
  label: string;
  primaryTransport: SurfaceFormKind | "unknown";
  fallbackTransports: SurfaceFormKind[];
  readiness: CapabilityLedgerEntry["readiness"] | "unknown";
  proofGrade: "load-bearing" | "partial" | "missing";
  requiredProofs: SurfaceTransportCriterion[];
  provenProofs: SurfaceTransportCriterion[];
  gaps: SurfaceTransportCriterion[];
  nextAction: string;
  notes: string[];
};

export type SurfaceTransportAudit = {
  generatedAt: string;
  entries: SurfaceTransportAuditEntry[];
  loadBearing: number;
  partial: number;
  missing: number;
};

export type SurfaceTransportProofRecord = {
  surface: string;
  criterion: SurfaceTransportCriterion;
  verdict: "proved" | "missing" | "failed";
  method: string;
  evidence: string;
  checkedAt?: string;
  caveats?: string[];
};

export type SurfaceTransportProofLedger = Record<
  string,
  Partial<Record<SurfaceTransportCriterion, SurfaceTransportProofRecord>>
>;

const DEFAULT_REQUIRED_PROOFS: SurfaceTransportCriterion[] = [
  "open-target",
  "prompt-delivery",
  "answer-attribution",
  "result-extraction",
];

function entryRequiresWorkstationReturn(entry: SurfaceAtlasEntry): boolean {
  return entry.leasePolicy.returnRequired;
}

function entryRequiresModeSwitch(entry: SurfaceAtlasEntry): boolean {
  return entry.controls.some(
    (control) =>
      control.kind !== "command" &&
      control.kind !== "shortcut" &&
      /mode|design|code|customize|project|model/i.test(control.id),
  );
}

function requiredProofsForEntry(entry: SurfaceAtlasEntry): SurfaceTransportCriterion[] {
  return [
    ...DEFAULT_REQUIRED_PROOFS,
    ...(entryRequiresModeSwitch(entry) ? (["mode-switch"] as const) : []),
    ...(entryRequiresWorkstationReturn(entry) ? (["workstation-return"] as const) : []),
  ];
}

function primaryTransportForEntry(entry: SurfaceAtlasEntry): SurfaceFormKind | "unknown" {
  const forms = entry.forms ?? [];
  return forms[0]?.kind ?? "unknown";
}

function fallbackTransportsForEntry(entry: SurfaceAtlasEntry): SurfaceFormKind[] {
  const primary = primaryTransportForEntry(entry);
  return (entry.forms ?? []).map((form) => form.kind).filter((kind) => kind !== primary);
}

function provenProofsForLedgerEntry({
  entry,
  ledgerEntry,
  transportProofs,
}: {
  entry: SurfaceAtlasEntry;
  ledgerEntry?: CapabilityLedgerEntry;
  transportProofs?: Partial<Record<SurfaceTransportCriterion, SurfaceTransportProofRecord>>;
}): SurfaceTransportCriterion[] {
  const proofs: SurfaceTransportCriterion[] = [];
  const hasDurableProof = (criterion: SurfaceTransportCriterion) =>
    transportProofs?.[criterion]?.verdict === "proved";
  for (const criterion of requiredProofsForEntry(entry)) {
    if (hasDurableProof(criterion)) {
      proofs.push(criterion);
    }
  }
  if (!ledgerEntry) {
    return proofs;
  }
  if (
    !proofs.includes("open-target") &&
    (ledgerEntry.readiness === "load-bearing" || ledgerEntry.readiness === "provisional")
  ) {
    proofs.push("open-target");
  }
  if (!proofs.includes("prompt-delivery") && ledgerEntry.promptDeliveryProof.verdict === "proved") {
    proofs.push("prompt-delivery");
  }
  if (
    !proofs.includes("answer-attribution") &&
    ledgerEntry.answerAttributionProof.verdict === "proved"
  ) {
    proofs.push("answer-attribution");
  }
  if (!proofs.includes("result-extraction") && ledgerEntry.extractionMethod !== "unknown") {
    proofs.push("result-extraction");
  }
  if (
    !proofs.includes("workstation-return") &&
    entryRequiresWorkstationReturn(entry) &&
    ledgerEntry.readiness === "load-bearing"
  ) {
    proofs.push("workstation-return");
  }
  return proofs;
}

function nextActionForGaps(gaps: SurfaceTransportCriterion[], entry: SurfaceAtlasEntry): string {
  if (gaps.length === 0) {
    return "Keep drift probes current; rerun transport audit after UI or auth changes.";
  }
  if (gaps.includes("prompt-delivery") || gaps.includes("answer-attribution")) {
    return `Run normal surface proof for ${entry.surface} and persist split prompt/answer proof.`;
  }
  if (gaps.includes("mode-switch")) {
    return `Record repeatable mode-switch proof for ${entry.surface}.`;
  }
  if (gaps.includes("workstation-return")) {
    return `Repair workstation-return receipt for ${entry.surface}.`;
  }
  return `Repair ${gaps[0]} for ${entry.surface}.`;
}

export function buildSurfaceTransportAudit({
  ledger,
  transportProofs = {},
  generatedAt = new Date().toISOString(),
}: {
  ledger?: CapabilityLedger;
  transportProofs?: SurfaceTransportProofLedger;
  generatedAt?: string;
} = {}): SurfaceTransportAudit {
  const bySurface = new Map((ledger?.entries ?? []).map((entry) => [entry.surface, entry]));
  const entries = surfaceAtlasEntries().map((entry) => {
    const ledgerEntry = bySurface.get(entry.surface);
    const requiredProofs = requiredProofsForEntry(entry);
    const provenProofs = provenProofsForLedgerEntry({
      entry,
      ledgerEntry,
      transportProofs: transportProofs[entry.surface],
    });
    const proven = new Set(provenProofs);
    const gaps = requiredProofs.filter((proof) => !proven.has(proof));
    const proofGrade: SurfaceTransportAuditEntry["proofGrade"] =
      gaps.length === 0 && ledgerEntry?.readiness === "load-bearing"
        ? "load-bearing"
        : provenProofs.length > 0
          ? "partial"
          : "missing";
    const nextAction =
      ledgerEntry?.readiness === "blocked"
        ? ledgerEntry.nextRepairAction
        : nextActionForGaps(gaps, entry);
    const readiness: SurfaceTransportAuditEntry["readiness"] = ledgerEntry?.readiness ?? "unknown";
    return {
      surface: entry.surface,
      family: entry.family,
      label: entry.label,
      primaryTransport: primaryTransportForEntry(entry),
      fallbackTransports: fallbackTransportsForEntry(entry),
      readiness,
      proofGrade,
      requiredProofs,
      provenProofs,
      gaps,
      nextAction,
      notes: [
        ...entry.knownIssues,
        ...entry.masteryGaps,
        ...entry.notes,
        ...(ledgerEntry?.caveats ?? []),
      ],
    };
  });
  return {
    generatedAt,
    entries,
    loadBearing: entries.filter((entry) => entry.proofGrade === "load-bearing").length,
    partial: entries.filter((entry) => entry.proofGrade === "partial").length,
    missing: entries.filter((entry) => entry.proofGrade === "missing").length,
  };
}

export function loadSurfaceTransportProofs({
  stateDir = CHUCK_V2_STATE_DIR,
}: {
  stateDir?: string;
} = {}): SurfaceTransportProofLedger {
  const proofs = new Map<
    string,
    Partial<Record<SurfaceTransportCriterion, SurfaceTransportProofRecord>>
  >();
  const addProof = (proof: SurfaceTransportProofRecord) => {
    if (!isSurfaceTransportProofRecord(proof)) {
      return;
    }
    const existing = proofs.get(proof.surface)?.[proof.criterion];
    if (
      existing?.checkedAt &&
      proof.checkedAt &&
      Date.parse(existing.checkedAt) > Date.parse(proof.checkedAt)
    ) {
      return;
    }
    const row = proofs.get(proof.surface) ?? {};
    row[proof.criterion] = proof;
    proofs.set(proof.surface, row);
  };

  const executionDir = join(stateDir, "runner-executions");
  if (existsSync(executionDir)) {
    for (const file of jsonFilesByMtime(executionDir)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file.path, "utf8")) as unknown;
      } catch {
        continue;
      }
      const executions = Array.isArray((parsed as { executions?: unknown }).executions)
        ? (parsed as { executions: unknown[] }).executions
        : [];
      for (const raw of executions) {
        const transportProofs = Array.isArray(
          (raw as { transportProofs?: unknown }).transportProofs,
        )
          ? (raw as { transportProofs: unknown[] }).transportProofs
          : [];
        for (const proof of transportProofs) {
          addProof(proof as SurfaceTransportProofRecord);
        }
      }
    }
  }

  const manualDir = join(stateDir, "surface-transport-proofs");
  if (existsSync(manualDir)) {
    for (const file of jsonFilesByMtime(manualDir)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file.path, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (Array.isArray(parsed)) {
        for (const proof of parsed) {
          addProof(proof as SurfaceTransportProofRecord);
        }
      } else if (isSurfaceTransportProofRecord(parsed)) {
        addProof(parsed);
      } else if (Array.isArray((parsed as { proofs?: unknown }).proofs)) {
        for (const proof of (parsed as { proofs: unknown[] }).proofs) {
          addProof(proof as SurfaceTransportProofRecord);
        }
      }
    }
  }

  return Object.fromEntries(proofs);
}

function jsonFilesByMtime(dir: string): Array<{ path: string; name: string; mtimeMs: number }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

function isSurfaceTransportProofRecord(value: unknown): value is SurfaceTransportProofRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proof = value as Partial<SurfaceTransportProofRecord>;
  return (
    typeof proof.surface === "string" &&
    isSurfaceTransportCriterion(proof.criterion) &&
    (proof.verdict === "proved" || proof.verdict === "missing" || proof.verdict === "failed") &&
    typeof proof.method === "string" &&
    typeof proof.evidence === "string"
  );
}

function isSurfaceTransportCriterion(value: unknown): value is SurfaceTransportCriterion {
  return (
    value === "open-target" ||
    value === "mode-switch" ||
    value === "prompt-delivery" ||
    value === "answer-attribution" ||
    value === "result-extraction" ||
    value === "workstation-return"
  );
}

export function surfaceTransportAuditEntry(
  surface: string,
  audit: SurfaceTransportAudit = buildSurfaceTransportAudit(),
): SurfaceTransportAuditEntry | undefined {
  return audit.entries.find((entry) => entry.surface === surface);
}

export function formatSurfaceTransportAudit(
  audit: SurfaceTransportAudit,
  { surface }: { surface?: string } = {},
): string {
  const entries = surface
    ? audit.entries.filter((entry) => entry.surface === surface)
    : audit.entries;
  const lines = [
    "Chuck Surface Transport Audit",
    `Generated: ${audit.generatedAt}`,
    `Surfaces: ${audit.entries.length}; load-bearing ${audit.loadBearing}; partial ${audit.partial}; missing ${audit.missing}.`,
  ];
  for (const entry of entries) {
    lines.push(
      "",
      `- ${entry.family} · ${entry.surface} · ${entry.proofGrade}`,
      `  primary: ${entry.primaryTransport}; fallback: ${entry.fallbackTransports.join(", ") || "none"}`,
      `  readiness: ${entry.readiness}`,
      `  required: ${entry.requiredProofs.join(", ")}`,
      `  proven: ${entry.provenProofs.join(", ") || "none"}`,
      `  gaps: ${entry.gaps.join(", ") || "none"}`,
      `  next: ${entry.nextAction}`,
    );
  }
  return lines.join("\n");
}

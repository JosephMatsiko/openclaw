#!/usr/bin/env node
// Persist split surface proofs for non-runner capability surfaces.
//
// Model/chat surfaces should prove themselves through runner receipts. This
// helper is for connectors, local tools, and platform surfaces where the proof
// is a successful connector/tool invocation rather than a model answer.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state", "chuck-v2");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
      continue;
    }
    opts[key] = next;
    i += 1;
  }
  return opts;
}

function usage() {
  return [
    "usage: chuck-record-surface-proof.mjs",
    "  --surface SURFACE --family FAMILY --method METHOD --evidence TEXT",
    "  [--verdict proved|failed|missing]",
    "  [--extraction-method connector|http-json|cli-stdout|driver-json|external]",
    "  [--criteria open-target,prompt-delivery,answer-attribution,result-extraction]",
    "  [--caveat TEXT]",
    "  [--transport-only]",
  ].join("\n");
}

function safeName(value) {
  return (
    String(value)
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, "-")
      .replaceAll(/^-|-$/g, "")
      .slice(0, 120) || "surface"
  );
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function proofRecord({ verdict, method, evidence, caveats, checkedAt }) {
  return {
    verdict,
    method,
    evidence,
    caveats,
    checkedAt,
  };
}

function transportProof({ surface, criterion, verdict, method, evidence, caveats, checkedAt }) {
  return {
    surface,
    criterion,
    verdict,
    method,
    evidence,
    caveats,
    checkedAt,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const surface = opts.surface;
  const family = opts.family;
  const method = opts.method;
  const evidence = opts.evidence;
  const transportOnly = opts["transport-only"] === true;
  if (!surface || !method || !evidence || (!transportOnly && !family)) {
    throw new Error(usage());
  }
  const verdict = opts.verdict ?? "proved";
  if (!["proved", "failed", "missing"].includes(verdict)) {
    throw new Error(usage());
  }
  const checkedAt = new Date().toISOString();
  const caveats = opts.caveat ? [opts.caveat] : [];
  const extractionMethod =
    opts["extraction-method"] ?? (verdict === "proved" ? "connector" : "unknown");
  const criteria = (
    opts.criteria ?? "open-target,prompt-delivery,answer-attribution,result-extraction"
  )
    .split(",")
    .map((criterion) => criterion.trim())
    .filter(Boolean);
  const transportProofs = criteria.map((criterion) =>
    transportProof({ surface, criterion, verdict, method, evidence, caveats, checkedAt }),
  );
  const base = `${safeName(surface)}-${Date.now().toString(36)}`;
  const proofPath = join(STATE_DIR, "surface-proof-details", `${base}.json`);
  const transportPath = join(STATE_DIR, "surface-transport-proofs", `${base}.json`);
  if (!transportOnly) {
    const proofDetail = {
      surface,
      family,
      promptDeliveryProof: proofRecord({
        verdict,
        method,
        evidence: `Invocation reached ${surface}: ${evidence}`,
        caveats,
        checkedAt,
      }),
      answerAttributionProof: proofRecord({
        verdict,
        method,
        evidence: `Result attributed to ${surface}: ${evidence}`,
        caveats,
        checkedAt,
      }),
      extractionMethod,
      receiptSignature: `manual-${safeName(surface)}-${Date.now().toString(36)}`,
      receiptEndedAt: checkedAt,
      proofModel: "split",
    };
    writeJsonAtomic(proofPath, proofDetail);
  }
  writeJsonAtomic(transportPath, { proofs: transportProofs });
  console.log(
    JSON.stringify(
      {
        ok: true,
        surface,
        family,
        proofPath: transportOnly ? null : proofPath,
        transportPath,
        criteria,
        transportOnly,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

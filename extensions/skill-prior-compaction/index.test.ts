// Test suite for @openclaw/skill-prior-compaction.
//
// Uses real Ajv validators against the actual prior-compaction-decision.schema.
// chuck-prior-capsule subprocess is injected via deps.refreshPriorCapsule.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appliedCompactionCursor,
  approveDecision,
  assessDelta,
  buildPreviewDecision,
  buildStatus,
  claimDeferralReason,
  collectDissentRefs,
  createDecisionValidator,
  evidenceRefsFor,
  previewDecision,
  promoteClaim,
  receiptOnlyDeferralReason,
  resolveConfig,
  strongerAuthorityImpact,
  strongerConfidence,
  strongerStatus,
  type CompactionDecision,
  type PosteriorDeltaInput,
  type PriorCompactionConfig,
  type PromotedClaim,
} from "./api.js";

const REPO_DESIGN_DIR = resolve(__dirname, "..", "memory-graph", "data", "chuck-v2-design");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "skill-prior-compaction-"));
}

function makeConfig(root: string): PriorCompactionConfig {
  return resolveConfig({
    compactionsDir: join(root, "compactions"),
    deltasDir: join(root, "posterior-deltas"),
    priorsDir: join(root, "priors"),
    docketDir: join(root, "docket"),
    designDir: REPO_DESIGN_DIR,
    priorCapsuleScript: join(root, "no-such-script.mjs"),
    eventsPath: join(root, "apex-events.jsonl"),
  });
}

function writePrior(cfg: PriorCompactionConfig, priorId = "prior-test"): void {
  mkdirSync(cfg.priorsDir, { recursive: true });
  writeFileSync(
    cfg.latestPriorPath,
    JSON.stringify({
      priorId,
      createdAt: "2026-04-30T00:00:00.000Z",
      sourceHash: `sha256:${"a".repeat(64)}`,
    }),
  );
}

function writeDeltaFile(
  cfg: PriorCompactionConfig,
  name: string,
  delta: PosteriorDeltaInput,
): string {
  mkdirSync(cfg.deltasDir, { recursive: true });
  const path = join(cfg.deltasDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(delta));
  return path;
}

function makeDelta(overrides: Partial<PosteriorDeltaInput> = {}): PosteriorDeltaInput {
  const base: PosteriorDeltaInput = {
    schemaVersion: "chuck.posterior-delta.v1",
    deltaId: `delta-20260501T000000Z-${"a".repeat(12)}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    producer: { family: "Claude", surface: "claude-cli" },
    authorityImpact: "proposal",
    confidence: "high",
    evidence: [{ evidenceId: "e1" }],
    claims: [
      {
        claimId: "c1",
        text: "alpha holds",
        status: "supported",
        confidence: "high",
        evidenceRefs: ["e1"],
        dissentRefs: [],
      },
    ],
    dissent: [],
    openQuestions: ["audit lock"],
    recommendedNextActions: ["ship now"],
  };
  return { ...base, ...overrides };
}

describe("config", () => {
  it("clamps + expands paths", () => {
    const cfg = resolveConfig({
      defaultLimit: 5,
      priorCapsuleTimeoutMs: 100,
      compactionsDir: "~/x/y",
    });
    expect(cfg.defaultLimit).toBe(1000); // clamped from 5
    expect(cfg.priorCapsuleTimeoutMs).toBe(60_000); // clamped from 100
    expect(cfg.compactionsDir).toMatch(/\/x\/y$/);
    expect(cfg.approvalToken).toBe("APPROVE_PRIOR_COMPACTION");
  });

  it("derives latestPriorPath from priorsDir", () => {
    const cfg = resolveConfig({ priorsDir: "/data/priors" });
    expect(cfg.latestPriorPath).toBe("/data/priors/latest.json");
  });
});

describe("strength helpers", () => {
  it("strongerStatus picks the higher rank", () => {
    expect(strongerStatus("proposed", "supported")).toBe("supported");
    expect(strongerStatus("contested", "operator-resolved")).toBe("operator-resolved");
    expect(strongerStatus("retracted", "proposed")).toBe("proposed");
  });
  it("strongerConfidence picks the higher rank", () => {
    expect(strongerConfidence("low", "high")).toBe("high");
    expect(strongerConfidence("medium", "low")).toBe("medium");
  });
  it("strongerAuthorityImpact picks the higher rank", () => {
    expect(strongerAuthorityImpact("none", "blocked")).toBe("blocked");
    expect(strongerAuthorityImpact("approval-required", "proposal")).toBe("approval-required");
  });
});

describe("assessDelta + claimDeferralReason", () => {
  it("eligible when schema + evidence + claims present and not blocked", () => {
    const result = assessDelta(makeDelta());
    expect(result.eligible).toBe(true);
  });
  it("rejects blocked authorityImpact", () => {
    const result = assessDelta(makeDelta({ authorityImpact: "blocked" }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("authority impact is blocked");
  });
  it("rejects empty evidence", () => {
    const result = assessDelta(makeDelta({ evidence: [] }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("missing evidence pointers");
  });
  it("flags dissent sidecar", () => {
    const result = assessDelta(makeDelta({ dissent: [{ dissentId: "d1" }] }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("delta carries dissent sidecar");
  });
  it("claimDeferralReason: surfaces deltaReasons before per-claim checks", () => {
    expect(claimDeferralReason(makeDelta(), { text: "ok" }, ["delta-not-eligible"])).toMatch(
      /delta-not-eligible/,
    );
  });
  it("claimDeferralReason: missing text", () => {
    expect(claimDeferralReason(makeDelta(), { text: "  " }, [])).toBe("claim text is missing");
  });
  it("claimDeferralReason: contested status", () => {
    expect(claimDeferralReason(makeDelta(), { text: "ok", status: "contested" }, [])).toMatch(
      /contested/,
    );
  });
  it("claimDeferralReason: dissent refs present", () => {
    expect(claimDeferralReason(makeDelta(), { text: "ok", dissentRefs: ["d1"] }, [])).toBe(
      "claim has dissent references",
    );
  });
});

describe("receiptOnlyDeferralReason", () => {
  it("returns null when no read-canary text anywhere", () => {
    const cfg = makeConfig(tmp());
    expect(receiptOnlyDeferralReason(makeDelta(), cfg)).toBeNull();
  });
  it("returns deferral when delta.taskTitle includes 'read canary'", () => {
    const cfg = makeConfig(tmp());
    const delta = makeDelta({ taskTitle: "read canary preserve marker" });
    expect(receiptOnlyDeferralReason(delta, cfg)).toMatch(/receipt-only read canary/);
  });
});

describe("promoteClaim + evidenceRefsFor + collectDissentRefs", () => {
  it("merges duplicate claims by normalized text and tracks families/surfaces/sources", () => {
    const map = new Map<string, PromotedClaim>();
    promoteClaim(map, makeDelta({ deltaId: "delta-A" }), {
      claimId: "claim-A",
      text: "Alpha Holds",
      status: "supported",
      confidence: "medium",
    });
    promoteClaim(
      map,
      makeDelta({
        deltaId: "delta-B",
        producer: { family: "Grok", surface: "grok-web" },
      }),
      {
        claimId: "claim-B",
        text: "alpha holds  ",
        status: "operator-resolved",
        confidence: "high",
      },
    );
    expect(map.size).toBe(1);
    const [entry] = [...map.values()];
    expect(entry?.text).toBe("Alpha Holds");
    expect(entry?.status).toBe("operator-resolved");
    expect(entry?.confidence).toBe("high");
    expect(entry?.families.toSorted()).toEqual(["Claude", "Grok"]);
    expect(entry?.surfaces.toSorted()).toEqual(["claude-cli", "grok-web"]);
    expect(entry?.sourceDeltaIds.toSorted()).toEqual(["delta-A", "delta-B"]);
  });

  it("evidenceRefsFor falls back to delta evidence when claim refs are empty", () => {
    const refs = evidenceRefsFor(
      makeDelta({ evidence: [{ evidenceId: "e1" }, { evidenceId: "e2" }] }),
      { evidenceRefs: [] },
    );
    expect(refs).toEqual(["e1", "e2"]);
  });

  it("collectDissentRefs gathers from delta.dissent + claim.dissentRefs", () => {
    const out = new Set<string>();
    collectDissentRefs(
      makeDelta({
        dissent: [{ dissentId: "d-from-sidecar" }],
        claims: [
          {
            claimId: "c1",
            text: "x",
            status: "supported",
            confidence: "high",
            evidenceRefs: ["e1"],
            dissentRefs: ["d-from-claim"],
          },
        ],
      }),
      out,
    );
    expect([...out].toSorted()).toEqual(["d-from-claim", "d-from-sidecar"]);
  });
});

describe("buildPreviewDecision + appliedCompactionCursor", () => {
  let root: string;
  let cfg: PriorCompactionConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    writePrior(cfg);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces a deterministic schema-valid draft from a single eligible delta", () => {
    writeDeltaFile(cfg, "delta-1", makeDelta({ deltaId: "delta-1-id" }));
    const validateDecision = createDecisionValidator(cfg);
    const decision = buildPreviewDecision(cfg, { validateDecision });
    expect(decision.schemaVersion).toBe("chuck.prior-compaction-decision.v1");
    expect(decision.decisionId).toMatch(/^compaction-[0-9TZ-]+-[a-f0-9]{12}$/);
    expect(decision.status).toBe("draft");
    expect(decision.includedDeltaIds).toEqual(["delta-1-id"]);
    expect(decision.eligibleDeltaIds).toEqual(["delta-1-id"]);
    expect(decision.promotedClaims).toHaveLength(1);
    expect(decision.openQuestions).toContain("audit lock");
  });

  it("defers a delta with empty evidence (assessment failure cascades to all its claims)", () => {
    writeDeltaFile(cfg, "delta-bad", makeDelta({ deltaId: "delta-bad-id", evidence: [] }));
    const validateDecision = createDecisionValidator(cfg);
    const decision = buildPreviewDecision(cfg, { validateDecision });
    expect(decision.eligibleDeltaIds).toEqual([]);
    expect(decision.deferredDeltaIds).toEqual(["delta-bad-id"]);
    expect(decision.deferredClaims).toHaveLength(1);
    expect(decision.deferredClaims[0]?.reason).toMatch(/missing evidence pointers/);
  });

  it("skips deltas already covered by the applied cursor", () => {
    writeDeltaFile(cfg, "delta-old", makeDelta({ deltaId: "delta-old-id" }));
    writeDeltaFile(cfg, "delta-new", makeDelta({ deltaId: "delta-new-id" }));
    mkdirSync(cfg.compactionsDir, { recursive: true });
    writeFileSync(
      join(cfg.compactionsDir, "compaction-applied.json"),
      JSON.stringify({
        schemaVersion: "chuck.prior-compaction-decision.v1",
        decisionId: "compaction-prev",
        status: "applied",
        appliedAt: "2026-05-01T00:00:00.000Z",
        resultingPriorId: "prior-applied",
        includedDeltaIds: ["delta-old-id"],
      }),
    );
    const cursor = appliedCompactionCursor(cfg);
    expect(cursor.appliedDeltaIds).toEqual(["delta-old-id"]);
    const validateDecision = createDecisionValidator(cfg);
    const decision = buildPreviewDecision(cfg, { validateDecision });
    expect(decision.includedDeltaIds).toEqual(["delta-new-id"]);
    expect(decision.cursor.previousResultingPriorId).toBe("prior-applied");
  });
});

describe("preview command", () => {
  let root: string;
  let cfg: PriorCompactionConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    writePrior(cfg);
    writeDeltaFile(cfg, "delta-x", makeDelta({ deltaId: "delta-x-id" }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns receipt without writing when write=false", async () => {
    const result = await previewDecision(cfg, { write: false });
    expect(result.command).toBe("preview");
    expect(result.writes).toBe(false);
    expect(result.path).toBeNull();
    expect(result.decision.includedDeltaIds).toEqual(["delta-x-id"]);
  });

  it("writes the decision file when write=true and emits draft-written event", async () => {
    const result = await previewDecision(cfg, { write: true });
    expect(result.writes).toBe(true);
    expect(result.path).toMatch(/compactions\/compaction-/);
    const written = JSON.parse(readFileSync(result.path!, "utf8")) as CompactionDecision;
    expect(written.decisionId).toBe(result.decision.decisionId);
    const events = readFileSync(cfg.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "chuck.prior-compaction.draft-written")).toBeDefined();
  });
});

describe("approve command", () => {
  let root: string;
  let cfg: PriorCompactionConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    writePrior(cfg);
    writeDeltaFile(cfg, "delta-x", makeDelta({ deltaId: "delta-x-id" }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects approve without correct confirm token", async () => {
    const draft = await previewDecision(cfg, { write: true });
    await expect(
      approveDecision(cfg, { decision: draft.decision.decisionId, confirm: "WRONG" }),
    ).rejects.toThrow(/APPROVE_PRIOR_COMPACTION/);
  });

  it("transitions draft → applied with injected refreshPriorCapsule", async () => {
    const draft = await previewDecision(cfg, { write: true });
    const refresh = vi.fn(async () => ({
      priorId: "prior-new-from-test",
      path: "/tmp/prior.json",
      latestPath: cfg.latestPriorPath,
    }));
    const result = await approveDecision(
      cfg,
      { decision: draft.decision.decisionId, confirm: "APPROVE_PRIOR_COMPACTION" },
      { refreshPriorCapsule: refresh },
    );
    expect(result.decisionId).toBe(draft.decision.decisionId);
    expect(result.resultingPriorId).toBe("prior-new-from-test");
    expect(refresh).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(readFileSync(result.path, "utf8")) as CompactionDecision;
    expect(persisted.status).toBe("applied");
    expect(persisted.approval?.by).toBe("operator/cockpit");
    const events = readFileSync(cfg.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "chuck.prior-compaction.approved")).toBeDefined();
    expect(events.find((e) => e.type === "chuck.prior-compaction.applied")).toBeDefined();
  });

  it("returns alreadyApplied when status is already applied", async () => {
    const draft = await previewDecision(cfg, { write: true });
    const refresh = vi.fn(async () => ({ priorId: "prior-1" }));
    await approveDecision(
      cfg,
      { decision: draft.decision.decisionId, confirm: "APPROVE_PRIOR_COMPACTION" },
      { refreshPriorCapsule: refresh },
    );
    const second = await approveDecision(
      cfg,
      { decision: draft.decision.decisionId, confirm: "APPROVE_PRIOR_COMPACTION" },
      { refreshPriorCapsule: refresh },
    );
    expect(second.alreadyApplied).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("buildStatus", () => {
  let root: string;
  let cfg: PriorCompactionConfig;
  beforeEach(() => {
    root = tmp();
    cfg = makeConfig(root);
    writePrior(cfg);
    writeDeltaFile(cfg, "delta-x", makeDelta({ deltaId: "delta-x-id" }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns draftPreview + counts even when no compactions exist yet", () => {
    const status = buildStatus(cfg);
    expect(status.available).toBe(true);
    expect(status.compactionsPath).toBe(cfg.compactionsDir);
    expect(status.latestDecision).toBeNull();
    expect(status.unappliedDeltaCount).toBe(1);
    expect(status.draftPreview).not.toBeNull();
    expect(status.draftPreview!.includedDeltaCount).toBe(1);
  });
});

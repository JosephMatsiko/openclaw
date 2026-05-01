// Smoke tests for @openclaw/plugin-memory-graph-prior-delta.
//
// Exercises the four schema invariants + the content-address helpers. The
// validators are pure functions of their inputs — no SQLite, no plugin
// runtime — so this suite can run in milliseconds and is the primary
// proof of correctness for v0.1.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { posteriorDeltaId, priorCapsuleId, sha256, stableStringify } from "./src/hash.js";
import {
  type CrossFamilyContext,
  type GraphMutation,
  SchemaViolation,
  validateAppendOnly,
  validateCompaction,
  validateCompactionPreservesDissent,
  validateCrossFamilyDiscipline,
  validateThreeSignatures,
} from "./src/invariants.js";
import { openStore } from "./src/store.js";
import type { CompactionRecord, PosteriorDelta, PriorCapsule } from "./src/types.js";

function fakeDelta(overrides: Partial<PosteriorDelta> = {}): PosteriorDelta {
  return {
    type: "posterior-delta",
    id: "delta-fake-1",
    prior_hash: "prior-fake-1",
    voice_id: "claude-cli",
    family: "anthropic",
    surface: "cli",
    generated_at: "2026-05-01T00:00:00Z",
    claims: [],
    dissent: [],
    proposed_mutations: [],
    self_doubt_note: null,
    ...overrides,
  };
}

function fakeCompaction(overrides: Partial<CompactionRecord> = {}): CompactionRecord {
  return {
    type: "compaction-record",
    id: "comp-fake-1",
    prior_hash_before: "prior-1",
    prior_hash_after: "prior-2",
    proposer: "compiler",
    approver: "court",
    signer: "notary",
    proposed_at: "2026-05-01T00:00:00Z",
    approved_at: "2026-05-01T00:01:00Z",
    signed_at: "2026-05-01T00:02:00Z",
    removed_delta_ids: [],
    preserved_dissent_ids: [],
    proof_of_equivalence: { method: "schema-check", artifact_hash: "0".repeat(64) },
    rollback_pointer: "rollback-1",
    ...overrides,
  };
}

const VOICE_FAMILIES_CTX: CrossFamilyContext = {
  voiceFamilies: {
    "claude-cli": "anthropic",
    "claude-ai": "anthropic",
    "chatgpt-web": "openai",
    codex: "openai",
    "gemini-cli": "google",
    "grok-web": "xai",
    compiler: "google",
    court: "openai",
    notary: "xai",
  },
};

describe("invariant 1 — append-only", () => {
  test("INSERT on prior-capsule allowed", () => {
    const m: GraphMutation = { kind: "INSERT", target: { type: "prior-capsule", id: "p-1" } };
    expect(() => validateAppendOnly(m)).not.toThrow();
  });

  test("UPDATE on posterior-delta rejected", () => {
    const m: GraphMutation = {
      kind: "UPDATE",
      target: { type: "posterior-delta", id: "d-1" },
      patch: { confidence: 0.9 },
    };
    expect(() => validateAppendOnly(m)).toThrow(SchemaViolation);
  });

  test("DELETE on dissent-record rejected", () => {
    const m: GraphMutation = { kind: "DELETE", target: { type: "dissent-record", id: "x-1" } };
    expect(() => validateAppendOnly(m)).toThrow(SchemaViolation);
  });

  test("UPDATE on prior-capsule.read_markers allowed (sole exception)", () => {
    const m: GraphMutation = {
      kind: "UPDATE",
      target: { type: "prior-capsule", id: "p-1" },
      patch: {
        read_markers: { foo: { voice_id: "foo", read_at: "2026-05-01T00:00:00Z", delta_id: "d" } },
      },
    };
    expect(() => validateAppendOnly(m)).not.toThrow();
  });

  test("UPDATE on prior-capsule.content rejected", () => {
    const m: GraphMutation = {
      kind: "UPDATE",
      target: { type: "prior-capsule", id: "p-1" },
      patch: { content: { summary: "tampered" } },
    };
    expect(() => validateAppendOnly(m)).toThrow(SchemaViolation);
  });

  test("non-prior-delta node types pass through", () => {
    const m: GraphMutation = { kind: "DELETE", target: { type: "claim", id: "c-1" } };
    expect(() => validateAppendOnly(m)).not.toThrow();
  });
});

describe("invariant 2 — compaction preserves dissent", () => {
  test("compaction that drops a dissent is rejected", () => {
    const delta = fakeDelta({
      id: "d-1",
      dissent: [
        {
          id: "dissent-x",
          against_claim_id: "c-1",
          rationale: "...",
          counter_evidence_refs: [],
        },
      ],
    });
    const record = fakeCompaction({ removed_delta_ids: ["d-1"], preserved_dissent_ids: [] });
    expect(() => validateCompactionPreservesDissent(record, [delta])).toThrow(SchemaViolation);
  });

  test("compaction that preserves all dissents passes", () => {
    const delta = fakeDelta({
      id: "d-1",
      dissent: [
        {
          id: "dissent-y",
          against_claim_id: "c-1",
          rationale: "...",
          counter_evidence_refs: [],
        },
      ],
    });
    const record = fakeCompaction({
      removed_delta_ids: ["d-1"],
      preserved_dissent_ids: ["dissent-y"],
    });
    expect(() => validateCompactionPreservesDissent(record, [delta])).not.toThrow();
  });

  test("compaction with no removed deltas trivially passes", () => {
    const record = fakeCompaction();
    expect(() => validateCompactionPreservesDissent(record, [])).not.toThrow();
  });
});

describe("invariant 3 — three distinct signatures", () => {
  test("identical proposer + approver rejected", () => {
    const record = fakeCompaction({ proposer: "alice", approver: "alice", signer: "bob" });
    expect(() => validateThreeSignatures(record)).toThrow(SchemaViolation);
  });

  test("identical approver + signer rejected", () => {
    const record = fakeCompaction({ proposer: "alice", approver: "bob", signer: "bob" });
    expect(() => validateThreeSignatures(record)).toThrow(SchemaViolation);
  });

  test("identical proposer + signer rejected", () => {
    const record = fakeCompaction({ proposer: "alice", approver: "bob", signer: "alice" });
    expect(() => validateThreeSignatures(record)).toThrow(SchemaViolation);
  });

  test("empty proposer rejected", () => {
    const record = fakeCompaction({ proposer: "" });
    expect(() => validateThreeSignatures(record)).toThrow(SchemaViolation);
  });

  test("three distinct voice ids accepted", () => {
    const record = fakeCompaction();
    expect(() => validateThreeSignatures(record)).not.toThrow();
  });
});

describe("invariant 4 — cross-family discipline", () => {
  test("approver shares family with majority — rejected", () => {
    const deltas = [
      fakeDelta({ id: "d-1", voice_id: "claude-cli", family: "anthropic" }),
      fakeDelta({ id: "d-2", voice_id: "claude-ai", family: "anthropic" }),
      fakeDelta({ id: "d-3", voice_id: "chatgpt-web", family: "openai" }),
    ];
    // approver "claude-cli" is anthropic; majority family is anthropic.
    const record = fakeCompaction({
      approver: "claude-cli",
      removed_delta_ids: deltas.map((d) => d.id),
    });
    expect(() => validateCrossFamilyDiscipline(record, deltas, VOICE_FAMILIES_CTX)).toThrow(
      SchemaViolation,
    );
  });

  test("approver from different family — accepted", () => {
    const deltas = [
      fakeDelta({ id: "d-1", voice_id: "claude-cli", family: "anthropic" }),
      fakeDelta({ id: "d-2", voice_id: "claude-ai", family: "anthropic" }),
    ];
    // approver "court" is openai; majority is anthropic.
    const record = fakeCompaction({
      approver: "court",
      removed_delta_ids: deltas.map((d) => d.id),
    });
    expect(() => validateCrossFamilyDiscipline(record, deltas, VOICE_FAMILIES_CTX)).not.toThrow();
  });

  test("missing approver in voice-family registry rejected", () => {
    const deltas = [fakeDelta({ id: "d-1" })];
    const record = fakeCompaction({ approver: "ghost", removed_delta_ids: ["d-1"] });
    expect(() => validateCrossFamilyDiscipline(record, deltas, VOICE_FAMILIES_CTX)).toThrow(
      SchemaViolation,
    );
  });

  test("no contributors — trivially passes (no majority to enforce)", () => {
    const record = fakeCompaction();
    expect(() => validateCrossFamilyDiscipline(record, [], VOICE_FAMILIES_CTX)).not.toThrow();
  });
});

describe("validateCompaction (composite)", () => {
  test("a fully-valid compaction passes", () => {
    const delta = fakeDelta({
      id: "d-1",
      voice_id: "claude-cli",
      family: "anthropic",
      dissent: [
        {
          id: "dissent-z",
          against_claim_id: "c-1",
          rationale: "...",
          counter_evidence_refs: [],
        },
      ],
    });
    const record = fakeCompaction({
      proposer: "compiler",
      approver: "court",
      signer: "notary",
      removed_delta_ids: ["d-1"],
      preserved_dissent_ids: ["dissent-z"],
    });
    expect(() => validateCompaction(record, [delta], VOICE_FAMILIES_CTX)).not.toThrow();
  });

  test("dissent-dropped + same-family approver — rejects on first violation (signatures pass)", () => {
    const delta = fakeDelta({
      id: "d-1",
      voice_id: "claude-cli",
      family: "anthropic",
      dissent: [
        {
          id: "dissent-z",
          against_claim_id: "c-1",
          rationale: "...",
          counter_evidence_refs: [],
        },
      ],
    });
    const record = fakeCompaction({
      proposer: "compiler",
      approver: "claude-cli",
      signer: "notary",
      removed_delta_ids: ["d-1"],
      preserved_dissent_ids: [], // drops dissent
    });
    expect(() => validateCompaction(record, [delta], VOICE_FAMILIES_CTX)).toThrow(SchemaViolation);
  });
});

describe("hash helpers", () => {
  test("stableStringify produces sorted-key json", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  test("priorCapsuleId is deterministic for identical input", () => {
    const args = {
      parent_hash: null,
      content: { summary: "hello", claim_refs: [], dissent_refs: [], evidence_index: {} },
      generated_at: "2026-05-01T00:00:00Z",
    };
    expect(priorCapsuleId(args)).toBe(priorCapsuleId(args));
  });

  test("priorCapsuleId changes when content changes", () => {
    const base = {
      parent_hash: null,
      content: { summary: "a" },
      generated_at: "2026-05-01T00:00:00Z",
    };
    const altered = { ...base, content: { summary: "b" } };
    expect(priorCapsuleId(base)).not.toBe(priorCapsuleId(altered));
  });

  test("posteriorDeltaId is deterministic + responsive to voice_id", () => {
    const args = {
      prior_hash: "abc",
      voice_id: "claude-cli",
      content: { x: 1 },
      generated_at: "2026-05-01T00:00:00Z",
    };
    expect(posteriorDeltaId(args)).toBe(posteriorDeltaId(args));
    expect(posteriorDeltaId(args)).not.toBe(posteriorDeltaId({ ...args, voice_id: "gemini-cli" }));
  });

  test("sha256 is sane", () => {
    expect(sha256("")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("config resolver", () => {
  test("defaults", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.freshnessWindowMinutes).toBe(240);
    expect(c.circuitBreakerThreshold).toBe(5);
    expect(c.synthesizerCandidatePool).toEqual([
      "claude-cli",
      "chatgpt-web",
      "gemini-cli",
      "grok-web",
    ]);
  });

  test("preserves valid overrides", () => {
    const c = resolveConfig({
      enabled: false,
      freshnessWindowMinutes: 60,
      circuitBreakerThreshold: 10,
      synthesizerCandidatePool: ["gemini-cli", "grok-web"],
    });
    expect(c.enabled).toBe(false);
    expect(c.freshnessWindowMinutes).toBe(60);
    expect(c.circuitBreakerThreshold).toBe(10);
    expect(c.synthesizerCandidatePool).toEqual(["gemini-cli", "grok-web"]);
  });

  test("clamps invalid types", () => {
    const c = resolveConfig({ freshnessWindowMinutes: "no" } as unknown as Record<string, unknown>);
    expect(c.freshnessWindowMinutes).toBe(240);
  });
});

describe("v0.2 SQLite store", () => {
  function tmpDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "prior-delta-store-"));
    return join(dir, "graph.sqlite");
  }

  function buildPrior(overrides: Partial<PriorCapsule> = {}): PriorCapsule {
    const generated_at = "2026-05-01T00:00:00.000Z";
    const content = {
      summary: "genesis",
      claim_refs: [],
      dissent_refs: [],
      evidence_index: {},
    };
    const id = priorCapsuleId({ parent_hash: null, content, generated_at });
    return {
      type: "prior-capsule",
      id,
      parent_hash: null,
      content,
      generated_at,
      generated_by: "test",
      read_markers: {},
      ...overrides,
    };
  }

  function buildDelta(overrides: Partial<PosteriorDelta> = {}): PosteriorDelta {
    const prior_hash = overrides.prior_hash ?? "prior-fake";
    const voice_id = overrides.voice_id ?? "claude-cli";
    const generated_at = overrides.generated_at ?? "2026-05-01T00:01:00.000Z";
    const claims = overrides.claims ?? [
      { id: "c1", statement: "x", confidence: 0.9, evidence_refs: [] },
    ];
    const dissent = overrides.dissent ?? [];
    const proposed_mutations = overrides.proposed_mutations ?? [];
    const id = posteriorDeltaId({
      prior_hash,
      voice_id,
      content: { claims, dissent, proposed_mutations },
      generated_at,
    });
    return {
      type: "posterior-delta",
      id,
      prior_hash,
      voice_id,
      family: overrides.family ?? "anthropic",
      surface: overrides.surface ?? "cli",
      generated_at,
      claims,
      dissent,
      proposed_mutations,
      self_doubt_note: overrides.self_doubt_note ?? null,
    };
  }

  test("schema creates fresh; stats reports zeros", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const stats = store.stats();
    expect(stats).toEqual({
      priorCapsules: 0,
      posteriorDeltas: 0,
      compactionRecords: 0,
      dissentRecords: 0,
    });
    store.close();
    rmSync(path, { force: true });
  });

  test("write + read prior-capsule round-trip", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const prior = buildPrior();
    store.writePriorCapsule(prior);
    const back = store.getPriorByHash(prior.id);
    expect(back?.id).toBe(prior.id);
    expect(back?.content.summary).toBe("genesis");
    expect(store.stats().priorCapsules).toBe(1);
    store.close();
    rmSync(path, { force: true });
  });

  test("getCurrentPrior returns the prior with no descendant", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const genesis = buildPrior();
    store.writePriorCapsule(genesis);
    const second = buildPrior({
      generated_at: "2026-05-01T00:05:00.000Z",
      content: { summary: "second", claim_refs: [], dissent_refs: [], evidence_index: {} },
      parent_hash: genesis.id,
    });
    // Recompute id since content changed
    const secondId = priorCapsuleId({
      parent_hash: genesis.id,
      content: second.content,
      generated_at: second.generated_at,
    });
    store.writePriorCapsule({ ...second, id: secondId });
    const current = store.getCurrentPrior();
    expect(current?.id).toBe(secondId);
    store.close();
    rmSync(path, { force: true });
  });

  test("posterior-delta write rejects mismatched id (content-address invariant)", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const delta = buildDelta();
    const tampered = { ...delta, id: "delta-fake-tampered" };
    expect(() => store.writePosteriorDelta(tampered)).toThrow(/id mismatch/);
    store.close();
    rmSync(path, { force: true });
  });

  test("listDeltasForPrior returns all deltas in generated_at order", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const d1 = buildDelta({ voice_id: "claude-cli", generated_at: "2026-05-01T00:01:00.000Z" });
    const d2 = buildDelta({
      voice_id: "gemini-cli",
      family: "google",
      generated_at: "2026-05-01T00:02:00.000Z",
    });
    store.writePosteriorDelta(d1);
    store.writePosteriorDelta(d2);
    const deltas = store.listDeltasForPrior("prior-fake");
    expect(deltas.map((d) => d.voice_id)).toEqual(["claude-cli", "gemini-cli"]);
    store.close();
    rmSync(path, { force: true });
  });

  test("recordRead updates read-markers for the prior", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const prior = buildPrior();
    store.writePriorCapsule(prior);
    store.recordRead(prior.id, {
      voice_id: "claude-cli",
      read_at: "2026-05-01T00:10:00.000Z",
      delta_id: "delta-x",
    });
    const back = store.getPriorByHash(prior.id);
    expect(back?.read_markers["claude-cli"]?.delta_id).toBe("delta-x");
    store.close();
    rmSync(path, { force: true });
  });

  test("compaction-record write enforces all four invariants", () => {
    const path = tmpDb();
    const store = openStore({ dbPath: path });
    const ctx: CrossFamilyContext = {
      voiceFamilies: {
        "claude-cli": "anthropic",
        compiler: "google",
        court: "openai",
        notary: "xai",
      },
    };
    const delta = buildDelta({
      voice_id: "claude-cli",
      family: "anthropic",
      dissent: [
        {
          id: "dissent-z",
          against_claim_id: "c1",
          rationale: "...",
          counter_evidence_refs: [],
        },
      ],
    });
    // Bad: drops dissent.
    const badRecord: CompactionRecord = {
      type: "compaction-record",
      id: "comp-bad",
      prior_hash_before: "prior-1",
      prior_hash_after: "prior-2",
      proposer: "compiler",
      approver: "court",
      signer: "notary",
      proposed_at: "2026-05-01T00:00:00Z",
      approved_at: "2026-05-01T00:01:00Z",
      signed_at: "2026-05-01T00:02:00Z",
      removed_delta_ids: [delta.id],
      preserved_dissent_ids: [],
      proof_of_equivalence: { method: "schema-check", artifact_hash: "0".repeat(64) },
      rollback_pointer: "rollback-1",
    };
    expect(() => store.writeCompactionRecord(badRecord, [delta], ctx)).toThrow(SchemaViolation);
    expect(store.stats().compactionRecords).toBe(0);

    // Good: preserves dissent + cross-family approver.
    const goodRecord: CompactionRecord = {
      ...badRecord,
      id: "comp-good",
      preserved_dissent_ids: ["dissent-z"],
    };
    store.writeCompactionRecord(goodRecord, [delta], ctx);
    expect(store.stats().compactionRecords).toBe(1);
    store.close();
    rmSync(path, { force: true });
  });
});

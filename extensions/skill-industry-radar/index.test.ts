// Smoke tests for @openclaw/skill-industry-radar.
//
// Exercises score heuristics + scan orchestration with synthesized commits.
// The live `gh api` fetch path requires `gh auth` — covered separately by
// running `node scripts/chuck-industry-radar.mjs run` against the LaunchAgent
// invocation in production.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { buildDigestMarkdown } from "./src/digest.js";
import { runScan, summarizeStatus } from "./src/scan.js";
import { scoreCommit } from "./src/score.js";
import type { RawCommit, RepoSource } from "./src/types.js";

const REPO: RepoSource = { id: "openclaw/openclaw", owner: "openclaw", repo: "openclaw" };

function commit(message: string, author = "Pete Steinberger"): RawCommit {
  return {
    sha: "abcdef1234567890",
    commit: { message, author: { name: author, date: "2026-04-29T12:00:00Z" } },
    html_url: "https://example.test/commit/abcdef1",
  };
}

describe("config resolver", () => {
  test("applies defaults", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.ghCliPath).toBe("gh");
    expect(r.perRepoCap).toBe(8);
    expect(r.fallbackLookbackHours).toBe(36);
  });

  test("clamps invalid values", () => {
    const r = resolveConfig({ perRepoCap: 999 } as unknown as Record<string, unknown>);
    expect(r.perRepoCap).toBe(8);
  });
});

describe("scoreCommit", () => {
  test("AGENTS.md mention scores high", () => {
    const score = scoreCommit(
      commit("docs(plugins): update src/plugins/AGENTS.md with new cache rule"),
      REPO,
    );
    expect(score).toBeGreaterThanOrEqual(5);
  });

  test("refactor commit scores", () => {
    expect(
      scoreCommit(commit("refactor(plugins): simplify plugin cache boundaries"), REPO),
    ).toBeGreaterThanOrEqual(4);
  });

  test("breaking change scores high", () => {
    expect(
      scoreCommit(commit("feat: new api\n\nBREAKING CHANGE: removed old api"), REPO),
    ).toBeGreaterThanOrEqual(8);
  });

  test("docs typo demerit goes negative", () => {
    expect(scoreCommit(commit("docs: fix typo in README"), REPO)).toBeLessThan(0);
  });

  test("dependabot demerit goes negative", () => {
    expect(scoreCommit(commit("chore(deps): bump xyz", "dependabot[bot]"), REPO)).toBeLessThan(0);
  });

  test("test-only demerit goes negative", () => {
    expect(scoreCommit(commit("test(foo): add coverage"), REPO)).toBeLessThanOrEqual(0);
  });

  test("repo weight multiplies score", () => {
    const base = scoreCommit(commit("refactor: simplify boundaries"), REPO);
    const weighted = scoreCommit(commit("refactor: simplify boundaries"), { ...REPO, weight: 2 });
    expect(weighted).toBeGreaterThanOrEqual(base * 2);
  });
});

describe("buildDigestMarkdown", () => {
  test("renders headers + scored commits + skipped sources", () => {
    const md = buildDigestMarkdown(
      [
        {
          source: "openclaw/openclaw",
          ok: true,
          total: 5,
          surfaced: 1,
          commits: [
            {
              sha: "abc1234",
              commit: { author: { name: "Pete", date: "2026-04-29" }, message: "refactor: x" },
              html_url: "https://example.test/c/1",
              _score: 4,
              _repo: "openclaw/openclaw",
            },
          ],
        },
        { source: "gmail", ok: false, skipped: true, reason: "deferred" },
      ],
      "2026-04-30T00:00:00Z",
      "2026-04-30T01:00:00Z",
    );
    expect(md).toContain("# Industry Radar — 2026-04-30");
    expect(md).toContain("Upstream commits (1 flagged)");
    expect(md).toContain("score=4");
    expect(md).toContain("refactor: x");
    expect(md).toContain("gmail");
    expect(md).toContain("deferred");
  });

  test("handles failed repo cleanly", () => {
    const md = buildDigestMarkdown(
      [
        { source: "broken/repo", ok: false, error: "not authenticated" },
        { source: "gmail", ok: false, skipped: true, reason: "deferred" },
      ],
      "2026-04-30T00:00:00Z",
      "2026-04-30T01:00:00Z",
    );
    expect(md).toContain("⚠ scan failed");
    expect(md).toContain("not authenticated");
  });

  test("handles clean repo (zero surfaced)", () => {
    const md = buildDigestMarkdown(
      [
        { source: "quiet/repo", ok: true, total: 12, surfaced: 0, commits: [] },
        { source: "gmail", ok: false, skipped: true, reason: "deferred" },
      ],
      "2026-04-30T00:00:00Z",
      "2026-04-30T01:00:00Z",
    );
    expect(md).toContain("clean (12 commits scanned, none flagged)");
  });
});

describe("runScan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-industry-radar-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns ok=false when no sources configured", async () => {
    const config = resolveConfig({ stateDir: dir, eventsPath: join(dir, "events.jsonl") });
    const result = await runScan({}, config);
    expect(result.ok).toBe(false);
  });

  test("runs end-to-end with injected fetcher (no gh CLI required)", async () => {
    const config = resolveConfig({
      stateDir: dir,
      eventsPath: join(dir, "events.jsonl"),
    });
    const fakeFetch = (repo: RepoSource, _since: string) => ({
      ok: true,
      commits: [commit("refactor: tighten boundaries"), commit("docs: typo")],
    });
    const result = await runScan(
      {
        sourcesOverride: { repos: [REPO] },
        fetchCommits: fakeFetch,
        now: Date.parse("2026-04-30T12:00:00Z"),
      },
      config,
    );
    expect(result.ok).toBe(true);
    expect(result.summary.reposOk).toBe(1);
    expect(result.summary.commitsSurfaced).toBe(1); // only refactor scored > 0
    expect(existsSync(join(dir, "digest-2026-04-30.md"))).toBe(true);
    expect(existsSync(join(dir, "raw-2026-04-30.json"))).toBe(true);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  test("dryRun skips writes", async () => {
    const config = resolveConfig({ stateDir: dir, eventsPath: join(dir, "events.jsonl") });
    const fakeFetch = () => ({ ok: true, commits: [commit("refactor: x")] });
    const result = await runScan(
      {
        sourcesOverride: { repos: [REPO] },
        fetchCommits: fakeFetch,
        dryRun: true,
        now: Date.parse("2026-04-30T12:00:00Z"),
      },
      config,
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "digest-2026-04-30.md"))).toBe(false);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  test("emits commit_flagged for each scored commit", async () => {
    const config = resolveConfig({ stateDir: dir, eventsPath: join(dir, "events.jsonl") });
    const fakeFetch = () => ({
      ok: true,
      commits: [commit("refactor: x"), commit("feat: y")],
    });
    await runScan(
      {
        sourcesOverride: { repos: [REPO] },
        fetchCommits: fakeFetch,
        now: Date.parse("2026-04-30T12:00:00Z"),
      },
      config,
    );
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const flagged = events.filter((e) => e.type === "chuck.industry.radar.commit_flagged");
    expect(flagged.length).toBe(2);
    expect(events.some((e) => e.type === "chuck.industry.radar.scan_started")).toBe(true);
    expect(events.some((e) => e.type === "chuck.industry.radar.scan_completed")).toBe(true);
  });

  test("respects perRepoCap", async () => {
    const config = resolveConfig({
      stateDir: dir,
      eventsPath: join(dir, "events.jsonl"),
      perRepoCap: 2,
    });
    const fakeFetch = () => ({
      ok: true,
      commits: Array.from({ length: 5 }, () => commit("refactor: x")),
    });
    const result = await runScan(
      {
        sourcesOverride: { repos: [REPO] },
        fetchCommits: fakeFetch,
        now: Date.parse("2026-04-30T12:00:00Z"),
      },
      config,
    );
    const sig = result.signals?.find((s) => s.source === REPO.id) as
      | { surfaced?: number; commits?: unknown[] }
      | undefined;
    expect(sig?.surfaced).toBe(5); // surfaced count = total scored
    expect(sig?.commits?.length).toBe(2); // capped to 2 in the digest list
  });

  test("summarizeStatus returns no-scan-yet when state.json missing", () => {
    const config = resolveConfig({ stateDir: dir });
    const status = summarizeStatus(config);
    expect("message" in status ? status.message : "").toContain("no scan run yet");
  });
});

// Smoke tests for @openclaw/skill-morning-digest.
//
// Exercises pure compute + format paths over a synthesized docket. The post
// path (Telegram via skill-reach-cascade) is verified by the cascade's own
// suite; we don't fire real channels here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveConfig } from "./src/config.js";
import { computeDigest, computeWindow } from "./src/digest.js";
import { fmtBanner, fmtMarkdown, fmtSummary, formatAll } from "./src/format.js";
import { writeReceipt } from "./src/receipt.js";

function makeTask(
  id: string,
  status: string,
  finishedHoursAgo: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now();
  const finishedAt = finishedHoursAgo == null ? null : new Date(now - finishedHoursAgo * 3_600_000);
  return {
    id,
    title: `task ${id}`,
    status,
    createdAt: new Date(now - 48 * 3_600_000).toISOString(),
    updatedAt: finishedAt ? finishedAt.toISOString() : new Date(now).toISOString(),
    finishedAt: finishedAt ? finishedAt.toISOString() : null,
    ...extra,
  };
}

describe("config resolver", () => {
  test("applies defaults for empty config", () => {
    const r = resolveConfig({});
    expect(r.enabled).toBe(true);
    expect(r.telegramChatId).toBe("8630163522");
    expect(r.anchorHour).toBe(8);
    expect(r.anchorMinute).toBe(5);
    expect(r.windowSectionMaxItems).toBe(8);
    expect(r.bannerMaxChars).toBe(180);
  });

  test("clamps invalid anchor hour back to default", () => {
    const r = resolveConfig({ anchorHour: 99 } as unknown as Record<string, unknown>);
    expect(r.anchorHour).toBe(8);
  });

  test("expands ~ paths", () => {
    const r = resolveConfig({ docketDir: "~/somewhere" });
    expect(r.docketDir.startsWith("/")).toBe(true);
    expect(r.docketDir.endsWith("/somewhere")).toBe(true);
  });
});

describe("computeWindow", () => {
  test("anchors to YESTERDAY's anchor hour", () => {
    const config = resolveConfig({ anchorHour: 8, anchorMinute: 5 });
    const noon = new Date("2026-05-01T12:00:00Z");
    const window = computeWindow(config, noon);
    // Always anchored to YESTERDAY's anchor hour:minute local time, so the
    // window is between ~0h (just past today's anchor in some TZs) and ~48h.
    // Verify start is in the past and within ~2 days.
    expect(window.startMs).toBeLessThan(window.endMs);
    expect(window.endMs - window.startMs).toBeLessThan(48 * 3_600_000);
    expect(window.endMs - window.startMs).toBeGreaterThan(0);
  });

  test("yields a positive window when called before today's anchor", () => {
    const config = resolveConfig({ anchorHour: 8, anchorMinute: 5 });
    const earlyMorning = new Date("2026-05-01T05:00:00Z");
    const window = computeWindow(config, earlyMorning);
    const durationMs = window.endMs - window.startMs;
    expect(durationMs).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(48 * 3_600_000);
  });

  test("anchorHour=anchorMinute=0 produces a window starting yesterday at midnight local", () => {
    const config = resolveConfig({ anchorHour: 0, anchorMinute: 0 });
    const sometime = new Date("2026-05-01T15:00:00Z");
    const window = computeWindow(config, sometime);
    // Yesterday at midnight local = within (~24h, ~48h) of now-as-UTC-15:00.
    const durationMs = window.endMs - window.startMs;
    expect(durationMs).toBeGreaterThan(15 * 3_600_000);
    expect(durationMs).toBeLessThan(48 * 3_600_000);
  });
});

describe("computeDigest + format", () => {
  let dir: string;
  let docketDir: string;
  let eventsPath: string;
  let digestDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-morning-digest-"));
    docketDir = join(dir, "docket");
    digestDir = join(dir, "digest");
    eventsPath = join(dir, "events.jsonl");
    mkdirSync(docketDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureDocket() {
    writeFileSync(
      join(docketDir, "task-shipped.json"),
      JSON.stringify(makeTask("ship-1", "completed", 6)),
    );
    writeFileSync(
      join(docketDir, "task-blocked.json"),
      JSON.stringify(makeTask("block-1", "blocked", 3)),
    );
    writeFileSync(
      join(docketDir, "task-failed.json"),
      JSON.stringify(makeTask("fail-1", "failed", 2)),
    );
    writeFileSync(
      join(docketDir, "task-awaiting.json"),
      JSON.stringify(makeTask("wait-1", "pending", null, { awaiting: "joseph" })),
    );
  }

  test("counts shipped / blockers / awaiting from a synthesized docket", () => {
    fixtureDocket();
    const config = resolveConfig({ docketDir, eventsPath, digestDir });
    const data = computeDigest(config);
    expect(data.shipped.length).toBe(1);
    expect(data.shipped[0].id).toBe("ship-1");
    expect(data.blockers.length).toBe(2);
    expect(data.blockers.map((t) => t.id).sort()).toEqual(["block-1", "fail-1"]);
    expect(data.awaiting.length).toBe(1);
    expect(data.awaiting[0].id).toBe("wait-1");
  });

  test("reads chuck.decision.* events from apex-events.jsonl in window", () => {
    fixtureDocket();
    const now = Date.now();
    const inWindowTs = new Date(now - 6 * 3_600_000).toISOString();
    const outOfWindowTs = new Date(now - 72 * 3_600_000).toISOString();
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          ts: inWindowTs,
          type: "chuck.decision.auto-applied",
          source: "test",
        }),
        JSON.stringify({
          ts: inWindowTs,
          type: "chuck.notify.delivered",
          source: "test",
        }),
        JSON.stringify({
          ts: outOfWindowTs,
          type: "chuck.decision.proposed",
          source: "test",
        }),
        "",
      ].join("\n"),
    );
    const config = resolveConfig({ docketDir, eventsPath, digestDir });
    const data = computeDigest(config);
    expect(data.decisions.length).toBe(1);
    expect(data.decisions[0].type).toBe("chuck.decision.auto-applied");
  });

  test("formatAll produces markdown / banner / json", () => {
    fixtureDocket();
    const config = resolveConfig({ docketDir, eventsPath, digestDir });
    const data = computeDigest(config);
    const out = formatAll(data, config);
    expect(out.markdown).toContain("# Chuck morning digest");
    expect(out.markdown).toContain("Shipped (1)");
    expect(out.markdown).toContain("Blockers / failed (2)");
    expect(out.banner).toContain("Chuck digest");
    expect(out.banner.length).toBeLessThanOrEqual(180);
    expect(out.summary.counts.shipped).toBe(1);
    expect(out.summary.counts.blockers).toBe(2);
    expect(out.summary.counts.awaiting).toBe(1);
  });

  test("writeReceipt persists same-day file", () => {
    fixtureDocket();
    const config = resolveConfig({ docketDir, eventsPath, digestDir });
    const data = computeDigest(config);
    const md = fmtMarkdown(data, config.windowSectionMaxItems);
    const bn = fmtBanner(data, config.bannerMaxChars);
    const sm = fmtSummary(data);
    const path = writeReceipt(
      { data, summary: sm, markdown: md, banner: bn, telegramPosted: false },
      config,
    );
    expect(path).toBeTruthy();
    expect(path?.startsWith(digestDir)).toBe(true);
    expect(path?.endsWith(".json")).toBe(true);
  });
});

describe("banner truncation", () => {
  test("respects bannerMaxChars", () => {
    const config = resolveConfig({ bannerMaxChars: 60 });
    const data = {
      window: {
        startMs: Date.now() - 86_400_000,
        startIso: new Date(Date.now() - 86_400_000).toISOString(),
        endMs: Date.now(),
        endIso: new Date().toISOString(),
      },
      shipped: Array(99).fill({
        id: "x",
        title: "x",
        status: "completed",
        awaiting: null,
        updatedAt: null,
        finishedAt: null,
        createdAt: null,
        raw: {},
      }),
      blockers: [],
      decisions: [],
      awaiting: [],
    };
    const banner = fmtBanner(data, config.bannerMaxChars);
    expect(banner.length).toBeLessThanOrEqual(config.bannerMaxChars);
  });
});

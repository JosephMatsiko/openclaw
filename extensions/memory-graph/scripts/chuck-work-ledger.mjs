#!/usr/bin/env node
// Chuck Work Ledger — shared lane awareness for parallel agents.
//
// This is the small, durable handshake between Claude, Codex, Chuck, and any
// future worker. A worker records what it is doing, which files it touched,
// what verified, and what blocked it. The dashboard can then show the live
// coordination state instead of relying on each worker to rediscover the mess.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state", "chuck-v2");
const LEDGER_PATH = join(STATE_DIR, "parallel-work-ledger.jsonl");
const LATEST_PATH = join(STATE_DIR, "parallel-work-latest.json");
const DEFAULT_LIMIT = 20;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
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
    "usage: chuck-work-ledger.mjs status [--json] [--limit N]",
    "       chuck-work-ledger.mjs scan --agent NAME [--lane NAME] [--summary TEXT] [--json]",
    "       chuck-work-ledger.mjs record --agent NAME --lane NAME --status STATUS --summary TEXT [--files a,b] [--evidence TEXT] [--json]",
  ].join("\n");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function appendJsonLine(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function git(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function normalizeGitPath(path) {
  const text = String(path ?? "").trim();
  const renameIndex = text.lastIndexOf(" -> ");
  return renameIndex >= 0 ? text.slice(renameIndex + 4).trim() : text;
}

function fileMtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function currentGitSnapshot({ cwd = process.cwd(), limit = 200 } = {}) {
  const status = git(["status", "--short"], { cwd });
  const branch = git(["branch", "--show-current"], { cwd });
  if (!status.ok) {
    return {
      available: false,
      reason: status.stderr || "git status failed",
      branch: branch.stdout.trim() || null,
      dirtyCount: 0,
      files: [],
    };
  }
  const rows = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const path = normalizeGitPath(line.slice(3));
      return {
        code,
        path,
        staged: code[0] !== " " && code[0] !== "?",
        unstaged: code[1] !== " " || code === "??",
        mtime: fileMtime(path),
      };
    });
  return {
    available: true,
    branch: branch.stdout.trim() || null,
    dirtyCount: rows.length,
    files: rows.slice(0, limit),
  };
}

function readLedger({ limit = DEFAULT_LIMIT } = {}) {
  if (!existsSync(LEDGER_PATH)) {
    return [];
  }
  return readFileSync(LEDGER_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .toReversed();
}

function summarize(events, gitSnapshot) {
  const byLane = new Map();
  for (const event of events.toReversed()) {
    const key = event.lane ?? "default";
    if (!byLane.has(key)) {
      byLane.set(key, event);
    }
  }
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    ledgerPath: LEDGER_PATH,
    latestPath: LATEST_PATH,
    latestEvent: events[0] ?? null,
    events,
    lanes: [...byLane.values()].map((event) => ({
      lane: event.lane,
      agent: event.agent,
      status: event.status,
      summary: event.summary,
      updatedAt: event.createdAt,
      files: event.files ?? [],
    })),
    git: gitSnapshot,
  };
}

function recordEvent({
  agent,
  lane,
  status,
  summary,
  files = [],
  evidence = [],
  source = "manual",
}) {
  const gitSnapshot = currentGitSnapshot({ limit: 80 });
  const event = {
    id: `work-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    agent,
    lane,
    status,
    summary,
    files,
    evidence,
    source,
    gitBranch: gitSnapshot.branch,
    dirtyCountAtRecord: gitSnapshot.dirtyCount,
  };
  appendJsonLine(LEDGER_PATH, event);
  const events = readLedger({ limit: DEFAULT_LIMIT });
  const latest = summarize(events, gitSnapshot);
  writeJsonAtomic(LATEST_PATH, latest);
  return { ok: true, event, latest };
}

function status({ limit = DEFAULT_LIMIT } = {}) {
  const events = readLedger({ limit });
  const gitSnapshot = currentGitSnapshot({ limit: 200 });
  const latest = summarize(events, gitSnapshot);
  writeJsonAtomic(LATEST_PATH, latest);
  return latest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const command = opts._[0] ?? "status";
  const json = opts.json === true;
  if (command === "status") {
    const result = status({ limit: Number(opts.limit ?? DEFAULT_LIMIT) });
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatStatus(result));
    return;
  }
  if (command === "scan") {
    const gitSnapshot = currentGitSnapshot({ limit: 200 });
    const agent = opts.agent || process.env.CHUCK_AGENT || "codex";
    const lane = opts.lane || "workspace-scan";
    const summary =
      opts.summary ||
      `${gitSnapshot.dirtyCount} dirty file(s) observed on ${gitSnapshot.branch || "unknown branch"}`;
    const result = recordEvent({
      agent,
      lane,
      status: opts.status || "observed",
      summary,
      files: gitSnapshot.files.map((file) => file.path),
      evidence: [
        `dirtyCount=${gitSnapshot.dirtyCount}`,
        `branch=${gitSnapshot.branch || "unknown"}`,
      ],
      source: "git-scan",
    });
    process.stdout.write(
      json ? `${JSON.stringify(result, null, 2)}\n` : formatStatus(result.latest),
    );
    return;
  }
  if (command === "record") {
    if (!opts.agent || !opts.lane || !opts.status || !opts.summary) {
      throw new Error(usage());
    }
    const result = recordEvent({
      agent: opts.agent,
      lane: opts.lane,
      status: opts.status,
      summary: opts.summary,
      files: splitList(opts.files),
      evidence: splitList(opts.evidence),
      source: opts.source || "manual",
    });
    process.stdout.write(
      json ? `${JSON.stringify(result, null, 2)}\n` : formatStatus(result.latest),
    );
    return;
  }
  throw new Error(usage());
}

function formatStatus(result) {
  const lines = [
    "Chuck Work Ledger",
    `generated: ${result.generatedAt}`,
    `branch: ${result.git?.branch ?? "unknown"}`,
    `dirty: ${result.git?.dirtyCount ?? 0}`,
    "",
    "lanes:",
  ];
  for (const lane of result.lanes.slice(0, 10)) {
    lines.push(`- ${lane.lane} · ${lane.agent} · ${lane.status} · ${lane.summary}`);
  }
  if (result.lanes.length === 0) {
    lines.push("- none");
  }
  return `${lines.join("\n")}\n`;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

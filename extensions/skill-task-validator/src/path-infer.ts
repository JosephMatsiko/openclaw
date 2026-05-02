// inferDeliverablePaths + syntaxCheck — pure helpers shared by per-kind
// validators. Salvaged from chuck-task-validator.mjs.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOME = homedir();

export function expandHome(p: string): string {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p === "~") return HOME;
  return p;
}

export function resolveCandidatePath(p: string, repoRoot: string): string {
  const expanded = expandHome(p);
  if (isAbsolute(expanded)) return expanded;
  // Relative paths in build-task intents are virtually always relative to the
  // openclaw repo root.
  return resolve(repoRoot, expanded);
}

export function parseStartedAtMs(task: { startedAt?: string; createdAt?: string }): number | null {
  const iso = task?.startedAt ?? task?.createdAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Sweep the intent text for likely deliverable paths. Six pattern families,
 * conservative dedupe. Returns absolute paths resolved against the repo root.
 */
export function inferDeliverablePaths(intent: string, repoRoot: string): string[] {
  const text = String(intent ?? "");
  const hits = new Set<string>();

  // 1) Absolute paths beginning with / and ending in known build extensions.
  for (const m of text.matchAll(
    /(?:^|[\s(`'"])(\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|plist|toml|ts|js))/g,
  )) {
    hits.add(m[1]);
  }
  // 2) Tilde-expanded paths.
  for (const m of text.matchAll(
    /(?:^|[\s(`'"])(~\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|plist|toml|ts|js))/g,
  )) {
    hits.add(m[1]);
  }
  // 3) LaunchAgents plists referenced by bare basename pattern.
  for (const m of text.matchAll(/(?:Library\/LaunchAgents\/)([A-Za-z0-9._-]+\.plist)/g)) {
    hits.add(`~/Library/LaunchAgents/${m[1]}`);
  }
  // 4) Common label-style plist mentions.
  for (const m of text.matchAll(
    /\b(com\.[a-z0-9.-]+(?:\.chuck-[a-z0-9-]+|\.openclaw[a-z0-9.-]*))\b/g,
  )) {
    const lower = text.toLowerCase();
    if (lower.includes("launchd") || lower.includes("plist") || lower.includes("launchagent")) {
      hits.add(`~/Library/LaunchAgents/${m[1]}.plist`);
    }
  }
  // 5) Repo-relative scripts under extensions/.
  for (const m of text.matchAll(/(extensions\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|json|ts|js))/g)) {
    hits.add(m[1]);
  }
  // 6) "Build at <path>" / "Build <path>" / "Output to <path>" patterns.
  for (const m of text.matchAll(
    /(?:Build(?:\s+at)?|Output(?:s)?(?:\s+to)?|Write(?:\s+to)?|Create)\s+([^\s,;]+\.(?:mjs|tsx|json|plist|toml|ts|js))/gi,
  )) {
    hits.add(m[1]);
  }

  const resolved = new Set<string>();
  for (const raw of hits) resolved.add(resolveCandidatePath(raw, repoRoot));
  return [...resolved];
}

export type SyntaxCheckResult =
  | { ok: true; kind: string }
  | { ok: false; kind: string; stderr: string };

export function syntaxCheck(path: string): SyntaxCheckResult {
  if (/\.(mjs|js|ts|tsx)$/i.test(path)) {
    if (/\.(ts|tsx)$/i.test(path)) {
      // No reliable stdlib TS check at runtime; existence + non-empty
      // already verified upstream.
      return { ok: true, kind: "ts-existence-only" };
    }
    const r = spawnSync(process.execPath, ["--check", path], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status === 0) return { ok: true, kind: "node-check" };
    return { ok: false, kind: "node-check", stderr: (r.stderr || r.stdout || "").trim() };
  }
  if (/\.plist$/i.test(path)) {
    const r = spawnSync("plutil", ["-lint", path], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return { ok: true, kind: "plutil-lint" };
    return { ok: false, kind: "plutil-lint", stderr: (r.stderr || r.stdout || "").trim() };
  }
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
      return { ok: true, kind: "json-parse" };
    } catch (e) {
      return { ok: false, kind: "json-parse", stderr: (e as Error).message ?? String(e) };
    }
  }
  return { ok: true, kind: "unchecked-extension" };
}

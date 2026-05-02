// Hashing, atomic writes, path helpers — shared across compaction modules.

import { randomUUID, createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const HOME = homedir();

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function appendEvent(path: string, event: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha(path: string | null | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  return `sha256:${sha256(readFileSync(path))}`;
}

export function compactTimestamp(iso: string | null | undefined): string {
  return String(iso ?? new Date().toISOString())
    .replace(/[-:.]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export function compareIso(a: string | null | undefined, b: string | null | undefined): number {
  return (Date.parse(a ?? "") || 0) - (Date.parse(b ?? "") || 0);
}

export function pushUnique<T>(arr: T[], value: T): void {
  if (value && !arr.includes(value)) arr.push(value);
}

export function cleanClaimText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(value: string | null | undefined): string {
  return cleanClaimText(value).toLowerCase();
}

export function truncate(value: string | null | undefined, limit: number): string {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

export function expandPath(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

export interface JsonFileEntry<T> {
  name: string;
  path: string;
  mtimeMs: number;
  mtime?: string;
  data: T;
}

export function latestJsonFiles<T>(dir: string, limit = 1000): JsonFileEntry<T>[] {
  if (!existsSync(dir)) return [];
  const entries: JsonFileEntry<T>[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      entries.push({
        name,
        path,
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime.toISOString(),
        data: readJson<T>(path),
      });
    } catch {
      /* skip */
    }
  }
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, limit);
}

export function resolveDecisionPath(value: string, compactionsDir: string): string {
  const expanded = expandPath(String(value ?? ""));
  if (expanded.endsWith(".json") || expanded.includes("/")) {
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  }
  return join(compactionsDir, `${expanded}.json`);
}

export function makeEvent(
  type: string,
  payload: Record<string, unknown>,
): {
  id: string;
  ts: string;
  actor: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
} {
  return {
    id: `e-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: new Date().toISOString(),
    actor: "chuck",
    source: "chuck-prior-compaction",
    type,
    payload,
  };
}

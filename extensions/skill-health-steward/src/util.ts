// Filesystem + formatting helpers shared across health-steward modules.

import { randomUUID } from "node:crypto";
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
import { dirname, resolve } from "node:path";

export const GIB = 1024 ** 3;

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function statSafe(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function pathInside(child: string, root: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  return resolvedChild === resolvedRoot || resolvedChild.startsWith(`${resolvedRoot}/`);
}

export function appendEvent(path: string, event: unknown): void {
  try {
    ensureDir(dirname(path));
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`;
  return `${Math.round(value / (1024 * 1024))} MiB`;
}

export function defaultReceiptId(prefix: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${ts}-${randomUUID().slice(0, 8)}`;
}

export interface JsonFileEntry<T> {
  name: string;
  path: string;
  mtimeMs: number;
  data: T;
}

export function latestJsonFiles<T>(dir: string, limit = 30): JsonFileEntry<T>[] {
  return safeReaddir(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = `${dir}/${name}`;
      const data = readJsonSafe<T | null>(path, null);
      return { name, path, mtimeMs: statSafe(path)?.mtimeMs ?? 0, data };
    })
    .filter((file): file is JsonFileEntry<T> => file.data != null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

export const ENGINE_KIND = "chuck-health-steward";

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
    source: ENGINE_KIND,
    type,
    payload: payload ?? {},
  };
}

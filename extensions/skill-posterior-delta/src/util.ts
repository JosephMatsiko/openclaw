// Hashing, atomic writes, path helpers — shared across the writer pipeline.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOME = homedir();

export function readJson<T = unknown>(path: string): T {
  const text = readFileSync(path, "utf8");
  const data = JSON.parse(text) as T;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    (data as Record<string, unknown>)._path = path;
  }
  return data;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fileSha(path: string | null | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  return `sha256:${sha256(readFileSync(path))}`;
}

export function normalizeSha(value: string | null | undefined): string | null {
  if (!value) return null;
  return String(value).startsWith("sha256:") ? String(value) : `sha256:${value}`;
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

export function expandPath(input: string | undefined | null): string | undefined {
  if (input == null) return undefined;
  if (input === "") return input;
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return join(HOME, input.slice(2));
  return resolve(input);
}

export function cleanBullet(line: string | null | undefined): string {
  return String(line ?? "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^[0-9]+[.)]\s+/, "")
    .trim();
}

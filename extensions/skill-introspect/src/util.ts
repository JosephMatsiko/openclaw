// Shared helpers: fingerprint, slugify, readJson/writeJson, listJsonByMtime,
// tail/head readers, env builder.

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENGINE_KIND = "chuck-introspect";
const HOME = homedir();

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function slugify(s: string | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function fingerprint(category: string, recommendation: string): string {
  return createHash("sha1")
    .update(`${slugify(category)}::${slugify(recommendation)}`)
    .digest("hex")
    .slice(0, 16);
}

export function introspectId(): string {
  return `introspect-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export function readTextHead(path: string, maxChars: number): string | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path, "utf8");
    if (buf.length <= maxChars) return buf;
    return `${buf.slice(0, maxChars)}\n…[truncated ${buf.length - maxChars} chars]`;
  } catch {
    return null;
  }
}

export function tailLines(path: string, maxLines: number): string[] {
  if (!existsSync(path)) return [];
  try {
    const buf = readFileSync(path, "utf8");
    const lines = buf.split("\n");
    return lines.slice(-maxLines - 1).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

export function listJsonByMtime(
  dir: string,
  limit: number,
): Array<{ path: string; name: string; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => {
        const p = join(dir, n);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(p).mtimeMs;
        } catch {
          /* ignore */
        }
        return { path: p, name: n, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function buildExecutorEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME ?? HOME;
  const existingPath = (env.PATH ?? "").split(":").filter(Boolean);
  const augments = [
    `${home}/.openclaw/bin`,
    `${home}/.nvm/versions/node/v24.14.1/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set(existingPath);
  for (const p of augments) {
    if (!seen.has(p)) {
      existingPath.push(p);
      seen.add(p);
    }
  }
  return { ...env, HOME: home, PATH: existingPath.join(":") };
}

export interface EventEmitter {
  emit: (type: string, payload: unknown) => void;
}

export function createEventEmitter(eventsPath: string): EventEmitter {
  return {
    emit(type: string, payload: unknown): void {
      const ev = {
        id: `e-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        ts: new Date().toISOString(),
        actor: "chuck",
        source: ENGINE_KIND,
        type,
        payload: payload ?? {},
      };
      try {
        appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`, "utf8");
      } catch {
        /* best-effort */
      }
    },
  };
}

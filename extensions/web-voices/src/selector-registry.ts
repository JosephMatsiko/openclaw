// Selector registry — versioned per-voice DOM selectors so vendor CSS
// changes can be patched in one place instead of breaking every user's
// bespoke scripts.
//
// Storage: ~/.openclaw/workspace/state/web-voices/selectors.json
//
// On startup, the registry loads from disk. Each web voice harness asks
// the registry for the freshest profile matching its voiceId. When the
// harness detects a selector miss (composer not found, send button gone,
// etc.), it can call autoPatch() to record the failed selector + propose
// a candidate from a heuristic search of the live DOM. v0.1 ships the
// schema + readers; v0.2 adds the auto-patch heuristics.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SelectorProfile, SelectorRegistry } from "./types.js";

const HOME = homedir();
const DEFAULT_REGISTRY_PATH = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "web-voices",
  "selectors.json",
);

function emptyRegistry(): SelectorRegistry {
  // Fresh object every call — shallow-copy + shared profiles[] array would
  // let upsertSelectorProfile mutate a singleton EMPTY_REGISTRY when the
  // requested path doesn't yet exist, causing cross-call pollution.
  return {
    version: 1,
    profiles: [],
    lastUpdated: "1970-01-01T00:00:00.000Z",
  };
}

function readRegistry(path: string): SelectorRegistry {
  if (!existsSync(path)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SelectorRegistry;
    if (parsed?.version === 1 && Array.isArray(parsed.profiles)) return parsed;
    return emptyRegistry();
  } catch {
    return emptyRegistry();
  }
}

function writeRegistryAtomic(path: string, registry: SelectorRegistry): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Look up the freshest selector profile for a voice. Falls back to
 * undefined when no profile exists yet (caller should use the harness's
 * built-in defaults).
 */
export function getSelectorProfile(
  voiceId: string,
  registryPath?: string,
): SelectorProfile | undefined {
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;
  const registry = readRegistry(path);
  const matching = registry.profiles
    .filter((p) => p.voiceId === voiceId)
    .sort((a, b) => b.version.localeCompare(a.version));
  return matching[0];
}

/**
 * Add or upgrade a selector profile. Newer versions win.
 */
export function upsertSelectorProfile(profile: SelectorProfile, registryPath?: string): void {
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;
  const registry = readRegistry(path);
  const idx = registry.profiles.findIndex(
    (p) => p.voiceId === profile.voiceId && p.version === profile.version,
  );
  if (idx >= 0) {
    registry.profiles[idx] = profile;
  } else {
    registry.profiles.push(profile);
  }
  registry.lastUpdated = new Date().toISOString();
  writeRegistryAtomic(path, registry);
}

/**
 * Read the full registry — useful for status dashboards or a "show me
 * what selectors are pinned" CLI.
 */
export function inspectRegistry(registryPath?: string): SelectorRegistry {
  return readRegistry(registryPath ?? DEFAULT_REGISTRY_PATH);
}

#!/usr/bin/env node
// =============================================================================
// PARTIAL SALVAGE — Unit 16 of the openclaw-first migration (2026-05-01).
// =============================================================================
// The TYPED WRAPPER lives at:
//   extensions/skill-mac-self-heal/src/* (re-exported via
//   @openclaw/skill-mac-self-heal api.ts)
//
// This .mjs is the CANONICAL implementation: 1272 LOC of cache enumeration,
// evidence preservation rules, cloud-offload candidate detection, allowlist
// gating, and receipt writing. v0.1 of the plugin wraps it as a subprocess
// so callers (skill-health-steward, skill-docket-executor, skill-self-
// improvement-scanner) get a type-safe in-process call site without giving up
// the battle-tested .mjs.
//
// LaunchAgent: ~/Library/LaunchAgents/com.openclaw.chuck-mac-self-heal.plist
// runs the daemon path on a 2h cadence. The plist stays pointed at this .mjs
// until openclaw cron supports long-running plugin daemons.
//
// Three subsystems subprocess-spawn this script today:
//   1. @openclaw/skill-health-steward (Unit 12) — stabilize + apply via
//      SelfHealRunner interface
//   2. @openclaw/skill-docket-executor (Unit 6c) — recovery hooks
//   3. @openclaw/skill-self-improvement-scanner (Unit 9) — gap detection
//
// FULL TS source-port queued for the openclaw daemon-plugin phase. At that
// point port the cache classifier (CACHE_DIR_NAMES, REVIEW_ONLY_NAMES,
// APP_BUNDLE_PREFIX_RE), the action enumerators (allowlisted cache / npm /
// yarn / pnpm / Homebrew / Chrome / Codex WAL / trash / stale-tmp / old-
// evidence / cloud-offload candidates), the apply pipeline (atomic move-to-
// archive + cloud copy + receipt write), and the receipt schema into ./src/*
// — then retire this .mjs AND the LaunchAgent.
//
// WIRE FORMAT (must stay byte-stable for downstream readers):
//   - Receipt schema: chuck-v3.mac-self-heal/1
//   - Result rows: {status, action, cloudPath?, localArchivePath?, bytes?}
//     parsed by skill-health-steward's archive purge gate
//   - Command flag semantics: --max-actions, --cloud-target,
//     --only-under-pressure, --allow-cloud-offload, --dry-run
// =============================================================================
//
// Chuck Mac Self-Heal — reversible stewardship for the local machine.
//
// This is intentionally conservative about quality. It distinguishes
// regenerable cache deletion from evidence/file preservation, writes receipts,
// and will not touch active browser profiles or repo/state source files.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem, uptime } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { emit } from "./apex-event-bus.mjs";

const SCHEMA = "chuck-v3.mac-self-heal/1";
const HOME = homedir();
const STATE_DIR = join(HOME, ".openclaw", "workspace", "state", "chuck-v3", "mac-self-heal");
const RECEIPTS_DIR = join(STATE_DIR, "receipts");
const ARCHIVES_DIR = join(STATE_DIR, "archives");
const LATEST_PATH = join(STATE_DIR, "latest.json");
const CLOUD_CONFIG_PATH = join(STATE_DIR, "cloud-config.json");
const OPENCLAW_ROOT = join(HOME, ".openclaw");
const OPENCLAW_WORKSPACE = join(OPENCLAW_ROOT, "workspace");
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DEFAULT_MAX_ACTIONS = 24;
const MIN_CACHE_BYTES = 256 * 1024;
const STALE_TMP_MS = 24 * 60 * 60 * 1000;
const STALE_SYSTMP_MS = 7 * 24 * 60 * 60 * 1000;
const OLD_EVIDENCE_MS = 2 * 24 * 60 * 60 * 1000;
const DISK_WARN_FREE_PERCENT = 0.1;
const DISK_MIN_FREE_BYTES = 25 * GIB;
const SWAP_WARN_USED_BYTES = 10 * GIB;
const APP_CACHE_MIN_BYTES = 200 * MIB;
const NPM_CACHE_MIN_BYTES = 1 * GIB;
const YARN_CACHE_MIN_BYTES = 500 * MIB;
const HOMEBREW_CACHE_MIN_BYTES = 200 * MIB;
const PNPM_CACHE_MIN_BYTES = 200 * MIB;
const CHROME_CACHE_MIN_BYTES = 500 * MIB;
const CODEX_WAL_MIN_BYTES = 50 * MIB;
const TRASH_MIN_BYTES = 1; // any non-empty trash
const APP_BUNDLE_PREFIX_RE = /^(com|net|org|io|ai)\./;

const CACHE_DIR_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
  "extensions_crx_cache",
]);

const REVIEW_ONLY_NAMES = new Set([
  "OptGuideOnDeviceModel",
  "optimization_guide_model_store",
  "WasmTtsEngine",
  "Safe Browsing",
]);

function parseArgs(argv) {
  const options = {
    command: "status",
    json: false,
    maxActions: DEFAULT_MAX_ACTIONS,
    apply: false,
    cloudTarget: "",
    onlyUnderPressure: false,
    allowCloudOffload: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["status", "plan", "apply", "detect"].includes(arg)) {
      // `detect` is an alias for `plan` (read-only enumeration).
      options.command = arg === "detect" ? "plan" : arg;
      options.apply = options.command === "apply";
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-actions") {
      options.maxActions = parsePositiveInt(argv[++i], "--max-actions");
    } else if (arg === "--cloud-target") {
      options.cloudTarget = String(argv[++i] ?? "").trim();
    } else if (arg === "--only-under-pressure") {
      options.onlyUnderPressure = true;
    } else if (arg === "--allow-cloud-offload") {
      options.allowCloudOffload = true;
    } else if (arg === "--dry-run") {
      // Force read-only behavior even when `apply` is requested.
      options.dryRun = true;
      if (options.command === "apply") {
        options.command = "plan";
        options.apply = false;
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node extensions/memory-graph/scripts/chuck-mac-self-heal.mjs status [--json]
  node extensions/memory-graph/scripts/chuck-mac-self-heal.mjs plan [--json] [--allow-cloud-offload]
  node extensions/memory-graph/scripts/chuck-mac-self-heal.mjs apply [--json] [--max-actions N] [--cloud-target PATH] [--only-under-pressure] [--allow-cloud-offload]`);
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

function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeCloudConfig(raw = {}) {
  const archiveSubdir = String(raw.archiveSubdir || "OpenClaw Archives/mac-self-heal")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
  return {
    schema: "chuck-v3.mac-self-heal.cloud-config/1",
    provider: String(raw.provider || "google-drive"),
    accountHint: String(raw.accountHint || "").trim(),
    archiveSubdir,
    requireGoogleTarget: raw.requireGoogleTarget !== false,
    allowIcloudFallback: raw.allowIcloudFallback === true,
    updatedAt: raw.updatedAt || null,
    configuredBy: raw.configuredBy || null,
  };
}

function readCloudConfig() {
  return normalizeCloudConfig(readJsonSafe(CLOUD_CONFIG_PATH, {}));
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function pathIsInside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith(sep));
}

function directorySizeBytes(path, { maxEntries = 200_000 } = {}) {
  let total = 0;
  let entries = 0;
  const walk = (current) => {
    if (entries > maxEntries) {
      return;
    }
    const st = lstatSafe(current);
    if (!st) {
      return;
    }
    entries += 1;
    if (st.isSymbolicLink()) {
      return;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = readdirSync(current);
      } catch {
        return;
      }
      for (const name of names) {
        walk(join(current, name));
      }
      return;
    }
    total += st.size;
  };
  walk(path);
  return { bytes: total, truncated: entries > maxEntries, entries };
}

function readDiskStatus() {
  try {
    const stat = statfsSync(HOME);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    return {
      available: true,
      path: HOME,
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? freeBytes / totalBytes : null,
    };
  } catch (err) {
    return { available: false, path: HOME, reason: err.message };
  }
}

function readSwapStatus() {
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], {
    encoding: "utf8",
    timeout: 2000,
  });
  const text = result.stdout ?? "";
  const match = text.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/i);
  if (!match) {
    return {
      available: false,
      reason: result.stderr || result.error?.message || "swap usage unavailable",
    };
  }
  const totalBytes = Number(match[1]) * MIB;
  const usedBytes = Number(match[2]) * MIB;
  const freeBytes = Number(match[3]) * MIB;
  return {
    available: true,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent: totalBytes > 0 ? usedBytes / totalBytes : null,
    raw: text.trim(),
  };
}

function healthStatus() {
  const cpuCount = cpus().length || 1;
  const loads = loadavg();
  const totalMemoryBytes = totalmem();
  const freeMemoryBytes = freemem();
  const memoryFreePercent = totalMemoryBytes > 0 ? freeMemoryBytes / totalMemoryBytes : null;
  const disk = readDiskStatus();
  const swap = readSwapStatus();
  const blockers = [];
  const signals = [];
  const loadRatio = loads[0] / cpuCount;

  signals.push({
    category: "mac.load",
    severity: loadRatio > 2 ? "warn" : "info",
    summary: `load ${loads[0].toFixed(2)} / ${cpuCount} cores`,
    value: loadRatio,
  });
  signals.push({
    category: "mac.memory",
    severity: memoryFreePercent !== null && memoryFreePercent < 0.05 ? "warn" : "info",
    summary: `free memory ${Math.round((memoryFreePercent ?? 0) * 100)}%`,
    value: memoryFreePercent,
  });
  if (!disk.available) {
    blockers.push("disk status unavailable");
    signals.push({
      category: "mac.disk",
      severity: "error",
      summary: disk.reason || "disk unavailable",
    });
  } else {
    const lowDisk =
      (disk.freePercent ?? 1) < DISK_WARN_FREE_PERCENT || disk.freeBytes < DISK_MIN_FREE_BYTES;
    if (lowDisk) {
      blockers.push(`disk free ${formatBytes(disk.freeBytes)} below stewardship floor`);
    }
    signals.push({
      category: "mac.disk",
      severity: lowDisk ? "warn" : "info",
      summary: `${formatBytes(disk.freeBytes)} free`,
      value: disk.freePercent,
    });
  }
  if (swap.available) {
    const highSwap = swap.usedBytes > SWAP_WARN_USED_BYTES;
    if (highSwap) {
      blockers.push(`swap used ${formatBytes(swap.usedBytes)} above stewardship floor`);
    }
    signals.push({
      category: "mac.swap",
      severity: highSwap ? "warn" : "info",
      summary: `${formatBytes(swap.usedBytes)} swap used`,
      value: swap.usedPercent,
    });
  }
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    state: blockers.length > 0 ? "watch" : "ok",
    blockers,
    thresholds: {
      diskWarnFreePercent: DISK_WARN_FREE_PERCENT,
      diskMinFreeBytes: DISK_MIN_FREE_BYTES,
      swapWarnUsedBytes: SWAP_WARN_USED_BYTES,
    },
    load: { one: loads[0], five: loads[1], fifteen: loads[2], cpuCount, loadRatio },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      freePercent: memoryFreePercent,
    },
    disk,
    swap,
    uptimeSeconds: uptime(),
    signals,
  };
}

function mdfind(query) {
  const result = spawnSync("/usr/bin/mdfind", [query], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectGoogleDriveDesktop(accountHint = "") {
  const appCandidates = [
    "/Applications/Google Drive.app",
    join(HOME, "Applications", "Google Drive.app"),
    ...mdfind(
      "kMDItemCFBundleIdentifier == 'com.google.drivefs' || kMDItemDisplayName == 'Google Drive.app'",
    ),
  ];
  const appPaths = [...new Set(appCandidates)].filter((path) => statSafe(path)?.isDirectory());
  const driveFsPath = join(HOME, "Library", "Application Support", "Google", "DriveFS");
  const driveFsAvailable = statSafe(driveFsPath)?.isDirectory() === true;
  const mountedRoots = [];
  const cloudRoot = join(HOME, "Library", "CloudStorage");
  if (existsSync(cloudRoot)) {
    for (const name of safeReaddir(cloudRoot)) {
      if (/^GoogleDrive/i.test(name)) {
        mountedRoots.push(join(cloudRoot, name));
      }
    }
  }
  const legacyRoot = join(HOME, "Google Drive");
  if (statSafe(legacyRoot)?.isDirectory()) {
    mountedRoots.push(legacyRoot);
  }
  const loweredHint = accountHint.toLowerCase();
  return {
    installed: appPaths.length > 0 || driveFsAvailable,
    appPaths,
    driveFsPath,
    driveFsAvailable,
    mounted: mountedRoots.length > 0,
    mountedRoots,
    accountHint,
    accountHintMatched:
      !!loweredHint && mountedRoots.some((path) => path.toLowerCase().includes(loweredHint)),
  };
}

function archiveBasePath(candidate) {
  if (candidate?.kind === "google-drive-desktop") {
    const myDrive = join(candidate.path, "My Drive");
    if (statSafe(myDrive)?.isDirectory()) {
      return myDrive;
    }
  }
  return candidate?.path || "";
}

function joinArchivePath(candidate, archiveSubdir) {
  return join(
    archiveBasePath(candidate),
    ...String(archiveSubdir || "OpenClaw Archives/mac-self-heal")
      .split("/")
      .filter(Boolean),
  );
}

function detectCloudTargets(explicitTarget = "") {
  const config = readCloudConfig();
  const googleDriveDesktop = detectGoogleDriveDesktop(config.accountHint);
  const candidates = [];
  const push = (path, kind, configured = false) => {
    if (!path) {
      return;
    }
    const st = statSafe(path);
    candidates.push({
      path,
      kind,
      configured,
      available: !!st && st.isDirectory(),
      accountHintMatched:
        !!config.accountHint && path.toLowerCase().includes(config.accountHint.toLowerCase()),
    });
  };
  push(explicitTarget, "explicit", true);
  for (const path of googleDriveDesktop.mountedRoots) {
    push(path, "google-drive-desktop");
  }
  push(join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs"), "icloud-drive");
  const eligible = candidates.filter(
    (candidate) =>
      candidate.available &&
      (candidate.configured ||
        candidate.kind.includes("google") ||
        (candidate.kind === "icloud-drive" && config.allowIcloudFallback)),
  );
  const preferred =
    eligible.find((candidate) => candidate.kind.includes("google")) ?? eligible[0] ?? null;
  const fallback = candidates.find((candidate) => candidate.available) ?? null;
  const googleMessage = googleDriveDesktop.installed
    ? "Google Drive for desktop appears installed but no mounted Google Drive folder is reachable for OpenClaw."
    : "Google Drive for desktop is not installed or not discoverable on this Mac.";
  return {
    available: !!preferred,
    preferred,
    fallback,
    candidates,
    configPath: CLOUD_CONFIG_PATH,
    config,
    googleDriveDesktop,
    archivePath: preferred ? joinArchivePath(preferred, config.archiveSubdir) : null,
    recommendation: preferred
      ? "Cloud archive target is reachable through the local filesystem."
      : fallback
        ? `No eligible Google Drive target was found for ${config.accountHint || "the configured account"}. ${fallback.kind} exists but will not be used automatically. ${googleMessage}`
        : `No local Google Drive sync folder was found for ${config.accountHint || "the configured account"}. ${googleMessage}`,
  };
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function activeProcessCommands() {
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(result.stdout ?? "")
    .split("\n")
    .filter(Boolean);
}

function pathReferencedByActiveProcess(path, commands = activeProcessCommands()) {
  const resolved = resolve(path);
  return commands.some((command) => command.includes(resolved));
}

function collectChromeCandidates(commands) {
  const candidates = [];
  for (const profile of [
    "chrome-apex-profile-a",
    "chrome-apex-profile-b",
    "chrome-apex-profile-c",
  ]) {
    const profilePath = join(OPENCLAW_ROOT, profile);
    if (!existsSync(profilePath)) {
      continue;
    }
    const active = pathReferencedByActiveProcess(profilePath, commands);
    const walk = (dir, depth = 0) => {
      if (depth > 3) {
        return;
      }
      for (const name of safeReaddir(dir)) {
        const path = join(dir, name);
        const st = lstatSafe(path);
        if (!st || st.isSymbolicLink()) {
          continue;
        }
        if (!st.isDirectory()) {
          continue;
        }
        if (CACHE_DIR_NAMES.has(name)) {
          const size = directorySizeBytes(path);
          if (size.bytes >= MIN_CACHE_BYTES) {
            candidates.push({
              id: candidateId("chrome-cache", path),
              kind: "delete-regenerable-cache",
              safeClass: "regenerable-cache",
              path,
              root: profilePath,
              bytes: size.bytes,
              eligibleAuto: !active,
              blockedBy: active ? ["browser profile is currently active"] : [],
              reason: "Chrome cache can be recreated and is not source state.",
            });
          }
          continue;
        }
        if (REVIEW_ONLY_NAMES.has(name)) {
          const size = directorySizeBytes(path);
          if (size.bytes >= MIN_CACHE_BYTES) {
            candidates.push({
              id: candidateId("review-only", path),
              kind: "manual-review",
              safeClass: "large-browser-support-data",
              path,
              root: profilePath,
              bytes: size.bytes,
              eligibleAuto: false,
              blockedBy: ["quality review required before removing browser support data"],
              reason: "Large browser support data may affect local model/browser behavior.",
            });
          }
          continue;
        }
        walk(path, depth + 1);
      }
    };
    walk(profilePath);
  }
  return candidates;
}

function collectTmpCandidates() {
  const tmpRoot = join(OPENCLAW_ROOT, "tmp");
  const candidates = [];
  if (!existsSync(tmpRoot)) {
    return candidates;
  }
  const now = Date.now();
  for (const name of safeReaddir(tmpRoot)) {
    const path = join(tmpRoot, name);
    const st = lstatSafe(path);
    if (!st || st.isSymbolicLink()) {
      continue;
    }
    const ageMs = now - st.mtimeMs;
    if (ageMs < STALE_TMP_MS) {
      continue;
    }
    const size = st.isDirectory()
      ? directorySizeBytes(path)
      : { bytes: st.size, truncated: false, entries: 1 };
    candidates.push({
      id: candidateId("openclaw-tmp", path),
      kind: "delete-regenerable-cache",
      safeClass: "stale-temp",
      path,
      root: tmpRoot,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason: "Stale OpenClaw temp artifact older than 24 hours.",
    });
  }
  return candidates;
}

function collectEvidenceCandidates(cloud, options = {}) {
  const candidates = [];
  const evidenceRoots = [
    join(OPENCLAW_WORKSPACE, "videos"),
    join(OPENCLAW_WORKSPACE, "screenshots"),
  ];
  const now = Date.now();
  for (const root of evidenceRoots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const name of safeReaddir(root)) {
      const path = join(root, name);
      const st = lstatSafe(path);
      if (!st || st.isSymbolicLink() || st.isDirectory()) {
        continue;
      }
      if (now - st.mtimeMs < OLD_EVIDENCE_MS) {
        continue;
      }
      const bytes = st.size;
      if (bytes < MIN_CACHE_BYTES) {
        continue;
      }
      const eligibleCloudOffload = cloud.available && options.allowCloudOffload;
      candidates.push({
        id: candidateId("evidence-offload", path),
        kind: "cloud-offload-preserve",
        safeClass: "evidence-preserve",
        path,
        root,
        bytes,
        eligibleAuto: eligibleCloudOffload,
        blockedBy: cloud.available
          ? options.allowCloudOffload
            ? []
            : ["cloud offload requires explicit --allow-cloud-offload approval"]
          : ["no cloud archive target is currently reachable"],
        reason: "Old evidence can leave the local hot path only after cloud copy verification.",
      });
    }
  }
  return candidates;
}

function candidateId(prefix, path) {
  return `${prefix}:${relative(HOME, path).replaceAll(sep, "/")}`;
}

function collectAppBundleCacheCandidates({
  rootPath,
  prefix,
  minBytes,
  reason,
  requireBundlePrefix = true,
}) {
  const candidates = [];
  if (!existsSync(rootPath)) {
    return candidates;
  }
  for (const name of safeReaddir(rootPath)) {
    if (requireBundlePrefix && !APP_BUNDLE_PREFIX_RE.test(name)) {
      continue;
    }
    const path = join(rootPath, name);
    const st = lstatSafe(path);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      continue;
    }
    const size = directorySizeBytes(path);
    if (size.bytes < minBytes) {
      continue;
    }
    candidates.push({
      id: candidateId(prefix, path),
      kind: "empty-dir-contents",
      safeClass: "regenerable-cache",
      path,
      root: rootPath,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason,
    });
  }
  return candidates;
}

function collectSystemAppCacheCandidates() {
  return collectAppBundleCacheCandidates({
    rootPath: join(HOME, "Library", "Caches"),
    prefix: "lib-caches-bundle",
    minBytes: APP_CACHE_MIN_BYTES,
    reason: "Library/Caches bundle directory exceeds threshold; contents are app-rebuildable.",
  });
}

function collectXdgCacheCandidates() {
  return collectAppBundleCacheCandidates({
    rootPath: join(HOME, ".cache"),
    prefix: "xdg-cache",
    minBytes: APP_CACHE_MIN_BYTES,
    reason: "~/.cache library directory exceeds threshold; contents are tool-rebuildable.",
    requireBundlePrefix: false,
  });
}

function collectSingleDirCacheCandidate({
  path,
  prefix,
  minBytes,
  reason,
  kind = "empty-dir-contents",
}) {
  if (!existsSync(path)) {
    return [];
  }
  const st = lstatSafe(path);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    return [];
  }
  const size = directorySizeBytes(path);
  if (size.bytes < minBytes) {
    return [];
  }
  return [
    {
      id: candidateId(prefix, path),
      kind,
      safeClass: "regenerable-cache",
      path,
      root: path,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason,
    },
  ];
}

function collectNpmCacheCandidates() {
  return collectSingleDirCacheCandidate({
    path: join(HOME, ".npm", "_cacache"),
    prefix: "npm-cache",
    minBytes: NPM_CACHE_MIN_BYTES,
    reason: "npm content-addressable cache exceeds 1 GiB; rebuilds on next install.",
  });
}

function collectYarnCacheCandidates() {
  const candidates = [];
  const yarnRoot = join(HOME, "Library", "Caches", "Yarn");
  if (!existsSync(yarnRoot)) {
    return candidates;
  }
  for (const name of safeReaddir(yarnRoot)) {
    const path = join(yarnRoot, name);
    const st = lstatSafe(path);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      continue;
    }
    const size = directorySizeBytes(path);
    if (size.bytes < YARN_CACHE_MIN_BYTES) {
      continue;
    }
    candidates.push({
      id: candidateId("yarn-cache", path),
      kind: "empty-dir-contents",
      safeClass: "regenerable-cache",
      path,
      root: yarnRoot,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason: `yarn cache directory ${name} exceeds threshold; rebuilds on next install.`,
    });
  }
  return candidates;
}

function collectHomebrewCacheCandidates() {
  return collectSingleDirCacheCandidate({
    path: join(HOME, "Library", "Caches", "Homebrew"),
    prefix: "brew-cache",
    minBytes: HOMEBREW_CACHE_MIN_BYTES,
    reason: "Homebrew downloads cache exceeds threshold; brew re-downloads on demand.",
  });
}

function collectPnpmCacheCandidates() {
  return collectSingleDirCacheCandidate({
    path: join(HOME, "Library", "Caches", "pnpm"),
    prefix: "pnpm-cache",
    minBytes: PNPM_CACHE_MIN_BYTES,
    reason: "pnpm cache exceeds threshold; rebuilds on next install.",
  });
}

function collectChromeCacheCandidates(commands) {
  const chromeRoot = join(HOME, "Library", "Application Support", "Google", "Chrome", "Default");
  const candidates = [];
  if (!existsSync(chromeRoot)) {
    return candidates;
  }
  const targets = ["Cache", "Code Cache", "GPUCache"];
  let totalBytes = 0;
  const sized = [];
  for (const name of targets) {
    const path = join(chromeRoot, name);
    const st = lstatSafe(path);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      continue;
    }
    const size = directorySizeBytes(path);
    sized.push({ path, bytes: size.bytes, name });
    totalBytes += size.bytes;
  }
  if (totalBytes < CHROME_CACHE_MIN_BYTES || sized.length === 0) {
    return candidates;
  }
  // Only proceed if Chrome (system Chrome — not OpenClaw managed profiles) is not actively writing.
  // Heuristic: if /Applications/Google Chrome.app process references this exact profile path, skip.
  const active = pathReferencedByActiveProcess(chromeRoot, commands);
  for (const entry of sized) {
    candidates.push({
      id: candidateId("chrome-system-cache", entry.path),
      kind: "empty-dir-contents",
      safeClass: "regenerable-cache",
      path: entry.path,
      root: chromeRoot,
      bytes: entry.bytes,
      eligibleAuto: !active,
      blockedBy: active ? ["system Chrome profile is currently active"] : [],
      reason: `System Chrome ${entry.name} contributes to a >${formatBytes(CHROME_CACHE_MIN_BYTES)} aggregate; rebuilds on browse.`,
    });
  }
  return candidates;
}

function collectSystemTmpCandidates() {
  const candidates = [];
  const root = "/tmp";
  if (!existsSync(root)) {
    return candidates;
  }
  const now = Date.now();
  const prefixes = ["openclaw-", "openclaw_", "claude-", "openclaw-plugin-"];
  for (const name of safeReaddir(root)) {
    if (!prefixes.some((p) => name.startsWith(p))) {
      continue;
    }
    const path = join(root, name);
    const st = lstatSafe(path);
    if (!st || st.isSymbolicLink()) {
      continue;
    }
    if (now - st.mtimeMs < STALE_SYSTMP_MS) {
      continue;
    }
    const size = st.isDirectory()
      ? directorySizeBytes(path)
      : { bytes: st.size, truncated: false, entries: 1 };
    candidates.push({
      id: candidateId("system-tmp", path),
      kind: "delete-regenerable-cache",
      safeClass: "stale-temp",
      path,
      root,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason: "Stale /tmp artifact (openclaw/claude prefix) older than 7 days.",
    });
  }
  return candidates;
}

function collectCodexWalCandidates() {
  const candidates = [];
  const walPath = join(HOME, ".codex", "logs_2.sqlite-wal");
  const dbPath = join(HOME, ".codex", "logs_2.sqlite");
  const st = lstatSafe(walPath);
  if (!st || st.isSymbolicLink() || !st.isFile()) {
    return candidates;
  }
  if (st.size < CODEX_WAL_MIN_BYTES) {
    return candidates;
  }
  if (!existsSync(dbPath)) {
    return candidates;
  }
  candidates.push({
    id: candidateId("codex-wal", walPath),
    kind: "sqlite-wal-checkpoint",
    safeClass: "regenerable-cache",
    path: walPath,
    root: dirname(walPath),
    bytes: st.size,
    eligibleAuto: true,
    blockedBy: [],
    reason: "Codex SQLite WAL exceeds 50 MiB; PRAGMA wal_checkpoint(TRUNCATE) reclaims it.",
    extra: { dbPath },
  });
  return candidates;
}

function collectTrashCandidates() {
  const trashRoot = join(HOME, ".Trash");
  if (!existsSync(trashRoot)) {
    return [];
  }
  const entries = safeReaddir(trashRoot).filter((name) => name !== ".DS_Store");
  if (entries.length === 0) {
    return [];
  }
  const size = directorySizeBytes(trashRoot);
  if (size.bytes < TRASH_MIN_BYTES) {
    return [];
  }
  return [
    {
      id: candidateId("trash", trashRoot),
      kind: "empty-dir-contents",
      safeClass: "user-trash",
      path: trashRoot,
      root: trashRoot,
      bytes: size.bytes,
      eligibleAuto: true,
      blockedBy: [],
      reason: "User Trash is non-empty; emptying mirrors the Finder action.",
    },
  ];
}

function buildPlan(options = {}) {
  const cloud = detectCloudTargets(options.cloudTarget);
  const commands = activeProcessCommands();
  const health = healthStatus();
  const candidates = [
    ...collectChromeCandidates(commands),
    ...collectTmpCandidates(),
    ...collectEvidenceCandidates(cloud, options),
    ...collectSystemAppCacheCandidates(),
    ...collectXdgCacheCandidates(),
    ...collectNpmCacheCandidates(),
    ...collectYarnCacheCandidates(),
    ...collectHomebrewCacheCandidates(),
    ...collectPnpmCacheCandidates(),
    ...collectChromeCacheCandidates(commands),
    ...collectSystemTmpCandidates(),
    ...collectCodexWalCandidates(),
    ...collectTrashCandidates(),
  ].toSorted((a, b) => b.bytes - a.bytes);
  const actions = candidates.filter((candidate) => candidate.eligibleAuto);
  const blocked = candidates.filter((candidate) => !candidate.eligibleAuto);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: "plan",
    health,
    cloud,
    policy: {
      maxActionsDefault: DEFAULT_MAX_ACTIONS,
      staleTmpMs: STALE_TMP_MS,
      oldEvidenceMs: OLD_EVIDENCE_MS,
      activeBrowserProfilesAreBlocked: true,
      sourceAndStateDeletionBlocked: true,
      cloudOffloadRequiresExplicitApproval: true,
      cloudOffloadApprovedForThisRun: options.allowCloudOffload === true,
    },
    candidateCount: candidates.length,
    actionCount: actions.length,
    blockedCount: blocked.length,
    reclaimableBytes: actions.reduce((sum, candidate) => sum + candidate.bytes, 0),
    blockedBytes: blocked.reduce((sum, candidate) => sum + candidate.bytes, 0),
    candidates,
    actions,
    blocked,
  };
}

function assertSafeCandidate(candidate) {
  if (!candidate?.eligibleAuto) {
    throw new Error(`candidate is not eligible: ${candidate?.path ?? "(unknown)"}`);
  }
  const allowedRoots = [
    join(OPENCLAW_ROOT, "chrome-apex-profile-a"),
    join(OPENCLAW_ROOT, "chrome-apex-profile-b"),
    join(OPENCLAW_ROOT, "chrome-apex-profile-c"),
    join(OPENCLAW_ROOT, "tmp"),
    join(OPENCLAW_WORKSPACE, "videos"),
    join(OPENCLAW_WORKSPACE, "screenshots"),
    join(HOME, "Library", "Caches"),
    join(HOME, ".cache"),
    join(HOME, ".npm", "_cacache"),
    join(HOME, "Library", "Application Support", "Google", "Chrome", "Default", "Cache"),
    join(HOME, "Library", "Application Support", "Google", "Chrome", "Default", "Code Cache"),
    join(HOME, "Library", "Application Support", "Google", "Chrome", "Default", "GPUCache"),
    "/tmp",
    join(HOME, ".codex", "logs_2.sqlite-wal"),
    join(HOME, ".Trash"),
  ];
  if (!allowedRoots.some((root) => pathIsInside(candidate.path, root))) {
    throw new Error(`candidate outside allowlisted roots: ${candidate.path}`);
  }
  // Hard denylist — never touch even if a future rule mis-targets these.
  const deniedRoots = [
    "/Users/josephmatsiko/Projects",
    join(OPENCLAW_ROOT, "credentials"),
    join(OPENCLAW_ROOT, "memory"),
    join(OPENCLAW_WORKSPACE, "state"),
    join(HOME, "Documents"),
    join(HOME, "Pictures"),
    join(HOME, "Movies"),
    join(HOME, "Music"),
    "/Applications",
    "/var/log",
    join(HOME, ".codex", "auth.json"),
    join(HOME, ".codex", "config.toml"),
  ];
  if (deniedRoots.some((root) => pathIsInside(candidate.path, root))) {
    throw new Error(`candidate touches denied root: ${candidate.path}`);
  }
}

function applyCandidate(candidate, receiptRoot, cloud) {
  assertSafeCandidate(candidate);
  const before = statSafe(candidate.path);
  if (!before) {
    return {
      id: candidate.id,
      path: candidate.path,
      status: "skipped",
      reason: "path already missing",
    };
  }
  if (candidate.kind === "delete-regenerable-cache") {
    rmSync(candidate.path, { recursive: true, force: true });
    return {
      id: candidate.id,
      kind: candidate.kind,
      safeClass: candidate.safeClass,
      path: candidate.path,
      status: "applied",
      bytes: candidate.bytes,
      action: "removed-regenerable-cache",
    };
  }
  if (candidate.kind === "empty-dir-contents") {
    // Preserve the directory entry so the owning app can write fresh files
    // without permission/creation hiccups; remove only its children.
    const removed = [];
    for (const name of safeReaddir(candidate.path)) {
      const child = join(candidate.path, name);
      try {
        rmSync(child, { recursive: true, force: true });
        removed.push(name);
      } catch (err) {
        // Best-effort: a single locked child shouldn't fail the whole rule.
        removed.push(`${name}::skipped(${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return {
      id: candidate.id,
      kind: candidate.kind,
      safeClass: candidate.safeClass,
      path: candidate.path,
      status: "applied",
      bytes: candidate.bytes,
      action: "emptied-dir-contents",
      removedChildCount: removed.length,
    };
  }
  if (candidate.kind === "sqlite-wal-checkpoint") {
    const dbPath = candidate.extra?.dbPath;
    if (!dbPath || !existsSync(dbPath)) {
      return {
        id: candidate.id,
        path: candidate.path,
        status: "skipped",
        reason: "sqlite db path missing",
      };
    }
    const result = spawnSync("/usr/bin/sqlite3", [dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) {
      return {
        id: candidate.id,
        path: candidate.path,
        status: "failed",
        reason: result.stderr || result.error?.message || `sqlite3 exited ${result.status}`,
      };
    }
    const after = lstatSafe(candidate.path);
    const reclaimed = Math.max(0, candidate.bytes - (after?.size ?? 0));
    return {
      id: candidate.id,
      kind: candidate.kind,
      safeClass: candidate.safeClass,
      path: candidate.path,
      status: "applied",
      bytes: reclaimed,
      action: "wal-checkpoint-truncated",
      checkpointOutput: String(result.stdout ?? "").trim(),
    };
  }
  if (candidate.kind === "cloud-offload-preserve") {
    if (!cloud.available || !cloud.archivePath) {
      return {
        id: candidate.id,
        path: candidate.path,
        status: "skipped",
        reason: "cloud target unavailable",
      };
    }
    const rel = relative(candidate.root, candidate.path);
    const target = join(cloud.archivePath, basename(candidate.root), rel);
    ensureDir(dirname(target));
    const copy = spawnSync("/bin/cp", ["-p", candidate.path, target], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (copy.status !== 0) {
      return {
        id: candidate.id,
        path: candidate.path,
        status: "failed",
        reason: copy.stderr || copy.error?.message || `cp exited ${copy.status}`,
      };
    }
    const targetStat = statSafe(target);
    if (!targetStat || targetStat.size !== before.size) {
      return {
        id: candidate.id,
        path: candidate.path,
        status: "failed",
        reason: "cloud copy size verification failed",
      };
    }
    const localArchive = join(receiptRoot, "offloaded", basename(candidate.root), rel);
    ensureDir(dirname(localArchive));
    renameSync(candidate.path, localArchive);
    return {
      id: candidate.id,
      kind: candidate.kind,
      safeClass: candidate.safeClass,
      path: candidate.path,
      status: "applied",
      bytes: candidate.bytes,
      action: "copied-to-cloud-and-moved-local-archive",
      cloudPath: target,
      localArchivePath: localArchive,
    };
  }
  return {
    id: candidate.id,
    path: candidate.path,
    status: "skipped",
    reason: `unknown candidate kind ${candidate.kind}`,
  };
}

async function applyPlan(options) {
  const plan = buildPlan(options);
  if (options.onlyUnderPressure && plan.health.blockers.length === 0) {
    return {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      mode: "apply",
      skipped: true,
      reason: "health gate clear",
      health: plan.health,
      actionCount: plan.actionCount,
      reclaimableBytes: plan.reclaimableBytes,
    };
  }
  const selected = plan.actions.slice(0, options.maxActions);
  if (options.onlyUnderPressure && selected.length === 0) {
    return {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      mode: "apply",
      skipped: true,
      reason: "no eligible automatic self-heal actions",
      health: plan.health,
      blockedCount: plan.blockedCount,
      blockedBytes: plan.blockedBytes,
    };
  }
  const receiptId = `mac-heal-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const receiptRoot = join(ARCHIVES_DIR, receiptId);
  const before = healthStatus();
  const results = [];
  ensureDir(receiptRoot);
  for (const candidate of selected) {
    try {
      results.push(applyCandidate(candidate, receiptRoot, plan.cloud));
    } catch (err) {
      results.push({
        id: candidate.id,
        path: candidate.path,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const after = healthStatus();
  const appliedBytes = results
    .filter((result) => result.status === "applied")
    .reduce((sum, result) => sum + (result.bytes ?? 0), 0);
  const receipt = {
    schema: SCHEMA,
    receiptId,
    createdAt: new Date().toISOString(),
    mode: "apply",
    maxActions: options.maxActions,
    before,
    after,
    cloud: plan.cloud,
    selectedCount: selected.length,
    appliedCount: results.filter((result) => result.status === "applied").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    appliedBytes,
    results,
    blockedSummary: {
      count: plan.blockedCount,
      bytes: plan.blockedBytes,
      top: plan.blocked.slice(0, 8),
    },
  };
  const receiptPath = join(RECEIPTS_DIR, `${receiptId}.json`);
  receipt.path = receiptPath;
  writeJsonAtomic(receiptPath, receipt);
  writeJsonAtomic(LATEST_PATH, {
    schema: SCHEMA,
    latestReceiptId: receiptId,
    latestReceiptPath: receiptPath,
    updatedAt: receipt.createdAt,
    appliedBytes,
    afterState: after.state,
  });
  await emitSelfHealEvent(receipt);
  return receipt;
}

async function emitSelfHealEvent(receipt) {
  try {
    await emit({
      source: "chuck-mac-self-heal",
      type: "chuck.mac.self_heal.applied",
      payload: {
        receiptId: receipt.receiptId,
        path: receipt.path,
        appliedCount: receipt.appliedCount,
        failedCount: receipt.failedCount,
        appliedBytes: receipt.appliedBytes,
        notificationCandidate: true,
        signal: {
          schemaVersion: 1,
          category: "mac.self_heal",
          severity: receipt.failedCount > 0 ? "warn" : "info",
          subject: "Mac self-heal",
          summary: `Applied ${receipt.appliedCount} self-heal action(s), reclaimed ${formatBytes(receipt.appliedBytes)}`,
          actionability: receipt.failedCount > 0 ? "inspect" : "observe",
          needsAttention: receipt.failedCount > 0,
          evidence: { path: receipt.path, receiptId: receipt.receiptId },
        },
      },
    });
  } catch {
    // Receipts are primary; bus emission is best effort.
  }
}

function status(options = {}) {
  const latest = readJsonSafe(LATEST_PATH, null);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: "status",
    health: healthStatus(),
    cloud: detectCloudTargets(options.cloudTarget),
    latest,
  };
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= GIB) {
    return `${(value / GIB).toFixed(1)} GiB`;
  }
  if (value >= MIB) {
    return `${(value / MIB).toFixed(1)} MiB`;
  }
  return `${Math.round(value)} B`;
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.mode === "status") {
    console.log(
      `Mac self-heal ${result.health.state}: ${result.health.blockers.join("; ") || "no blockers"}`,
    );
    console.log(`Cloud: ${result.cloud.recommendation}`);
    return;
  }
  if (result.mode === "plan") {
    console.log(
      `Plan: ${result.actionCount} automatic action(s), ${formatBytes(result.reclaimableBytes)} reclaimable, ${result.blockedCount} blocked/review item(s).`,
    );
    return;
  }
  console.log(
    result.skipped
      ? `Skipped self-heal: ${result.reason}`
      : `Applied ${result.appliedCount} action(s), reclaimed ${formatBytes(result.appliedBytes)}, receipt ${result.path}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;
  if (options.command === "status") {
    result = status(options);
  } else if (options.command === "plan") {
    result = buildPlan(options);
  } else {
    result = await applyPlan(options);
  }
  printResult(result, options);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

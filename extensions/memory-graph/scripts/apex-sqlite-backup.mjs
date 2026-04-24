#!/usr/bin/env node
// apex-ring: 1
// apex-sqlite-backup — nightly encrypted backup of the memory graph.
//
// Design authority: panel review 2026-04-23 (Opus 4.7 CLI, Opus 4.7
// Adaptive via claude.ai, ChatGPT 5.5 Thinking, Perplexity Pro). All four
// flagged graph.sqlite as catastrophic-if-neglected and agreed nothing
// protects it. 3-of-4 endorsed the openssl-tonight path with age as the
// Tier-2 upgrade; 1 (Opus CLI) would have installed age first. Ship the
// majority path, with every panel-sharpened refinement.
//
// Pipeline (panel-refined):
//   1. sqlite3 .backup → atomic, WAL-safe, single-file snapshot
//      (no separate WAL/SHM copy — .backup folds it in; copying raw WAL
//      alongside a raw file is how you get torn reads).
//   2. PRAGMA quick_check on the snapshot BEFORE encryption — fail fast
//      if the backup itself is corrupt (ChatGPT's correction; crypto
//      round-trip can't catch bit-rot in the source pages).
//   3. gzip -9 -n → deterministic compression.
//   4. openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256
//      with -pass stdin (NOT -k; ChatGPT caught this — -k exposes the
//      secret in process argv where `ps` can see it).
//   5. shasum -a 256 sidecar → integrity audit.
//   6. Write to iCloud Drive with .tmp suffix, then atomic rename
//      (ChatGPT — prevents readers seeing partial files on slow sync).
//   7. 7-day retention sweep.
//   8. Emit backup-complete event to apex-events.jsonl (hooks into
//      existing bus for the watchdog — absence alert is Tier-1 follow-up).
//
// Keychain ACL (Claude.ai's correction): the install script whitelists
// specific binaries via -T flags on `security add-generic-password`:
// /usr/bin/security, /bin/sh, the node binary. Without these the
// LaunchAgent call to `security find-generic-password` prompts a GUI
// dialog at 03:30 that nobody answers, and the job hangs.
//
// Known gaps accepted tonight (Tier-2 follow-ups):
//   · Single destination (iCloud only) — add Tailscale rsync to a
//     second host this week. All 4 voices flagged single-vendor risk.
//   · openssl enc -aes-256-cbc lacks AEAD; corrupt ciphertext can
//     silently decrypt to garbage. age (ChaCha20-Poly1305) is the
//     upgrade — install and migrate in Tier 2.
//   · Silent-failure watchdog — "no backup-complete in 26h → Telegram
//     L5 alert" is Opus CLI's non-negotiable follow-up. Hook into
//     watchers/index.mjs when present.
//
// Usage:
//   node apex-sqlite-backup.mjs            — run backup (default)
//   node apex-sqlite-backup.mjs verify     — decrypt latest and quick_check
//   node apex-sqlite-backup.mjs status     — print last N backup events

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const DB_PATH = process.env.APEX_BACKUP_DB ?? join(HOME, ".openclaw", "memory", "graph.sqlite");
const ICLOUD_DIR =
  process.env.APEX_BACKUP_ICLOUD ??
  join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "apex-backups");
const EVENTS_LOG = join(HOME, ".openclaw", "memory", "apex-events.jsonl");
const LOG_DIR = join(HOME, ".openclaw", "logs");
const LOG_PATH = join(LOG_DIR, "apex-sqlite-backup.log");
const KEYCHAIN_ITEM = "apex-backup-key";
const RETENTION_DAYS = 7;
const PBKDF2_ITERS = 600000;
const OPENSSL_BIN = process.env.OPENSSL_BIN ?? "/opt/homebrew/bin/openssl";
const SQLITE_BIN = "/usr/bin/sqlite3";

function stamp() {
  // ISO-ish but filename-safe: 2026-04-23T214530-0500
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tzmin = -d.getTimezoneOffset();
  const tzsign = tzmin >= 0 ? "+" : "-";
  const tz = `${tzsign}${pad(Math.floor(Math.abs(tzmin) / 60))}${pad(Math.abs(tzmin) % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${tz}`
  );
}

function log(line) {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  appendFileSync(LOG_PATH, msg, { mode: 0o600 });
  process.stderr.write(msg);
}

function emitEvent(type, payload) {
  try {
    if (!existsSync(dirname(EVENTS_LOG))) {
      return;
    }
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      source: "apex-sqlite-backup",
      type,
      payload,
    })}\n`;
    appendFileSync(EVENTS_LOG, line);
  } catch (err) {
    log(`emitEvent failed: ${String(err)}`);
  }
}

function readPassphrase() {
  // Claude.ai's note: -T whitelist on security add-generic-password lets
  // specific binaries read without a GUI prompt. See install script.
  const res = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", process.env.USER ?? "", "-s", KEYCHAIN_ITEM, "-w"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`security find-generic-password failed (status=${res.status}): ${res.stderr}`);
  }
  return res.stdout.replace(/\n$/, "");
}

function preflightDisk(dir, minMb = 100) {
  // ChatGPT + Opus: pre-check free space on the staging volume.
  try {
    const res = execFileSync("/bin/df", ["-k", dir], { encoding: "utf8" });
    const m = res.trim().split("\n")[1]?.split(/\s+/);
    if (!m) {
      return;
    }
    const freeKb = Number(m[3] ?? 0);
    if (freeKb > 0 && freeKb < minMb * 1024) {
      throw new Error(`insufficient disk on ${dir}: ${(freeKb / 1024).toFixed(1)}MB free`);
    }
  } catch (err) {
    // df failures are non-fatal — continue, log.
    log(`preflight df failed: ${String(err)}`);
  }
}

function runBackup() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`DB not found: ${DB_PATH}`);
  }
  if (!existsSync(ICLOUD_DIR)) {
    mkdirSync(ICLOUD_DIR, { recursive: true, mode: 0o700 });
  }
  const tmpDir = execFileSync("/usr/bin/mktemp", ["-d", "/tmp/apex-sqlite-backup.XXXXXX"], {
    encoding: "utf8",
  }).trim();
  preflightDisk(tmpDir);

  const ts = stamp();
  const base = `graph-${ts}`;
  const snapPath = join(tmpDir, `${base}.sqlite`);
  const gzPath = `${snapPath}.gz`;
  const encPath = `${gzPath}.enc`;

  try {
    // 1. Online SQLite backup — consistent snapshot, no WAL stitching.
    log(`backup-start → ${snapPath}`);
    execFileSync(SQLITE_BIN, [DB_PATH, `.timeout 10000`], { stdio: "ignore" });
    execFileSync(SQLITE_BIN, [DB_PATH], {
      input: `.timeout 10000\n.backup "${snapPath}"\n`,
      stdio: ["pipe", "ignore", "inherit"],
    });
    if (!existsSync(snapPath)) {
      throw new Error(".backup produced no output file");
    }

    // 2. PRAGMA quick_check on the snapshot before shipping.
    const check = execFileSync(SQLITE_BIN, [snapPath, "PRAGMA quick_check;"], {
      encoding: "utf8",
    }).trim();
    if (check !== "ok") {
      throw new Error(`PRAGMA quick_check failed on snapshot: ${check}`);
    }
    log(`quick_check ok`);

    // 3. gzip -9 -n (-n: deterministic, no timestamp in header).
    execFileSync("/usr/bin/gzip", ["-9", "-n", snapPath], { stdio: "inherit" });
    if (!existsSync(gzPath)) {
      throw new Error(`gzip failed: ${gzPath} not present`);
    }

    // 4. openssl enc with -pass stdin (NOT -k; keeps secret out of argv).
    const pass = readPassphrase();
    const openssl = spawnSync(
      OPENSSL_BIN,
      [
        "enc",
        "-aes-256-cbc",
        "-salt",
        "-pbkdf2",
        "-iter",
        String(PBKDF2_ITERS),
        "-md",
        "sha256",
        "-in",
        gzPath,
        "-out",
        encPath,
        "-pass",
        "stdin",
      ],
      { input: `${pass}\n`, encoding: "utf8" },
    );
    if (openssl.status !== 0) {
      throw new Error(`openssl enc failed (status=${openssl.status}): ${openssl.stderr}`);
    }

    const { size } = statSync(encPath);
    const sha256 = execFileSync("/usr/bin/shasum", ["-a", "256", encPath], {
      encoding: "utf8",
    })
      .split(/\s+/)[0]
      ?.trim();

    // 5. Atomic rename in iCloud folder (write .tmp, then mv).
    const iCloudTmp = join(ICLOUD_DIR, `${base}.sqlite.gz.enc.tmp`);
    const iCloudFinal = join(ICLOUD_DIR, `${base}.sqlite.gz.enc`);
    const iCloudShaFinal = join(ICLOUD_DIR, `${base}.sqlite.gz.enc.sha256`);
    execFileSync("/bin/cp", [encPath, iCloudTmp]);
    renameSync(iCloudTmp, iCloudFinal);
    appendFileSync(iCloudShaFinal, `${sha256}  ${base}.sqlite.gz.enc\n`);

    // 6. Prune backups older than RETENTION_DAYS in iCloud.
    pruneOlderThan(ICLOUD_DIR, /^graph-.*\.sqlite\.gz\.enc(\.sha256)?$/, RETENTION_DAYS);

    log(`backup-complete ${base}.sqlite.gz.enc size=${size} sha256=${sha256}`);
    emitEvent("backup-complete", {
      file: `${base}.sqlite.gz.enc`,
      destination: "icloud",
      size,
      sha256,
    });
    return { ok: true, file: iCloudFinal, size, sha256 };
  } catch (err) {
    log(`backup-failed: ${String(err)}`);
    emitEvent("backup-failed", { error: String(err?.message ?? err) });
    throw err;
  } finally {
    // Clean staging.
    try {
      execFileSync("/bin/rm", ["-rf", tmpDir], { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

function pruneOlderThan(dir, pattern, days) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!pattern.test(name)) {
      continue;
    }
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoffMs) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      /* best-effort */
    }
  }
  if (removed > 0) {
    log(`pruned ${removed} files older than ${days}d from ${dir}`);
  }
}

function runVerify() {
  if (!existsSync(ICLOUD_DIR)) {
    throw new Error(`no iCloud backup dir: ${ICLOUD_DIR}`);
  }
  const encs = readdirSync(ICLOUD_DIR)
    .filter((n) => /^graph-.*\.sqlite\.gz\.enc$/.test(n))
    .map((n) => ({ n, full: join(ICLOUD_DIR, n), mt: statSync(join(ICLOUD_DIR, n)).mtimeMs }))
    .toSorted((a, b) => b.mt - a.mt);
  if (encs.length === 0) {
    throw new Error(`no backups in ${ICLOUD_DIR}`);
  }
  const latest = encs[0];
  log(`verify latest: ${latest.n}`);

  const tmpDir = execFileSync("/usr/bin/mktemp", ["-d", "/tmp/apex-verify.XXXXXX"], {
    encoding: "utf8",
  }).trim();
  const gzPath = join(tmpDir, "restore.sqlite.gz");
  const restorePath = join(tmpDir, "restore.sqlite");

  try {
    const pass = readPassphrase();
    const dec = spawnSync(
      OPENSSL_BIN,
      [
        "enc",
        "-d",
        "-aes-256-cbc",
        "-pbkdf2",
        "-iter",
        String(PBKDF2_ITERS),
        "-md",
        "sha256",
        "-in",
        latest.full,
        "-out",
        gzPath,
        "-pass",
        "stdin",
      ],
      { input: `${pass}\n`, encoding: "utf8" },
    );
    if (dec.status !== 0) {
      throw new Error(`openssl decrypt failed (status=${dec.status}): ${dec.stderr}`);
    }
    execFileSync("/usr/bin/gunzip", [gzPath], { stdio: "inherit" });
    const quick = execFileSync(SQLITE_BIN, [restorePath, "PRAGMA quick_check;"], {
      encoding: "utf8",
    }).trim();
    const schemaCount = Number(
      execFileSync(SQLITE_BIN, [restorePath, "SELECT COUNT(*) FROM sqlite_schema;"], {
        encoding: "utf8",
      }).trim(),
    );
    // Optional: compare node count to live DB for a sanity sentinel.
    let nodeCount = null;
    try {
      nodeCount = Number(
        execFileSync(SQLITE_BIN, [restorePath, "SELECT COUNT(*) FROM nodes;"], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      /* table may differ across schemas */
    }
    const ok = quick === "ok" && schemaCount > 0;
    const result = {
      ok,
      file: latest.n,
      quickCheck: quick,
      schemaCount,
      nodeCount,
    };
    log(
      `verify-${ok ? "ok" : "fail"} ${latest.n} quick=${quick} schema=${schemaCount} nodes=${nodeCount ?? "?"}`,
    );
    emitEvent("backup-verify", result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    try {
      execFileSync("/bin/rm", ["-rf", tmpDir], { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

function runStatus() {
  // Scan apex-events.jsonl for recent backup-complete / backup-failed
  // events. Cheap proxy for the watchdog until a full Telegram-alert
  // watcher lands (Tier-1 follow-up).
  if (!existsSync(EVENTS_LOG)) {
    console.log(JSON.stringify({ events: [], warning: "no events log" }));
    return;
  }
  const lines = readFileSync(EVENTS_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-2000)
    .toReversed();
  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.source === "apex-sqlite-backup") {
        events.push(e);
        if (events.length >= 10) {
          break;
        }
      }
    } catch {
      /* skip */
    }
  }
  const lastCompleteAt = events.find((e) => e.type === "backup-complete")?.ts;
  const staleWindow = 26 * 60 * 60 * 1000;
  const stale = lastCompleteAt
    ? Date.now() - new Date(lastCompleteAt).getTime() > staleWindow
    : true;
  const out = { lastCompleteAt, stale, events };
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const cmd = process.argv[2] ?? "run";
  if (cmd === "run" || cmd === "backup") {
    const r = runBackup();
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "verify") {
    runVerify();
  } else if (cmd === "status") {
    runStatus();
  } else {
    console.error("usage: apex-sqlite-backup.mjs [run|verify|status]");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// apex-ring: 1
// apex-profile-pool — parent-side manager of the profile-worker
// daemons. Lazy-spawns one long-running child per profile (a/b/c),
// dispatches jobs over IPC, reaps on parent exit.
//
// Why not a subprocess-per-ask: see apex-profile-worker-daemon.mjs
// header. Persistent children amortize the fork cost across many asks
// and let each child own exactly one CDP connection to one profile's
// Chrome — in-process CDP-connection-pool is the bug vector we avoid
// (per Perplexity's 2026-04-23 review: "the bug vector to avoid is
// stale shared sockets; solve it by making the registry own lifecycle").
//
// Lifecycle:
//   ensureChild(profile) — lazy spawn; returns the record
//   dispatchViaPool({ workerId, prompt, profile, timeoutMs }) — fire a job
//   recycleChild(profile) — kill + respawn (used when a child wedges)
//   shutdownPool() — graceful shutdown; waits for in-flight jobs
//
// Reliability rules (distilled from panel critique 2026-04-23):
//   · One in-flight job per (child × jobId); multiple distinct jobs OK
//     in parallel (Chrome handles multiple CDP clients, and each job
//     picks its own tab in the profile's Chrome).
//   · Timeout ON THE PARENT SIDE — never trust a child to time out.
//   · Child crash → reject all pending, delete record. Next dispatch
//     re-spawns cleanly with fresh generation counter.
//   · Pool is lazy + per-profile — a dead profile doesn't cost a slot.

import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "apex-profile-worker-daemon.mjs",
);

/**
 * @type {Map<string, {
 *   proc: import("node:child_process").ChildProcess,
 *   pending: Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, workerId: string }>,
 *   generation: number,
 *   startedAt: number,
 * }>}
 */
const children = new Map();

let shuttingDown = false;

function ensureChild(profile) {
  let rec = children.get(profile);
  if (rec && rec.proc?.connected) {
    return rec;
  }
  const generation = (rec?.generation ?? 0) + 1;
  const proc = fork(WORKER_SCRIPT, [], {
    env: { ...process.env, APEX_CHROME_PROFILE: profile },
    stdio: ["ipc", "pipe", "pipe"],
    detached: false,
  });
  rec = { proc, pending: new Map(), generation, startedAt: Date.now() };

  proc.on("message", (msg) => {
    if (!msg?.jobId) {
      return;
    }
    const p = rec.pending.get(msg.jobId);
    if (!p) {
      return;
    }
    clearTimeout(p.timer);
    rec.pending.delete(msg.jobId);
    if (msg.ok) {
      p.resolve({ text: msg.text, modelUsed: msg.modelUsed, profile });
    } else {
      const err = new Error(msg.error?.message ?? "worker error");
      err.code = msg.error?.code ?? "WORKER_ERROR";
      err.retryable = msg.error?.retryable ?? true;
      err.profile = profile;
      err.workerId = p.workerId;
      p.reject(err);
    }
  });

  proc.on("exit", (code, signal) => {
    for (const [, p] of rec.pending) {
      clearTimeout(p.timer);
      const err = new Error(
        `profile-${profile} worker exited code=${code} signal=${signal ?? "-"}`,
      );
      err.code = "WORKER_CRASH";
      err.retryable = true;
      err.profile = profile;
      p.reject(err);
    }
    rec.pending.clear();
    if (children.get(profile) === rec) {
      children.delete(profile);
    }
  });

  proc.on("error", (err) => {
    process.stderr.write(`[apex-profile-pool profile=${profile}] child error: ${err}\n`);
  });

  // Forward child stderr to parent stderr, prefixed for clarity.
  if (proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      const s = String(chunk);
      process.stderr.write(s.startsWith("[") ? s : `[pool/${profile}] ${s}`);
    });
  }

  children.set(profile, rec);
  return rec;
}

/**
 * Dispatch a Chrome worker job to the child that owns the given profile.
 * Returns { text, modelUsed, profile }. Throws an Error with
 * { code, retryable, profile, workerId } on failure (codes: CF_CHALLENGE,
 * NOT_SIGNED_IN, TIMEOUT, WORKER_ERROR, WORKER_CRASH, UNKNOWN_WORKER).
 */
export async function dispatchViaPool({ workerId, prompt, profile, timeoutMs = 300_000 }) {
  if (shuttingDown) {
    throw new Error("apex-profile-pool: shutting down");
  }
  if (!workerId || !prompt || !profile) {
    throw new Error(
      `dispatchViaPool: workerId, prompt, profile all required (got ${workerId}, ${prompt?.length ?? "null"}, ${profile})`,
    );
  }
  const rec = ensureChild(profile);
  const jobId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rec.pending.delete(jobId);
      const err = new Error(`profile-${profile} ${workerId} timed out after ${timeoutMs}ms`);
      err.code = "TIMEOUT";
      err.retryable = true;
      err.profile = profile;
      err.workerId = workerId;
      reject(err);
    }, timeoutMs);
    rec.pending.set(jobId, { resolve, reject, timer, workerId });
    rec.proc.send({ jobId, workerId, prompt }, (sendErr) => {
      if (sendErr) {
        clearTimeout(timer);
        rec.pending.delete(jobId);
        reject(sendErr);
      }
    });
  });
}

/**
 * Kill and re-spawn the child for a given profile. Used when a child
 * becomes unresponsive or accumulates too many errors. Existing pending
 * jobs on the old child get rejected via the exit handler.
 */
export function recycleChild(profile) {
  const rec = children.get(profile);
  if (!rec) {
    return;
  }
  try {
    rec.proc.kill("SIGTERM");
  } catch {
    /* best-effort */
  }
  // ensureChild() on next call will spawn a fresh one.
}

/**
 * Graceful shutdown: ask each child to exit, wait up to `graceMs`
 * for pending jobs to complete. Called on parent SIGTERM / exit.
 */
export async function shutdownPool({ graceMs = 3000 } = {}) {
  shuttingDown = true;
  const tasks = [];
  for (const [profile, rec] of children.entries()) {
    if (rec.proc?.connected) {
      try {
        rec.proc.send({ shutdown: true });
      } catch {
        /* best-effort */
      }
    }
    tasks.push(
      new Promise((done) => {
        const timer = setTimeout(() => {
          try {
            rec.proc.kill("SIGTERM");
          } catch {
            /* best-effort */
          }
          done();
        }, graceMs);
        rec.proc.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      }),
    );
    children.delete(profile);
  }
  await Promise.allSettled(tasks);
}

/**
 * Snapshot of pool state for telemetry / debugging.
 */
export function poolStats() {
  const out = {};
  for (const [profile, rec] of children.entries()) {
    out[profile] = {
      pid: rec.proc?.pid,
      connected: rec.proc?.connected ?? false,
      pendingJobs: rec.pending.size,
      generation: rec.generation,
      uptimeMs: Date.now() - rec.startedAt,
    };
  }
  return out;
}

// Parent-process cleanup: make sure children don't leak on normal exit.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void shutdownPool({ graceMs: 1000 }).finally(() => process.exit(0));
  });
}
process.on("exit", () => {
  for (const [, rec] of children.entries()) {
    try {
      rec.proc.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
  }
});

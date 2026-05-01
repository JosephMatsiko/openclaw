// Workstation lease — the seam that prevents parallel web-voice calls
// from clobbering each other's Chrome session.
//
// Why this exists: any two voices that need to drive the user's logged-in
// Chrome serially share one mouse + one keyboard focus. Parallel
// AppleScript calls into Chrome race; one cancels the other; both fail.
// The lease serializes — only one call at a time can hold the lease, and
// must release it before the next caller acquires.
//
// File-based, single-host: ~/.openclaw/workspace/state/chuck-v2/surface-control/active-workstation-lease.json
//
// This v0.1 reuses the existing chuck-surface-control lease file format
// so the legacy .mjs scripts (apex-panel-ask, etc.) and this new TS
// plugin coordinate over the same state. v0.2 may replace with a
// gateway-resident lease registry once the openclaw runtime exposes one.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();
const DEFAULT_LEASE_PATH = join(
  HOME,
  ".openclaw",
  "workspace",
  "state",
  "chuck-v2",
  "surface-control",
  "active-workstation-lease.json",
);

const MAX_LEASE_HOLD_MS = 5 * 60_000;

export interface LeaseRecord {
  leaseId: string;
  status: "held" | "returned";
  reason: string;
  runId: string | null;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string | null;
}

export interface AcquireOptions {
  reason: string;
  /** Override default lease file path (typically for tests). */
  leasePath?: string;
  /** How long the caller intends to hold the lease before being force-evicted. */
  holdMs?: number;
  /** Run id (e.g. panel dispatch id) for cross-referencing. */
  runId?: string | null;
}

function leaseId(prefix = "wsl") {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function readLease(path: string): LeaseRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LeaseRecord;
  } catch {
    return null;
  }
}

function writeLeaseAtomic(path: string, record: LeaseRecord): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Try to acquire the workstation lease. Returns null when another holder
 * is active and not stale; returns the new LeaseRecord on success.
 *
 * Stale-detection: if an existing lease's expiresAt is in the past, treat
 * it as expired and steal it. This prevents a crashed harness from
 * permanently locking the workstation.
 */
export function tryAcquire(opts: AcquireOptions): LeaseRecord | null {
  const path = opts.leasePath ?? DEFAULT_LEASE_PATH;
  const now = Date.now();
  const existing = readLease(path);
  if (existing && existing.status === "held") {
    const expiresAt = Date.parse(existing.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      return null; // someone else holds it
    }
    // expired — steal it
  }
  const holdMs = Math.min(opts.holdMs ?? 60_000, MAX_LEASE_HOLD_MS);
  const acquiredAt = new Date(now).toISOString();
  const expiresAt = new Date(now + holdMs).toISOString();
  const record: LeaseRecord = {
    leaseId: leaseId(),
    status: "held",
    reason: opts.reason,
    runId: opts.runId ?? null,
    acquiredAt,
    expiresAt,
  };
  writeLeaseAtomic(path, record);
  return record;
}

/**
 * Release a held lease. Call from the harness after the voice replies
 * (success or failure) so the next caller can proceed without waiting
 * for stale-detection.
 */
export function release(leaseId: string, leasePath?: string): boolean {
  const path = leasePath ?? DEFAULT_LEASE_PATH;
  const existing = readLease(path);
  if (!existing) return false;
  if (existing.leaseId !== leaseId) return false;
  const released: LeaseRecord = {
    ...existing,
    status: "returned",
    releasedAt: new Date().toISOString(),
  };
  writeLeaseAtomic(path, released);
  return true;
}

/**
 * Inspect the current lease state without modifying it. Useful for status
 * dashboards.
 */
export function inspect(leasePath?: string): LeaseRecord | null {
  return readLease(leasePath ?? DEFAULT_LEASE_PATH);
}

/**
 * Wait up to `timeoutMs` for a free lease, polling every `pollMs`.
 * Returns the acquired record or null on timeout.
 */
export async function acquireWithRetry(
  opts: AcquireOptions & { timeoutMs?: number; pollMs?: number },
): Promise<LeaseRecord | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const pollMs = Math.max(opts.pollMs ?? 250, 50);
  while (Date.now() < deadline) {
    const acquired = tryAcquire(opts);
    if (acquired) return acquired;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

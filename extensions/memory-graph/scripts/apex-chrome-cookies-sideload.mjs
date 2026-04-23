#!/usr/bin/env node
// Apex Chrome cookie sideload — clones session cookies from Joseph's
// main Chrome profile into the dedicated Apex Chrome instance via CDP
// `Network.setCookies`. Zero re-sign-in.
//
// Mechanism:
//   1. Open Joseph's main profile Cookies DB (SQLite, ro+immutable) —
//      safe to read while Chrome is live.
//   2. Decrypt `encrypted_value` using the macOS Keychain entry
//      "Chrome Safe Storage" (prompts once; subsequent runs reuse).
//      AES-128-CBC, key = PBKDF2(passphrase, "saltysalt", 1003, 16, sha1),
//      IV = 16 spaces (Chrome convention).
//   3. Transform rows to CDP Network.CookieParam format.
//   4. Push via CDP to the Apex Chrome browser target.
//
// Machine-level invariant: same macOS user ⇒ same Keychain passphrase
// ⇒ same derived key ⇒ main-profile cookies decrypt cleanly and
// re-encrypt correctly inside Apex Chrome.
//
// Exports:
//   sideloadCookies({ domains, verbose })
//
// CLI:
//   node apex-chrome-cookies-sideload.mjs                           # all known
//   node apex-chrome-cookies-sideload.mjs chatgpt.com perplexity.ai

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { browserConnection } from "./apex-chrome-cdp.mjs";

const MAIN_PROFILE_COOKIES = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "Default",
  "Cookies",
);

const DEFAULT_DOMAINS = [
  "chatgpt.com",
  "openai.com",
  "perplexity.ai",
  "gemini.google.com",
  "google.com",
  "accounts.google.com",
  "claude.ai",
  "anthropic.com",
  "grok.com",
  "x.ai",
];

let cachedKey = null;

function deriveKey() {
  if (cachedKey) {
    return cachedKey;
  }
  const r = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    throw new Error(
      `Keychain lookup failed: ${String(r.stderr).slice(0, 200).trim()}. Approve the Keychain prompt if it appeared.`,
    );
  }
  const passphrase = String(r.stdout).trim();
  cachedKey = crypto.pbkdf2Sync(passphrase, "saltysalt", 1003, 16, "sha1");
  return cachedKey;
}

function decryptCookieValue(encryptedBlob) {
  if (!encryptedBlob || encryptedBlob.length === 0) {
    return "";
  }
  const key = deriveKey();
  const prefix = encryptedBlob.slice(0, 3).toString();
  const versioned = prefix === "v10" || prefix === "v11";
  const ciphertext = versioned ? encryptedBlob.slice(3) : encryptedBlob;
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Modern Chromium (v10/v11 cookies) prepends a 32-byte SHA-256
  // integrity prefix before the real value. Older records don't.
  // Heuristic: if versioned AND the first 32 bytes contain non-printable
  // bytes that look like binary hash data, strip them.
  if (versioned && pt.length > 32) {
    const head = pt.slice(0, 32);
    let nonPrintable = 0;
    for (const b of head) {
      if (b < 0x20 || b > 0x7e) {
        nonPrintable += 1;
      }
    }
    if (nonPrintable >= 8) {
      return pt.slice(32).toString("utf8");
    }
  }
  return pt.toString("utf8");
}

// Chrome stores expires_utc as microseconds since 1601. CDP expects
// UNIX seconds. Zero expires_utc = session cookie.
function chromeExpiresToUnix(chromeMicros) {
  if (!chromeMicros) {
    return undefined;
  }
  try {
    const ms = Number(BigInt(chromeMicros) / 1000n) - 11644473600_000;
    if (ms <= 0) {
      return undefined;
    }
    return Math.floor(ms / 1000);
  } catch {
    return undefined;
  }
}

function sameSiteToCdp(n) {
  // Chrome SQLite samesite: -1=Unspecified, 0=None, 1=Lax, 2=Strict.
  // CDP accepts "Strict" | "Lax" | "None". Unspecified ≈ "Lax" (modern default).
  switch (Number(n)) {
    case 0:
      return "None";
    case 1:
      return "Lax";
    case 2:
      return "Strict";
    default:
      return "Lax";
  }
}

function readCookiesForDomains(domains) {
  if (!existsSync(MAIN_PROFILE_COOKIES)) {
    throw new Error(`main profile cookies DB not found: ${MAIN_PROFILE_COOKIES}`);
  }
  const db = new DatabaseSync(`file:${MAIN_PROFILE_COOKIES}?mode=ro&immutable=1`, {
    readOnly: true,
  });
  try {
    const cookies = [];
    const seen = new Set();
    for (const d of domains) {
      const rows = db
        .prepare(
          `SELECT host_key, name, path, is_secure, is_httponly, samesite,
                  CAST(expires_utc AS TEXT) AS expires,
                  value, encrypted_value
             FROM cookies
            WHERE host_key = ? OR host_key = ? OR host_key LIKE ?`,
        )
        .all(d, `.${d}`, `%.${d}`);
      for (const r of rows) {
        const keyTuple = `${r.host_key}|${r.path}|${r.name}`;
        if (seen.has(keyTuple)) {
          continue;
        }
        seen.add(keyTuple);
        let value = String(r.value ?? "");
        if ((!value || value.length === 0) && r.encrypted_value && r.encrypted_value.length > 0) {
          try {
            value = decryptCookieValue(Buffer.from(r.encrypted_value));
          } catch (err) {
            // Skip undecodable cookies rather than aborting the batch.
            void err;
            continue;
          }
        }
        cookies.push({
          name: String(r.name),
          value,
          domain: String(r.host_key),
          path: String(r.path || "/"),
          secure: Boolean(r.is_secure),
          httpOnly: Boolean(r.is_httponly),
          sameSite: sameSiteToCdp(r.samesite),
          expires: chromeExpiresToUnix(r.expires),
        });
      }
    }
    return cookies;
  } finally {
    db.close();
  }
}

export async function sideloadCookies({ domains = DEFAULT_DOMAINS, verbose = false } = {}) {
  const cookies = readCookiesForDomains(domains);
  if (cookies.length === 0) {
    return { pushed: 0, domains, cookies: [] };
  }
  const conn = await browserConnection();
  try {
    // Storage.setCookies is the browser-level cookie-push method.
    // (Network.setCookies requires a page target + enabled Network
    // domain — cheaper to go straight to Storage.)
    const CHUNK = 100;
    let pushed = 0;
    for (let i = 0; i < cookies.length; i += CHUNK) {
      const batch = cookies.slice(i, i + CHUNK);
      try {
        await conn.send("Storage.setCookies", { cookies: batch });
        pushed += batch.length;
      } catch (err) {
        // Retry per-cookie so one bad entry doesn't drop the chunk.
        for (const c of batch) {
          try {
            await conn.send("Storage.setCookies", { cookies: [c] });
            pushed += 1;
          } catch (inner) {
            if (verbose) {
              console.error(
                `[cookie-sideload] skipped ${c.domain}/${c.name}: ${inner instanceof Error ? inner.message : String(inner)}`,
              );
            }
          }
        }
        void err;
      }
    }
    return { pushed, domains, total: cookies.length };
  } finally {
    conn.close();
  }
}

// ---- CLI ---------------------------------------------------------------

async function mainCli() {
  const args = process.argv.slice(2);
  const domains = args.length > 0 ? args : DEFAULT_DOMAINS;
  const verbose = args.includes("--verbose") || process.env.APEX_VERBOSE === "1";
  const filteredDomains = domains.filter((d) => !d.startsWith("--"));
  const res = await sideloadCookies({
    domains: filteredDomains.length > 0 ? filteredDomains : DEFAULT_DOMAINS,
    verbose,
  });
  console.log(
    `[apex-cookies] pushed=${res.pushed}/${res.total ?? res.pushed} · domains=${res.domains.join(",")}`,
  );
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  mainCli().catch((err) => {
    console.error(`[apex-cookies] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}

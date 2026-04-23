import fs from "node:fs";
import path from "node:path";
import { evaluateShellAllowlist } from "../../infra/exec-approvals-allowlist.js";
import { loadExecApprovals, normalizeExecSecurity } from "../../infra/exec-approvals.js";
import type { ExecAllowlistEntry } from "../../infra/exec-approvals.types.js";
import { formatSandboxUnavailableMessage, probeSandboxRuntime } from "./sandbox-probe.js";
import type { BrokerDecision, BrokerInput, ExecBroker } from "./types.js";

// Default allowed bin basenames when security="allowlist".
// Only covers tools needed for a normal dev workflow — everything else
// requires an explicit allow-always entry in exec-approvals.json.
const DEFAULT_ALLOWED_BINS = new Set([
  // version control
  "git",
  // node ecosystem
  "node",
  "pnpm",
  "npm",
  "npx",
  "tsx",
  "tsc",
  "vitest",
  "esbuild",
  "rollup",
  "vite",
  "turbo",
  // read / text processing
  "ls",
  "cat",
  "head",
  "tail",
  "echo",
  "printf",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "fd",
  "find",
  "awk",
  "sed",
  "jq",
  "yq",
  // path / env inspection
  "which",
  "type",
  "command",
  "basename",
  "dirname",
  "pwd",
  "whoami",
  "id",
  "date",
  "uname",
  "env",
  "printenv",
  // safe file ops
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "rmdir",
  // process info
  "ps",
  "kill",
  // no-ops
  "true",
  "false",
  "test",
  "[",
]);

// Synthetic ExecAllowlistEntry[] for pty-mode analysis — one entry per bin
// using a **/name glob so any install location is accepted.
const DEFAULT_ALLOWLIST_ENTRIES: ExecAllowlistEntry[] = Array.from(DEFAULT_ALLOWED_BINS).map(
  (name) => ({ pattern: `**/${name}` }),
);

// Bins that are always denied regardless of allowlist — privilege escalation.
const ALWAYS_DENIED_BINS = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "sandbox-exec",
  "chroot",
  "unshare",
  "nsenter",
  "newuidmap",
  "newgidmap",
]);

// Env key patterns whose values must be redacted before a child process spawns.
const SECRET_SUFFIX_RE =
  /(?:_token|_key|_secret|_password|_credential|_cert|_private|_seed|_mnemonic)$/i;
const EXACT_SECRET_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "SLACK_TOKEN",
  "DISCORD_TOKEN",
  "STRIPE_SECRET_KEY",
  "DATABASE_URL",
]);

// ---------------------------------------------------------------------------
// Audit log (best-effort, never throws into the spawn path)
// ---------------------------------------------------------------------------

let _auditStream: fs.WriteStream | null = null;
let _auditStreamFailed = false;

function getAuditStream(): fs.WriteStream | null {
  if (_auditStreamFailed) {
    return null;
  }
  if (_auditStream) {
    return _auditStream;
  }
  try {
    const dir = path.join(process.env.HOME ?? "", ".openclaw", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const stream = fs.createWriteStream(path.join(dir, "broker.jsonl"), { flags: "a" });
    stream.on("error", () => {
      _auditStreamFailed = true;
      _auditStream = null;
    });
    _auditStream = stream;
    return stream;
  } catch {
    _auditStreamFailed = true;
    return null;
  }
}

type AuditEntry = {
  kind: "allow" | "deny";
  mode: "child" | "pty";
  sessionId?: string;
  backendId?: string;
  argv0?: string;
  command?: string;
  reason: string;
  code?: string;
};

function writeAudit(entry: AuditEntry): void {
  const stream = getAuditStream();
  if (!stream) {
    return;
  }
  try {
    stream.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Env redaction
// ---------------------------------------------------------------------------

function isSecretKey(key: string): boolean {
  return EXACT_SECRET_KEYS.has(key) || SECRET_SUFFIX_RE.test(key);
}

function redactEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : v;
  }
  return out;
}

function envNeedsRedaction(env: NodeJS.ProcessEnv | undefined): boolean {
  if (!env) {
    return false;
  }
  return Object.keys(env).some(isSecretKey);
}

// ---------------------------------------------------------------------------
// Policy broker
// ---------------------------------------------------------------------------

function resolveSecurityMode(): "full" | "allowlist" | "deny" {
  try {
    const file = loadExecApprovals();
    const raw = file.defaults?.security;
    return normalizeExecSecurity(raw) ?? "full";
  } catch {
    return "full";
  }
}

function checkChildArgv(argv: string[]): { allowed: boolean; code?: string; reason?: string } {
  const argv0 = argv[0] ?? "";
  const base = path
    .basename(argv0)
    .toLowerCase()
    .replace(/\.exe$/i, "");

  if (ALWAYS_DENIED_BINS.has(base)) {
    return { allowed: false, code: "dangerous-bin", reason: `${base} is not permitted` };
  }

  if (DEFAULT_ALLOWED_BINS.has(base)) {
    return { allowed: true };
  }

  return { allowed: false, code: "allowlist-miss", reason: `${argv0} is not on the allowlist` };
}

export function createExecPolicyBroker(): ExecBroker {
  return {
    validate(input: BrokerInput): BrokerDecision {
      const security = resolveSecurityMode();
      const { sessionId, backendId, env } = input;
      const needsRedact = envNeedsRedaction(env);

      // full mode — allow everything, still redact env
      if (security === "full") {
        writeAudit({ kind: "allow", mode: input.mode, sessionId, backendId, reason: "full-mode" });
        if (needsRedact && env) {
          return { kind: "allow", reason: "full-mode", env: redactEnv(env) };
        }
        return { kind: "allow", reason: "full-mode" };
      }

      // Non-full security modes require a sandbox runtime to be available.
      // If backendId is NOT "exec-sandbox" (i.e. the command would run on the host),
      // fail closed when no Docker/OrbStack socket is reachable.
      if (backendId !== "exec-sandbox") {
        const probe = probeSandboxRuntime();
        if (!probe.available) {
          const reason = formatSandboxUnavailableMessage();
          writeAudit({
            kind: "deny",
            mode: input.mode,
            sessionId,
            backendId,
            reason,
            code: "sandbox-unavailable",
          });
          return { kind: "deny", reason, code: "sandbox-unavailable" };
        }
      }

      // deny mode — block everything
      if (security === "deny") {
        const argv0 = input.mode === "child" ? (input.argv[0] ?? "") : "";
        writeAudit({
          kind: "deny",
          mode: input.mode,
          sessionId,
          backendId,
          argv0: argv0 || undefined,
          reason: "deny-mode",
          code: "deny-mode",
        });
        return { kind: "deny", reason: "security=deny: all exec blocked", code: "deny-mode" };
      }

      // allowlist mode
      if (input.mode === "child") {
        const argv0 = input.argv[0] ?? "";
        const check = checkChildArgv(input.argv);
        if (!check.allowed) {
          writeAudit({
            kind: "deny",
            mode: "child",
            sessionId,
            backendId,
            argv0,
            reason: check.reason ?? "allowlist-miss",
            code: check.code,
          });
          return {
            kind: "deny",
            reason: `exec broker: ${check.reason ?? "command not allowed"}`,
            code: check.code,
          };
        }
        writeAudit({
          kind: "allow",
          mode: "child",
          sessionId,
          backendId,
          argv0,
          reason: "allowlist-match",
        });
        if (needsRedact && env) {
          return { kind: "allow", reason: "allowlist-match", env: redactEnv(env) };
        }
        return { kind: "allow", reason: "allowlist-match" };
      }

      // pty mode — full shell analysis.
      // Merge default synthetic entries with user-configured allow-always entries.
      const configAllowlist: ExecAllowlistEntry[] = (() => {
        try {
          const file = loadExecApprovals();
          const wildcard = file.agents?.["*"];
          return Array.isArray(wildcard?.allowlist) ? wildcard.allowlist : [];
        } catch {
          return [];
        }
      })();
      const mergedAllowlist = [...DEFAULT_ALLOWLIST_ENTRIES, ...configAllowlist];
      const result = evaluateShellAllowlist({
        command: input.ptyCommand,
        allowlist: mergedAllowlist,
        safeBins: new Set(),
        cwd: input.cwd,
        env: input.env,
      });

      if (!result.allowlistSatisfied) {
        writeAudit({
          kind: "deny",
          mode: "pty",
          sessionId,
          backendId,
          command: input.ptyCommand.slice(0, 200),
          reason: "allowlist-miss",
          code: "allowlist-miss",
        });
        return {
          kind: "deny",
          reason: "exec broker: command not on allowlist",
          code: "allowlist-miss",
        };
      }

      writeAudit({
        kind: "allow",
        mode: "pty",
        sessionId,
        backendId,
        command: input.ptyCommand.slice(0, 200),
        reason: "allowlist-match",
      });
      if (needsRedact && env) {
        return {
          kind: "allow",
          reason: "allowlist-match",
          ptyCommand: input.ptyCommand,
          env: redactEnv(env),
        };
      }
      return { kind: "allow", reason: "allowlist-match" };
    },
  };
}

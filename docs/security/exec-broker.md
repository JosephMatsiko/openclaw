---
title: Exec Broker
summary: Architecture, decision matrix, log schema, and extension guide for the Phase 1 exec broker
status: active
read_when: You want to understand how exec commands are validated, audited, or extended.
---

# Exec Broker

The exec broker is an in-process policy layer that sits between the agent's tool calls and the `ProcessSupervisor`. Every `spawn()` request passes through it, making it the single chokepoint for command policy, env redaction, and audit logging.

## Architecture

```
Tool call (exec)
  │
  ▼
bash-tools.exec.ts          ← elevateReason validation (M5)
  │
  ▼
getProcessSupervisor()
  │
  └─► BrokeredSupervisor (decorator, M1)
          │  reads brokerRef.current
          ▼
      ExecPolicyBroker.validate(BrokerInput)   ← M2/M3
          │
          ├─ security mode read from exec-approvals.json
          ├─ sandbox runtime probe (M3)
          ├─ allowlist / deny-list check
          ├─ env redaction
          └─ audit log write → ~/.openclaw/logs/broker.jsonl
                │
                ▼ BrokerDecision { kind: "allow" | "deny" }
          │
          ▼
      inner ProcessSupervisor.spawn()  ← actual exec
```

## Activation

The broker is installed when `OPENCLAW_EXEC_BROKER=1` (or `true`) is set in the process environment. Without this flag the broker ref is null and all spawns pass through unmodified.

```bash
OPENCLAW_EXEC_BROKER=1 openclaw start
```

## Security modes

The active mode is read from `~/.openclaw/exec-approvals.json` `.defaults.security`:

| Mode          | Behavior                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `"full"`      | Allow everything. Env redaction still applies.                                                           |
| `"allowlist"` | Deny unless argv[0] basename is in `DEFAULT_ALLOWED_BINS` or user allow-always list. Sandbox probe runs. |
| `"deny"`      | Block all spawns. Sandbox probe runs.                                                                    |

Default is `"full"` — no behavior change without explicit config.

### Setting allowlist mode

```json
// ~/.openclaw/exec-approvals.json
{
  "version": 1,
  "defaults": {
    "security": "allowlist"
  }
}
```

## Decision matrix

For `child` mode (argv-based spawn):

| Condition                                | Decision | Code                  |
| ---------------------------------------- | -------- | --------------------- |
| security = full                          | allow    | —                     |
| security ≠ full, Docker not reachable    | deny     | `sandbox-unavailable` |
| security = deny                          | deny     | `deny-mode`           |
| argv[0] in ALWAYS_DENIED_BINS            | deny     | `dangerous-bin`       |
| argv[0] basename in DEFAULT_ALLOWED_BINS | allow    | —                     |
| argv[0] not in allowlist                 | deny     | `allowlist-miss`      |

For `pty` mode (shell string), the decision uses `evaluateShellAllowlist` with synthetic `**/name` glob entries for each bin in `DEFAULT_ALLOWED_BINS`.

## Default allowed bins

```
git, node, pnpm, npm, npx, tsx, tsc, vitest, esbuild, rollup, vite, turbo,
ls, cat, head, tail, echo, printf, wc, sort, uniq, cut, tr,
grep, egrep, fgrep, rg, fd, find, awk, sed, jq, yq,
which, type, command, basename, dirname, pwd, whoami, id, date, uname,
env, printenv, mkdir, touch, cp, mv, rm, rmdir, ps, kill, true, false, test, [
```

## Always-denied bins

`sudo`, `su`, `doas`, `pkexec`, `sandbox-exec`, `chroot`, `unshare`, `nsenter`, `newuidmap`, `newgidmap`

These are blocked in all security modes including allowlist.

## Env redaction

The broker strips secret values from the `env` map passed to `inner.spawn()`. Keys matching these patterns are replaced with `[REDACTED]`:

- Suffix pattern: `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, `*_CERT`, `*_PRIVATE`, `*_SEED`, `*_MNEMONIC`
- Exact keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`, `SLACK_TOKEN`, `DISCORD_TOKEN`, `STRIPE_SECRET_KEY`, `DATABASE_URL`

Env redaction applies in all security modes.

## Sandbox probe (M3)

In `allowlist` and `deny` modes, the broker calls `probeSandboxRuntime()` before evaluating policy. If no Docker/OrbStack socket is reachable AND the spawn is not already inside a sandbox container (`backendId !== "exec-sandbox"`), the spawn is denied with `code: "sandbox-unavailable"`.

Socket paths probed (macOS): OrbStack → Docker Desktop → Colima → Rancher Desktop  
Socket paths probed (Linux): `/run/docker.sock` → `/var/run/docker.sock`

## Audit log

Every validate() call writes a JSON line to `~/.openclaw/logs/broker.jsonl`:

```jsonc
{
  "ts": 1745000000000,       // Unix ms
  "kind": "allow" | "deny",
  "mode": "child" | "pty",
  "sessionId": "s1",
  "backendId": "exec-host",
  "argv0": "/usr/bin/git",   // child mode only
  "command": "git status",   // pty mode only (truncated to 200 chars)
  "reason": "allowlist-match",
  "code": "allowlist-miss"   // deny decisions only
}
```

The log is append-only and best-effort (write failures are silenced).

## Extending the allowlist

Add entries to `~/.openclaw/exec-approvals.json` under `agents["*"].allowlist` (applies to all agents) or `agents["<agentId>"].allowlist`:

```json
{
  "version": 1,
  "defaults": { "security": "allowlist" },
  "agents": {
    "*": {
      "allowlist": [{ "pattern": "/usr/local/bin/custom-tool" }]
    }
  }
}
```

For pty mode, patterns are matched via glob against the resolved binary path. For child mode, only `DEFAULT_ALLOWED_BINS` basenames are checked (allowlist entries are not consulted in child mode in the current implementation — this is a known limitation to address in Phase 1.1).

## Per-command elevation (M5)

When an agent calls `exec` with `elevated: true`, the `elevateReason` field is **required** and must be ≥10 characters:

```json
{
  "command": "sudo systemctl restart nginx",
  "elevated": true,
  "elevateReason": "Restarting nginx after config change confirmed safe"
}
```

Missing or short `elevateReason` throws before the command is dispatched. The reason is logged verbatim.

## Residual risks

| Risk                           | Notes                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interpreter inline-eval bypass | `python -c "import os; os.system('rm -rf /')"` passes the allowlist check because `python` is not in `DEFAULT_ALLOWED_BINS`. But if it were, the inline payload would not be analyzed. |
| pty shell expansion            | Complex shell strings with `$()` or backticks may evade `evaluateShellAllowlist` analysis.                                                                                             |
| Skill exec not audited         | Skills calling internal exec paths may bypass the broker. Phase 2 skill isolation will close this.                                                                                     |

See `docs/security/THREAT-MODEL-ATLAS.md` for full threat model entries (T-EXEC-004, T-IMPACT-001).

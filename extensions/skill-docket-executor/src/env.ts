// buildExecutorEnv — PATH augment for child-process spawns under launchd.
//
// When chuck-docket-executor runs under launchd, process.env.PATH is
// launchd's minimal one and doesn't include /opt/homebrew/bin,
// ~/.openclaw/bin, or the nvm-installed Node bin dir. Without this
// augment, spawn("codex", ...) returns ENOENT even though the binary
// exists. Caused multiple "spawn codex ENOENT" deltas 2026-04-29
// (multi-family agreement, see compaction-20260429T203243847Z). Fix
// here unblocks Chuck-builds-Chuck for code work via the codex lane.

import { homedir } from "node:os";

export function buildExecutorEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME ?? homedir();
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

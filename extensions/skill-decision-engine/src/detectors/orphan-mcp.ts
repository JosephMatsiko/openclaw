// Detector: orphan-mcp — apex-* MCP script registered in 0/3 CLI registries.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Detector, DetectorHit } from "../types.js";
import { fingerprint, readJson } from "../util.js";

interface OpenclawConfig {
  mcp?: { servers?: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
}

export const detectOrphanMcp: Detector = ({ config }): DetectorHit | null => {
  if (!existsSync(config.scriptsDir)) return null;
  let files: string[];
  try {
    files = readdirSync(config.scriptsDir).filter(
      (n) => n.endsWith(".mjs") && (n.startsWith("apex-") || n.endsWith("-toolkit.mjs")),
    );
  } catch {
    return null;
  }

  // MCP-server-shaped: contains StdioServerTransport or McpServer( in first ~2KB.
  const mcpFiles = files.filter((n) => {
    try {
      return /StdioServerTransport|McpServer\(/.test(
        readFileSync(join(config.scriptsDir, n), "utf8").slice(0, 2000),
      );
    } catch {
      return false;
    }
  });

  const codexNames = new Set<string>();
  try {
    const tomlText = readFileSync(config.codexConfigPath, "utf8");
    for (const m of tomlText.matchAll(/^\[mcp_servers\.([a-z][a-z0-9-]*)\]/gm)) {
      codexNames.add(m[1]);
    }
  } catch {
    /* ignore */
  }
  const openclawCfg = readJson<OpenclawConfig>(config.openclawConfigPath, {});
  const openclawNames = new Set(
    Object.keys(openclawCfg?.mcp?.servers ?? openclawCfg?.mcpServers ?? {}),
  );
  const claudeNames = new Set(
    Object.keys(readJson<ClaudeConfig>(config.claudeConfigPath, {})?.mcpServers ?? {}),
  );

  const orphans: string[] = [];
  for (const f of mcpFiles) {
    const name = f.replace(/\.mjs$/, "");
    const registered =
      (codexNames.has(name) ? 1 : 0) +
      (openclawNames.has(name) ? 1 : 0) +
      (claudeNames.has(name) ? 1 : 0);
    if (registered === 0) orphans.push(name);
  }
  if (orphans.length === 0) return null;

  const candidate = orphans[0];
  return {
    category: "orphan-mcp",
    fingerprint: fingerprint("orphan-mcp", candidate),
    situation: `MCP-shaped script '${candidate}' exists in scripts/ but is registered in 0/3 CLI registries (codex, openclaw, claude)`,
    options: [
      {
        label: "wire-all-three",
        action: `Add '${candidate}' entry to ~/.codex/config.toml + ~/.openclaw/openclaw.json mcp.servers + ~/.claude.json mcpServers, then restart loaded CLIs`,
      },
      {
        label: "leave-as-library",
        action: `If '${candidate}' is intended as an internal library only, leave it but rename to drop the apex-/-toolkit prefix to avoid future false-positives`,
      },
    ],
    recommendation: "wire-all-three",
    rationale: `Script declares MCP-server shape (StdioServerTransport or McpServer) but no consumer can reach it. Either it should be wired everywhere (capability voice) or its naming is misleading. Wiring is the higher-value path. Other orphans this scan: ${orphans.slice(1).join(", ") || "none"}.`,
    riskClass: "low",
    evidence: { script: candidate, otherOrphans: orphans.slice(1), registeredIn: 0 },
    rollback: `Remove the entries from each of the three configs; CLI restart unwires it.`,
  };
};

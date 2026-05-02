// Detector: mcpgap — apex-* MCP script missing from one or more of the 3 CLI
// registries (codex.toml, openclaw.json, claude.json).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DetectorContext, Gap } from "../types.js";
import { fingerprint, readJson } from "../util.js";

interface OpenclawConfig {
  mcp?: { servers?: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
}

export function detectMcpGap(ctx: DetectorContext): Gap[] {
  if (!existsSync(ctx.config.scriptsDir)) return [];
  let allFiles: string[];
  try {
    allFiles = readdirSync(ctx.config.scriptsDir).filter((n) => n.endsWith(".mjs"));
  } catch {
    return [];
  }
  const allMcp = allFiles.filter((n) => {
    if (!n.startsWith("apex-") && !n.endsWith("-toolkit.mjs")) return false;
    try {
      return /StdioServerTransport|McpServer\(/.test(
        readFileSync(join(ctx.config.scriptsDir, n), "utf8").slice(0, 2000),
      );
    } catch {
      return false;
    }
  });

  const codexNames = new Set<string>();
  try {
    const tomlText = readFileSync(ctx.config.codexConfigPath, "utf8");
    for (const m of tomlText.matchAll(/^\[mcp_servers\.([a-z][a-z0-9-]*)\]/gm)) {
      codexNames.add(m[1]);
    }
  } catch {
    /* ignore */
  }
  const openclawCfg = readJson<OpenclawConfig>(ctx.config.openclawConfigPath, {});
  const openclawNames = new Set(
    Object.keys(openclawCfg?.mcp?.servers ?? openclawCfg?.mcpServers ?? {}),
  );
  const claudeNames = new Set(
    Object.keys(readJson<ClaudeConfig>(ctx.config.claudeConfigPath, {})?.mcpServers ?? {}),
  );

  const out: Gap[] = [];
  for (const script of allMcp) {
    const name = script.replace(/\.mjs$/, "");
    const missing: string[] = [];
    if (!codexNames.has(name)) missing.push(ctx.config.codexConfigPath);
    if (!openclawNames.has(name)) missing.push(ctx.config.openclawConfigPath);
    if (!claudeNames.has(name)) missing.push(ctx.config.claudeConfigPath);
    if (missing.length === 0) continue;
    const fp = fingerprint("mcpgap", `${name}::${[...missing].sort().join(",")}`);
    if (ctx.openFps.has(fp)) continue;
    out.push({
      category: "mcpgap",
      fingerprint: fp,
      title: `Register MCP '${name}' in ${missing.length} missing config(s)`,
      intent: `Register MCP server '${name}' (${join(ctx.config.scriptsDir, script)}) in: ${missing.join(", ")}. Use existing memory-graph entry as template: codex TOML [mcp_servers.<name>] with command="node" args=[abs path]; openclaw + claude use JSON mcpServers/<name>. Restart loaded CLIs after.`,
      // Explicit deliverable: the config files being modified (NOT the .mjs
      // source, which already exists). The validator checks mtime > startedAt
      // on these to confirm the registration landed.
      deliverable: { paths: [...missing] },
    });
  }
  return out;
}

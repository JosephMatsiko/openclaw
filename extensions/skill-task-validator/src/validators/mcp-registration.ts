// validateMcpRegistration — verifies that the MCP server name extracted
// from intent is registered in all 3 CLI registries (codex, openclaw, claude).

import { readFileSync } from "node:fs";
import type { Validator } from "../types.js";

interface OpenclawConfig {
  mcp?: { servers?: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
}

export const validateMcpRegistration: Validator = (task, config) => {
  const intent = String(task?.intent ?? "");
  const m = intent.match(
    /(?:register|wire)\s+(?:MCP\s+)?["']?([\w][\w-]+)["']?\s+(?:in|across|to)/i,
  );
  if (!m) {
    return {
      valid: true,
      reason: "no MCP name inferred from intent; trusting exit code",
      category: "no-name-inferred",
      evidence: {},
    };
  }
  const name = m[1];
  let codexHas = false;
  let openclawHas = false;
  let claudeHas = false;
  try {
    codexHas = readFileSync(config.codexConfigPath, "utf8").includes(`[mcp_servers.${name}]`);
  } catch {
    /* missing config */
  }
  try {
    const oc = JSON.parse(readFileSync(config.openclawConfigPath, "utf8")) as OpenclawConfig;
    openclawHas = Boolean(oc?.mcp?.servers?.[name] ?? oc?.mcpServers?.[name]);
  } catch {
    /* missing config */
  }
  try {
    const cc = JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as ClaudeConfig;
    claudeHas = Boolean(cc?.mcpServers?.[name]);
  } catch {
    /* missing config */
  }
  const count = (codexHas ? 1 : 0) + (openclawHas ? 1 : 0) + (claudeHas ? 1 : 0);
  if (count === 3) {
    return {
      valid: true,
      reason: `MCP '${name}' registered in 3/3 configs`,
      category: "fully-registered",
      evidence: { name, codex: codexHas, openclaw: openclawHas, claude: claudeHas },
    };
  }
  return {
    valid: false,
    reason: `MCP '${name}' registered in ${count}/3 configs (codex:${codexHas} openclaw:${openclawHas} claude:${claudeHas})`,
    category: "partial-registration",
    evidence: { name, codex: codexHas, openclaw: openclawHas, claude: claudeHas },
  };
};

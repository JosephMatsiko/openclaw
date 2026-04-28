// Layer-7 execution gate (Phase 4).
//
// Plugin-owned `before_tool_call` hook that enforces Joseph's SOUL
// critical-action boundary as an actual runtime gate (not just a
// description hint in the tool's docstring). Driven by the plugin's
// `executionMode` config:
//
//   autonomous → log and pass through (current default, zero friction)
//   assisted   → requireApproval — surfaces an approval prompt via
//                OpenClaw's approval subsystem; caller awaits resolution
//   suggest    → block outright with a reason; the calling LLM receives
//                a tool error and typically pivots to "here's what I'd do"
//
// Critical-action tool set kept in code so it's reviewable + testable.
// Starts narrow (tools this plugin owns, plus common dangerous shapes).
// Extend the list when a new critical tool lands — do not gate broad
// surfaces by regex; be explicit.
//
// Firing scope: the `before_tool_call` hook fires on tool calls that flow
// through OpenClaw's MCP/tool dispatch. It does NOT fire for tools the
// claude-cli binary runs locally (e.g. Bash, Write, Edit in a Claude Code
// session). For those, the gate is advisory-only at the prompt level.

import type { ExecutionMode } from "./config.js";

// --- Critical action registry ------------------------------------------

// Tools that change operator state in ways worth a gate. Keep this
// explicit (no regexes) so the list is auditable at a glance.
//
// Add to this list when a new critical tool lands anywhere in the stack.
// Tools not in the list are always allowed regardless of execution mode.
export const CRITICAL_TOOL_NAMES: readonly string[] = [
  // memory-graph's own persona writer. Already marked CRITICAL in its
  // MCP tool description; this is the runtime counterpart.
  "memory_set_persona",
  // memory-graph's surgical self-edit — block-level append / replace /
  // upsert on persona files. Same CRITICAL posture as memory_set_persona
  // but finer-grained; agents call this when they want to evolve their
  // own operating instructions mid-turn. Gate on assisted/suggest.
  "memory_self_edit",
  // memory-graph's pruner via memory_forget — deleting memory rows is
  // durable state change. Typically called after memory_search, but
  // worth a gate in suggest/assisted.
  "memory_forget",
  // memory-graph's batch merge — can delete multiple rows in one call.
  "memory_consolidate",
  // memory-graph's bulk ingest — writes many nodes; safe in autonomous,
  // worth confirming in assisted on an install where storage is expensive.
  "memory_ingest_claude_code",
  // apple-toolkit — sends an iMessage from the operator's Apple ID to
  // an arbitrary recipient. Classic prompt-injection-actionable.
  "messages_send",
  // apple-toolkit — writes a new Apple Note. Not destructive but it's a
  // content side effect on a surface that holds prayer requests, pastoral
  // content, and other private writing. Worth a gate by default.
  "notes_create",
  // apple-toolkit — adds a reminder to the operator's list. Not usually
  // destructive but a prompt-driven spam-the-user vector if compromised.
  "reminders_add",
  // apple-toolkit — open a URL in the default browser. Low-severity
  // individually, but can be chained with injected phishing URLs, so
  // gate in assisted mode.
  "open_url",
  // apple-toolkit — open a named .app. Same rationale as open_url.
  "mac_app_open",
];

export function isCriticalTool(toolName: string): boolean {
  return CRITICAL_TOOL_NAMES.includes(toolName);
}

// --- Hook event + result shapes ----------------------------------------

// Mirrors PluginHookBeforeToolCallEvent from openclaw/plugin-sdk — kept
// local so the module stays easy to unit-test without pulling the SDK.
export type ExecutionGateEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

export type ExecutionGateResult =
  | {
      block?: boolean;
      blockReason?: string;
      requireApproval?: {
        title: string;
        description: string;
        severity?: "info" | "warning" | "critical";
        timeoutMs?: number;
        timeoutBehavior?: "allow" | "deny";
        pluginId?: string;
      };
    }
  | undefined;

export type ExecutionGateLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type ExecutionGateOptions = {
  mode: ExecutionMode;
  logger?: ExecutionGateLogger;
  // Override the critical tool list. Pass [] to disable gating entirely
  // for this install (effectively forcing autonomous behavior).
  criticalTools?: readonly string[];
  // Approval timeout when in assisted mode. Default 5min; when the
  // timeout elapses, the policy defaults to `deny` — a user who isn't
  // paying attention shouldn't accidentally green-light a change by
  // ignoring the prompt.
  approvalTimeoutMs?: number;
};

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Pure function so it can be unit-tested without the plugin runtime.
// Returns undefined when the call is allowed through (no mutation).
export function runExecutionGate(
  event: ExecutionGateEvent,
  opts: ExecutionGateOptions,
): ExecutionGateResult {
  const criticalList = opts.criticalTools ?? CRITICAL_TOOL_NAMES;
  const isCritical = criticalList.includes(event.toolName);

  if (opts.mode === "autonomous") {
    // Log-and-pass behavior. Even non-critical tools get an observability
    // trace in autonomous mode so audit-after-the-fact is possible.
    if (isCritical) {
      opts.logger?.info?.(
        `memory-graph execution-gate [autonomous]: allowed critical tool ${event.toolName} (runId=${event.runId ?? "?"})`,
      );
    }
    return undefined;
  }

  if (!isCritical) {
    // Non-critical tools always pass, regardless of mode. The gate's
    // only business is critical-action enforcement.
    return undefined;
  }

  if (opts.mode === "suggest") {
    const reason = `memory-graph is in suggest mode — critical tool "${event.toolName}" is blocked. Describe the action instead, then flip executionMode to "assisted" or "autonomous" if you want it to run.`;
    opts.logger?.warn?.(`memory-graph execution-gate [suggest]: blocked ${event.toolName}`);
    return { block: true, blockReason: reason };
  }

  // mode === "assisted"
  const title = `Approve ${event.toolName}?`;
  const description = buildApprovalDescription(event);
  opts.logger?.info?.(
    `memory-graph execution-gate [assisted]: requesting approval for ${event.toolName}`,
  );
  return {
    requireApproval: {
      title,
      description,
      severity: "critical",
      timeoutMs: opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      timeoutBehavior: "deny",
      pluginId: "memory-graph",
    },
  };
}

function buildApprovalDescription(event: ExecutionGateEvent): string {
  // Show a compact preview of the tool arguments so the reviewer has
  // something to decide on. Truncate long values aggressively — the
  // approval UI is usually a small surface.
  const entries = Object.entries(event.params ?? {});
  if (entries.length === 0) {
    return `Tool \`${event.toolName}\` is about to run with no parameters.`;
  }
  const lines = [`Tool \`${event.toolName}\` is about to run with:`];
  for (const [key, value] of entries) {
    const rendered = renderValueForApproval(value);
    lines.push(`- ${key}: ${rendered}`);
  }
  return lines.join("\n");
}

function renderValueForApproval(value: unknown): string {
  if (value === null || value === undefined) {
    return "<empty>";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length <= 200) {
      return `"${trimmed}"`;
    }
    return `"${trimmed.slice(0, 200)}…" (${trimmed.length} chars total)`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length <= 200 ? json : `${json.slice(0, 200)}… (${json.length} chars total)`;
  } catch {
    return "<unserializable>";
  }
}

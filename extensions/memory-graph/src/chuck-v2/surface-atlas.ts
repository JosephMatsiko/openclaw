import type { CapabilityLedger } from "./capability-ledger.js";
import { DEFAULT_CHUCK_CONFIG, configWithSafeCliScoutSurfaces } from "./config.js";
import type { ChuckConfig, ChuckFamily } from "./types.js";

export type SurfaceAtlasFamily = ChuckFamily | "connector" | "operator-tool" | "platform";
export type SurfaceAtlasCategory =
  | "fleet-surface"
  | "same-family-surface"
  | "tool-surface"
  | "connector"
  | "local-runtime"
  | "future-surface";
export type SurfaceAtlasStatus = "configured" | "planned" | "available-tool" | "provisional";
export type SurfaceControlKind =
  | "button"
  | "toggle"
  | "menu"
  | "selector"
  | "coordinate"
  | "command"
  | "shortcut";
export type SurfaceControlRisk = "low" | "medium" | "high";
export type SurfaceToolKind =
  | "script"
  | "cli"
  | "mcp"
  | "plugin"
  | "connector"
  | "computer-use"
  | "browser-cdp"
  | "accessibility"
  | "ocr";
export type SurfaceFormKind =
  | "cli"
  | "native-mac-app"
  | "browser-tab"
  | "pwa"
  | "browser-or-pwa"
  | "agentic-browser"
  | "connector"
  | "plugin"
  | "mcp"
  | "local-runtime";
export type SurfaceFormRole = "automation-substrate" | "human-continuity" | "both";
export type SurfaceLeaseMode =
  | "none"
  | "cli-ephemeral"
  | "workstation-return"
  | "singleton-incognito-lane"
  | "shared-web-cockpit"
  | "native-app-session";

export type SurfaceControl = {
  id: string;
  label: string;
  kind: SurfaceControlKind;
  action: string;
  selector?: string;
  shortcut?: string;
  coordinate?: string;
  source?: string;
  risk: SurfaceControlRisk;
};

export type SurfaceShortcut = {
  keys: string;
  action: string;
  source?: string;
  caveat?: string;
};

export type SurfaceAbility = {
  id: string;
  label: string;
  bestFor: string;
  authority: "read-only" | "can-draft" | "can-act-with-policy" | "requires-approval";
  notes?: string[];
};

export type SurfaceToolRoute = {
  route: string;
  toolKind: SurfaceToolKind;
  command?: string;
  notes: string[];
};

export type SurfaceForm = {
  kind: SurfaceFormKind;
  role: SurfaceFormRole;
  bestFor: string;
  caveats: string[];
};

export type SurfaceLeasePolicy = {
  mode: SurfaceLeaseMode;
  keepOpenDuringActiveWork: boolean;
  returnRequired: boolean;
  sleepPolicy: string;
  caveats: string[];
};

export type SurfaceAtlasEntry = {
  surface: string;
  family: SurfaceAtlasFamily;
  label: string;
  category: SurfaceAtlasCategory;
  status: SurfaceAtlasStatus;
  preferredDriver: SurfaceToolKind;
  primaryScript?: string;
  launchHint: string;
  forms?: SurfaceForm[];
  controls: SurfaceControl[];
  shortcuts: SurfaceShortcut[];
  abilities: SurfaceAbility[];
  toolRoutes: SurfaceToolRoute[];
  leasePolicy: SurfaceLeasePolicy;
  knownIssues: string[];
  masteryGaps: string[];
  notes: string[];
};

export type SurfaceAtlasSummary = {
  generatedAt: string;
  totalSurfaces: number;
  configuredSurfaces: number;
  availableToolSurfaces: number;
  plannedSurfaces: number;
  families: SurfaceAtlasFamily[];
  fleetFamilies: ChuckFamily[];
  controls: number;
  shortcuts: number;
  abilities: number;
  returnRequired: number;
  keepOpenDuringActiveWork: number;
  entries: SurfaceAtlasEntry[];
  masteryGaps: Array<{ surface: string; gaps: string[] }>;
};

const NO_LEASE: SurfaceLeasePolicy = {
  mode: "none",
  keepOpenDuringActiveWork: false,
  returnRequired: false,
  sleepPolicy: "No window lifecycle; run on demand.",
  caveats: [],
};

const CLI_LEASE: SurfaceLeasePolicy = {
  mode: "cli-ephemeral",
  keepOpenDuringActiveWork: false,
  returnRequired: false,
  sleepPolicy: "CLI runs end with their process; preserve transcripts and receipts.",
  caveats: ["CLI auth state must remain subscription-backed or operator-approved."],
};

const WEB_COCKPIT_LEASE: SurfaceLeasePolicy = {
  mode: "shared-web-cockpit",
  keepOpenDuringActiveWork: true,
  returnRequired: true,
  sleepPolicy:
    "Reuse the shared browser cockpit while work is active; close/sleep only when no active run needs continuity.",
  caveats: [
    "Same-family web surfaces are intra-family signal only and never add independent family votes.",
  ],
};

const APP_LEASE: SurfaceLeasePolicy = {
  mode: "native-app-session",
  keepOpenDuringActiveWork: true,
  returnRequired: true,
  sleepPolicy:
    "Keep one stable app window during active work and return focus to Codex after every excursion.",
  caveats: ["GUI receipts must include workstation return proof."],
};

const PERPLEXITY_LEASE: SurfaceLeasePolicy = {
  mode: "singleton-incognito-lane",
  keepOpenDuringActiveWork: true,
  returnRequired: true,
  sleepPolicy:
    "Incognito work uses one active ephemeral lane; keep it open for active work, reuse it for deepening, and close/sleep only after completion, expiry, or operator close.",
  caveats: [
    "Shared-account invariant: Chuck uses Incognito.",
    "Do not create arbitrary parallel Incognito threads; navigate/reset the singleton lane intentionally.",
  ],
};

const BASE_ATLAS: SurfaceAtlasEntry[] = [
  {
    surface: "claude-cli/exec",
    family: "anthropic",
    label: "Claude CLI / Claude Code",
    category: "fleet-surface",
    status: "configured",
    preferredDriver: "cli",
    primaryScript: "extensions/memory-graph/scripts/research-claude.mjs",
    launchHint: "claude CLI in subscription auth context",
    forms: [
      form(
        "cli",
        "automation-substrate",
        "repeatable stdout/stderr receipts and repo-safe execution",
      ),
    ],
    controls: [
      control(
        "claude-cli-command",
        "CLI prompt execution",
        "command",
        "Spawn Claude CLI with prompt and transcript capture.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "repo-reasoning",
        "Repo-grounded reasoning",
        "codebase planning, critique, and high-context implementation advice",
        "can-draft",
      ),
      ability(
        "vision-helper",
        "Vision helper",
        "local screenshots/OCR fallback when a GUI surface needs interpretation",
        "read-only",
      ),
    ],
    toolRoutes: [
      route("claude-cli", "cli", "claude", ["Subscription-backed CLI surface; no PAYG core path."]),
    ],
    leasePolicy: CLI_LEASE,
    knownIssues: ["Must not count twice if Claude web/Mac also answer."],
    masteryGaps: [],
    notes: ["Primary Anthropic family path when available."],
  },
  {
    surface: "claude/web-chat",
    family: "anthropic",
    label: "Claude web",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-claude-ai-chat.mjs",
    launchHint: "Shared browser cockpit at claude.ai",
    forms: [
      form("browser-tab", "automation-substrate", "CDP/DOM extraction and selector proof"),
      form(
        "pwa",
        "human-continuity",
        "less tab clutter when a stable app-shell session is useful",
        ["same Anthropic family signal; does not add a family vote"],
      ),
    ],
    controls: [
      control("claude-model-menu", "Model menu", "selector", "Read or change Claude model.", {
        selector: '[data-testid*="model"], button[aria-haspopup="menu"]',
      }),
      control("claude-send", "Send message", "button", "Submit the current prompt.", {
        selector:
          'button[aria-label="Send message"], button[aria-label*="Send" i], button[data-testid*="send"], button[type="submit"]',
      }),
      control("claude-stop", "Stop generation", "button", "Detect or stop streaming generation.", {
        selector: 'button[aria-label*="Stop" i]',
      }),
    ],
    shortcuts: [shortcut("Enter", "Fallback submit when the send button is not clickable.")],
    abilities: [
      ability(
        "chat-analysis",
        "Chat analysis",
        "general Anthropic reasoning via web session",
        "can-draft",
      ),
      ability(
        "cross-surface-check",
        "Cross-surface check",
        "compare Claude web with CLI/Mac when behavior diverges",
        "read-only",
      ),
    ],
    toolRoutes: [
      route(
        "research-claude-ai-chat",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-claude-ai-chat.mjs",
        ["Browser surface driver."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: [
      "Selectors rotate; use Accessibility/Computer Use fallback if CDP selectors fail.",
    ],
    masteryGaps: ["Record exact live model picker variants after next successful proof."],
    notes: ["Same Anthropic family signal only."],
  },
  {
    surface: "claude/mac-app",
    family: "anthropic",
    label: "Claude Mac app",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "computer-use",
    primaryScript: "extensions/memory-graph/scripts/research-claude-mac.mjs",
    launchHint: "Claude Desktop app with explicit mode metadata: chat, cowork, code",
    forms: [
      form(
        "native-mac-app",
        "both",
        "mode-specific Claude chat/cowork/code surface when GUI proof is healthy",
      ),
    ],
    controls: [
      control(
        "claude-mode-chat",
        "Chat mode",
        "button",
        "Select chat mode before general reasoning.",
        { risk: "low" },
      ),
      control(
        "claude-mode-cowork",
        "Cowork mode",
        "button",
        "Select cowork mode for collaborative planning.",
        { risk: "low" },
      ),
      control("claude-mode-code", "Code mode", "button", "Select code mode for repo/code work.", {
        risk: "low",
      }),
      control("claude-send-app", "Send", "button", "Send prompt through the native app composer.", {
        risk: "low",
      }),
    ],
    shortcuts: [
      shortcut("Command+N", "New conversation when the app supports it."),
      shortcut("Command+V", "Paste prompt after preserving clipboard."),
    ],
    abilities: [
      ability(
        "native-claude",
        "Native Anthropic session",
        "Mac-app fallback and mode-specific Claude behavior",
        "can-draft",
      ),
      ability(
        "cowork-code-toggle",
        "Mode divergence",
        "compare chat, cowork, and code outputs within Anthropic",
        "read-only",
      ),
    ],
    toolRoutes: [
      route(
        "claude-mac-driver",
        "computer-use",
        "node extensions/memory-graph/scripts/research-claude-mac.mjs",
        ["Native app driver with screenshot/vision polling."],
      ),
    ],
    leasePolicy: APP_LEASE,
    knownIssues: ["Mode controls need live selector/coordinate proof after UI changes."],
    masteryGaps: ["Add exact coordinates/selectors for chat/cowork/code/design toggles."],
    notes: ["Same Anthropic family; useful child surface, not another family."],
  },
  {
    surface: "claude/design",
    family: "anthropic",
    label: "Claude Design",
    category: "future-surface",
    status: "planned",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-claude-design.mjs",
    launchHint: "claude.ai/design once installed/enabled",
    forms: [
      form("browser-or-pwa", "both", "design-specific Anthropic surface once enabled and proven"),
    ],
    controls: [
      control("claude-design-new", "New design", "button", "Start a new design project.", {
        selector:
          '[data-testid*="new-design"], button[aria-label*="new design" i], button/a text: new design/create design',
      }),
      control("claude-design-send", "Generate/send", "button", "Submit design prompt.", {
        selector:
          'button[aria-label*="generate" i], button[aria-label*="send" i], button[data-testid*="generate"], button[type="submit"]',
      }),
      control("claude-design-export", "Export/download", "button", "Export rendered design.", {
        selector:
          '[data-testid*="export"], button[aria-label*="export" i], button[data-testid*="download"], button[aria-label*="download" i]',
      }),
    ],
    shortcuts: [shortcut("Enter", "Fallback submit if generate button is not detected.")],
    abilities: [
      ability(
        "ui-design",
        "UI design surface",
        "design ideation and exportable artifacts",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "claude-design-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-claude-design.mjs",
        ["Planned Claude design surface driver."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: ["Design product is new; selectors are intentionally layered and need proof."],
    masteryGaps: ["Install/enable Claude Design and record repeatable proof."],
    notes: ["Same Anthropic family."],
  },
  {
    surface: "chatgpt/web-chat",
    family: "openai",
    label: "ChatGPT web",
    category: "fleet-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-chatgpt-chat.mjs",
    launchHint: "Shared browser cockpit at chatgpt.com",
    forms: [
      form(
        "browser-tab",
        "automation-substrate",
        "CDP/DOM extraction and repeatable text receipts",
      ),
      form("pwa", "human-continuity", "stable OpenAI chat shell with less tab clutter", [
        "use only if proof quality matches or exceeds browser-tab route",
      ]),
    ],
    controls: [
      control(
        "chatgpt-model-switcher",
        "Model switcher",
        "selector",
        "Read or change ChatGPT model.",
        {
          selector: '[data-testid="model-switcher-dropdown-button"], button[aria-haspopup="menu"]',
        },
      ),
      control(
        "chatgpt-thinking-toggle",
        "Thinking/reasoning",
        "toggle",
        "Enable deeper reasoning when the control exists.",
        {
          selector:
            '[data-testid="thinking-mode-toggle"], [data-testid="composer-thinking-toggle"], button[aria-label*="Thinking" i], button[aria-label*="Reasoning" i]',
        },
      ),
      control("chatgpt-send", "Send", "button", "Submit prompt.", {
        selector: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
      }),
      control("chatgpt-stop", "Stop", "button", "Detect streaming or stop response.", {
        selector: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]',
      }),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "openai-chat",
        "OpenAI chat reasoning",
        "general reasoning and tasks Codex cannot expose through repo-only CLI",
        "can-draft",
      ),
      ability(
        "model-mode-selection",
        "Model/mode selection",
        "select model or thinking mode when available",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route(
        "chatgpt-web-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-chatgpt-chat.mjs",
        ["Browser driver; no PAYG core API."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: ["Must be hardened because ChatGPT web covers things Codex CLI cannot."],
    masteryGaps: ["Repair/prove ChatGPT web driver after latest login/session changes."],
    notes: ["Primary OpenAI chat surface when available."],
  },
  {
    // ChatGPT.app native Mac client. Confirmed by codex 2026-04-28:
    // OpenAI distributes ChatGPT desktop separately at
    // openai.com/chatgpt/desktop (direct download, not App Store; macOS 14+,
    // Apple Silicon). Distinct from Codex.app (com.openai.codex). Surface
    // promotable to load-bearing once the app is installed and the
    // research-chatgpt-mac.mjs driver can probe its accessibility tree.
    surface: "chatgpt/mac-app",
    family: "openai",
    label: "ChatGPT Mac app",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "computer-use",
    primaryScript: "extensions/memory-graph/scripts/research-chatgpt-mac.mjs",
    launchHint:
      "Install ChatGPT.app from https://openai.com/chatgpt/desktop (macOS 14+ Apple Silicon). Native OpenAI client distinct from Codex.app.",
    forms: [
      form(
        "native-mac-app",
        "both",
        "native OpenAI features, attachments, voice/desktop affordances, and app continuity",
        ["requires answer-attribution proof before load-bearing high-stakes use"],
      ),
    ],
    controls: [
      control("chatgpt-mac-new", "New chat", "shortcut", "Create a new native app conversation.", {
        shortcut: "Command+N",
      }),
      control(
        "chatgpt-mac-thinking",
        "Thinking toggle",
        "coordinate",
        "Toggle deeper thinking mode when visible.",
        { coordinate: "driver COORDS.thinkingToggle" },
      ),
      control("chatgpt-mac-composer", "Composer", "coordinate", "Focus bottom composer.", {
        coordinate: "driver COORDS.composerCenter",
      }),
    ],
    shortcuts: [
      shortcut("Command+N", "New chat."),
      shortcut("Command+V", "Paste prompt."),
      shortcut("Return", "Submit prompt."),
    ],
    abilities: [
      ability(
        "native-chatgpt",
        "Native OpenAI session",
        "fallback when web surface or Codex cannot perform a task",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "chatgpt-mac-driver",
        "computer-use",
        "node extensions/memory-graph/scripts/research-chatgpt-mac.mjs",
        ["Native app driver with screenshot/vision polling."],
      ),
    ],
    leasePolicy: APP_LEASE,
    knownIssues: [
      "Coordinate estimates need live verification whenever the window geometry changes.",
    ],
    masteryGaps: ["Record stable app geometry and model/mode controls."],
    notes: ["Same OpenAI family; child/cousin surface only."],
  },
  {
    surface: "codex/exec",
    family: "openai",
    label: "Codex CLI",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "cli",
    primaryScript: "extensions/memory-graph/src/chuck-v2/runner-executor.ts",
    launchHint: "codex exec with repo-grounded context",
    forms: [
      form(
        "cli",
        "automation-substrate",
        "repo-grounded patch/test/review execution with receipts",
      ),
    ],
    controls: [
      control(
        "codex-exec",
        "Codex exec",
        "command",
        "Run repo-grounded Codex CLI task with transcript capture.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "code-implementation",
        "Code implementation",
        "repo-grounded code edits, tests, and reviews",
        "can-act-with-policy",
      ),
      ability(
        "code-review",
        "Code review",
        "findings-first review and patch critique",
        "read-only",
      ),
    ],
    toolRoutes: [
      route("codex-cli", "cli", "codex exec", ["OpenAI family CLI surface; same-family signal."]),
    ],
    leasePolicy: CLI_LEASE,
    knownIssues: ["Subscription/auth tier visibility is opaque from inside this runtime."],
    masteryGaps: [],
    notes: [
      "This Codex session is an OpenAI surface but not an independent extra OpenAI family vote.",
    ],
  },
  {
    surface: "codex-review/exec",
    family: "openai",
    label: "Codex review CLI",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "cli",
    launchHint: "codex exec in review framing",
    forms: [form("cli", "automation-substrate", "review-only OpenAI family signal")],
    controls: [
      control(
        "codex-review-exec",
        "Codex review",
        "command",
        "Run Codex in review/critique mode.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "review-mode",
        "Review mode",
        "bug/risk-focused critique of specs and code",
        "read-only",
      ),
    ],
    toolRoutes: [
      route("codex-review-cli", "cli", "codex exec", ["OpenAI same-family review signal."]),
    ],
    leasePolicy: CLI_LEASE,
    knownIssues: [],
    masteryGaps: [],
    notes: ["Same-family child surface."],
  },
  {
    surface: "gemini/cli",
    family: "google",
    label: "Gemini CLI",
    category: "fleet-surface",
    status: "configured",
    preferredDriver: "cli",
    primaryScript: "extensions/memory-graph/scripts/research-gemini.mjs",
    launchHint: "Gemini CLI oauth-personal mode",
    forms: [form("cli", "automation-substrate", "Google-family stdout/stderr receipts")],
    controls: [
      control(
        "gemini-cli-command",
        "Gemini CLI",
        "command",
        "Run Gemini CLI prompt and capture receipt.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "google-reasoning",
        "Google reasoning",
        "Google-family critique and alternative assumptions",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route("gemini-cli", "cli", "gemini", [
        "Subscription/consumer auth preferred; no PAYG core dependency.",
      ]),
    ],
    leasePolicy: CLI_LEASE,
    knownIssues: ["CLI quota/auth can diverge from browser Gemini Pro access."],
    masteryGaps: ["Persist quota health as first-class route signal."],
    notes: ["Primary Google family path when healthy."],
  },
  {
    surface: "gemini/web-chat",
    family: "google",
    label: "Gemini web / PWA",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-gemini-chat.mjs",
    launchHint: "gemini.google.com or Gemini PWA",
    forms: [
      form(
        "browser-tab",
        "automation-substrate",
        "CDP/DOM extraction when selector proof is needed",
      ),
      form("pwa", "human-continuity", "dedicated Gemini app-shell continuity without tab clutter"),
    ],
    controls: [
      control("gemini-send", "Send", "button", "Submit Gemini prompt.", {
        selector:
          'button.send-button, button[aria-label*="Send" i], button[aria-label*="Submit" i]',
      }),
      control("gemini-stop", "Stop", "button", "Detect streaming.", {
        selector: 'button[aria-label*="Stop" i], button.stop-button',
      }),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "google-web-pro",
        "Google consumer Pro signal",
        "Google-family reasoning when browser Pro access is stronger than CLI access",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "gemini-web-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-gemini-chat.mjs",
        ["Browser/PWA driver."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: [
      "Consumer Pro entitlement must be proven by successful receipt, not inferred from AI Studio free-tier DOM.",
    ],
    masteryGaps: ["Add stable model selector capture for Gemini Pro/Advanced."],
    notes: ["Same Google family."],
  },
  {
    surface: "aistudio/web",
    family: "google",
    label: "Google AI Studio",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-aistudio-chat.mjs",
    launchHint: "AI Studio web or PWA; Run button is primary submit control",
    forms: [
      form(
        "browser-tab",
        "automation-substrate",
        "Run-button proof, model selector reading, and DOM extraction",
      ),
      form(
        "pwa",
        "human-continuity",
        "dedicated AI Studio shell when long sessions need continuity",
      ),
    ],
    controls: [
      control("aistudio-run", "Run", "button", "Submit prompt; this surface uses Run, not Send.", {
        selector:
          "button.ctrl-enter-submits, .ctrl-enter-submits button, run-button button, real Run button text",
      }),
      control(
        "aistudio-model",
        "Model selector",
        "selector",
        "Read selected model and Pro indicators.",
        {
          selector: 'ms-model-selector-two button, button[aria-label*="model" i]',
        },
      ),
      control("aistudio-stop", "Stop/running", "button", "Detect running generation.", {
        selector: '[aria-label*="Running" i], button[aria-label*="Stop" i]',
      }),
    ],
    shortcuts: [
      shortcut("Command+Enter", "Primary run shortcut on Mac."),
      shortcut("Control+Enter", "Fallback run shortcut."),
    ],
    abilities: [
      ability(
        "developer-studio",
        "Google developer studio",
        "developer-style prompts, model selection, and Google-family surface divergence",
        "can-draft",
      ),
      ability(
        "image-mode",
        "Image generation mode",
        "AI Studio image/media mode through separate driver",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "aistudio-chat-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-aistudio-chat.mjs",
        ["Run-button chat driver."],
      ),
      route(
        "aistudio-image-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-aistudio-image.mjs",
        ["Image/media mode driver."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: [
      "Entitlement is visible caveat unless model selector or successful receipt proves Pro.",
    ],
    masteryGaps: ["Promote PWA/web path with repeatable Run-button proof and entitlement proof."],
    notes: ["Same Google family; useful child surface, not extra vote."],
  },
  {
    surface: "perplexity/mac-app",
    family: "perplexity",
    label: "Perplexity Mac app",
    category: "fleet-surface",
    status: "configured",
    preferredDriver: "computer-use",
    primaryScript: "extensions/memory-graph/scripts/research-perplexity-mac.mjs",
    launchHint: "Perplexity native Mac app, fullscreen preferred, Incognito singleton lane",
    forms: [
      form(
        "native-mac-app",
        "both",
        "shared Max-seat Incognito lane with source-heavy research continuity",
        ["single active lane policy; reuse during active work instead of closing after each run"],
      ),
    ],
    controls: [
      control(
        "perplexity-sidebar-toggle",
        "Sidebar / tab toggle",
        "coordinate",
        "Open thread/sidebar rail.",
        {
          coordinate: "22/1470,60/956",
          source: "research-perplexity-mac.mjs COORDS.sidebarToggle",
        },
      ),
      control("perplexity-back", "Thread back", "coordinate", "Return to home/new composer.", {
        coordinate: "356/1470,61/956",
        source: "research-perplexity-mac.mjs COORDS.backButton",
      }),
      control(
        "perplexity-settings-gear",
        "Settings gear",
        "coordinate",
        "Open account/settings panel.",
        {
          coordinate: "296/1470,917/956",
          source: "research-perplexity-mac.mjs COORDS.sidebarGear",
        },
      ),
      control(
        "perplexity-incognito",
        "Incognito Mode",
        "toggle",
        "Verify and enable Incognito before shared-account work.",
        {
          coordinate: "922/1470,398/956",
          source: "pixel/OCR verified settings toggle",
          risk: "medium",
        },
      ),
      control(
        "perplexity-mode-search",
        "Search mode",
        "coordinate",
        "Use search mode for ordinary source-grounded work.",
        {
          coordinate: "485/1470,915/956",
        },
      ),
      control(
        "perplexity-mode-research",
        "Research mode",
        "coordinate",
        "Use research mode when depth/source breadth is needed.",
        {
          coordinate: "526/1470,915/956",
        },
      ),
      control(
        "perplexity-mode-labs",
        "Labs mode",
        "coordinate",
        "Use Labs/create mode only when requested.",
        {
          coordinate: "563/1470,915/956",
        },
      ),
      control("perplexity-send", "Send", "coordinate", "Submit prompt.", {
        coordinate: "1310/1470,915/956",
      }),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "live-sources",
        "Live/source-heavy research",
        "current sourced research and citations",
        "can-draft",
      ),
      ability(
        "deepen-context",
        "Context-preserving deepen",
        "reuse active Incognito lane for follow-up/deepening",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route(
        "perplexity-mac-driver",
        "computer-use",
        "node extensions/memory-graph/scripts/research-perplexity-mac.mjs --thread-policy auto",
        ["Singleton Incognito lane with workstation return."],
      ),
      route("local-ocr-first", "ocr", "apex-ocr / macOS screenshot OCR", [
        "Local Accessibility/OCR before external vision.",
      ]),
    ],
    leasePolicy: PERPLEXITY_LEASE,
    knownIssues: [
      "Reply extractor can fail even when a visible answer exists; OCR capture is fallback proof until extractor is repaired.",
    ],
    masteryGaps: [
      "Repair answer extraction so visible Perplexity replies become structured receipts automatically.",
    ],
    notes: ["Perplexity stays one family and is strongest for evidence-rich/live research."],
  },
  {
    surface: "perplexity/web",
    family: "perplexity",
    label: "Perplexity web",
    category: "same-family-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    primaryScript: "extensions/memory-graph/scripts/research-perplexity-chat.mjs",
    launchHint: "perplexity.ai in shared browser cockpit",
    forms: [
      form("browser-tab", "automation-substrate", "DOM/citation extraction fallback"),
      form("pwa", "human-continuity", "dedicated Perplexity shell if operator later approves it"),
    ],
    controls: [
      control("perplexity-web-send", "Submit", "button", "Submit prompt.", {
        selector:
          'button[aria-label*="Submit" i], button[data-testid*="submit"], button[type="submit"], send/submit/ask button',
      }),
      control("perplexity-web-stop", "Stop", "button", "Detect streaming.", {
        selector: 'button[aria-label*="Stop" i], button[data-testid*="stop"]',
      }),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "perplexity-web-source",
        "Perplexity web research",
        "browser fallback for source-grounded research",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "perplexity-web-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-perplexity-chat.mjs",
        ["Browser fallback; same family."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: ["User says this is not the shared Max path; ignore as load-bearing Max for now."],
    masteryGaps: [
      "Keep separate from Max Mac-app shared account protocol unless operator changes policy.",
    ],
    notes: ["Same Perplexity family; not privileged over Mac Max route."],
  },
  {
    surface: "perplexity/comet",
    family: "perplexity",
    label: "Perplexity Comet / browser controls",
    category: "future-surface",
    status: "planned",
    preferredDriver: "browser-cdp",
    launchHint: "Comet/browser automation candidate",
    forms: [
      form(
        "agentic-browser",
        "both",
        "Perplexity-owned browser/computer-use surface once admitted",
      ),
    ],
    controls: [],
    shortcuts: [],
    abilities: [
      ability(
        "browser-agent",
        "Browser agent controls",
        "browser-native research and web task execution once admitted",
        "requires-approval",
      ),
    ],
    toolRoutes: [
      route("future-comet-driver", "browser-cdp", undefined, [
        "Candidate surface; requires proof before load-bearing use.",
      ]),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: ["No current repeatable runner proof in Chuck."],
    masteryGaps: ["Onboard as candidate, prove auth/session, then calibrate."],
    notes: ["Important harvested primitive, not current canon dependency."],
  },
  {
    surface: "grok/web-or-app",
    family: "xai",
    label: "Grok / xAI",
    category: "fleet-surface",
    status: "configured",
    preferredDriver: "browser-cdp",
    launchHint: "Grok web/app when logged in",
    forms: [
      form("browser-tab", "automation-substrate", "CDP proof against grok.com or X/Grok web"),
      form("pwa", "human-continuity", "X/Grok app-shell continuity for live-social context"),
    ],
    controls: [
      control(
        "grok-submit",
        "Submit",
        "button",
        "Submit Grok prompt once driver selectors are proven.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "x-social-current",
        "X/Twitter-native current signal",
        "fast-moving social/current-event context",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route(
        "grok-web-driver",
        "browser-cdp",
        "node extensions/memory-graph/scripts/research-grok-chat.mjs",
        ["Candidate xAI driver path."],
      ),
    ],
    leasePolicy: WEB_COCKPIT_LEASE,
    knownIssues: [
      "Candidate until runner attribution and subscription/app access are repeatably proven.",
    ],
    masteryGaps: ["Implement/prove driver, then calibrate by task class."],
    notes: ["xAI can be a full family only after proof/calibration."],
  },
  {
    surface: "ollama/localhost",
    family: "sovereign-local",
    label: "Local model runtime",
    category: "local-runtime",
    status: "configured",
    preferredDriver: "cli",
    launchHint: "local model runtime if installed and intentionally enabled",
    controls: [
      control(
        "local-model-command",
        "Local prompt",
        "command",
        "Run selected local model against a bounded prompt.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "sovereignty-floor",
        "Sovereignty floor",
        "local dissent, privacy-preserving rough drafts, offline checks",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route("local-model-runner", "cli", "ollama run <model>", [
        "May be disabled/uninstalled by operator; alternatives can be evaluated.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: [
      "Local model quality varies heavily; weird outputs are calibration signal, not doctrine.",
    ],
    masteryGaps: ["Evaluate replacement local model candidates before promotion."],
    notes: ["Flag-not-vote on complex frontier reasoning unless calibrated otherwise."],
  },
  {
    surface: "openclaw/channels",
    family: "platform",
    label: "OpenClaw channels and tools",
    category: "tool-surface",
    status: "available-tool",
    preferredDriver: "plugin",
    launchHint: "OpenClaw plugin SDK, gateway, channels, tools, skills",
    controls: [
      control(
        "openclaw-command",
        "/chuck command",
        "command",
        "Invoke Chuck from OpenClaw channel surfaces.",
        { risk: "low" },
      ),
      control(
        "openclaw-tools",
        "OpenClaw tools",
        "command",
        "Use OpenClaw as hands/channels under Chuck policy.",
        { risk: "medium" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "channel-body",
        "Channel body",
        "Telegram/WhatsApp/Slack-style command surface and tool chassis",
        "can-act-with-policy",
      ),
      ability(
        "skill-firehose",
        "Skill firehose",
        "ClawHub/skills only after quarantine",
        "requires-approval",
      ),
    ],
    toolRoutes: [
      route("openclaw-plugin-sdk", "plugin", "openclaw/plugin-sdk/*", [
        "No Chuck behavior in OpenClaw core src/**.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: ["Skills/plugins need sandbox quarantine before trust."],
    masteryGaps: ["Finish durable command registration proof in the live OpenClaw app."],
    notes: ["OpenClaw is the body/channels; Chuck is the governor."],
  },
  {
    surface: "codex/computer-use",
    family: "operator-tool",
    label: "Codex Computer Use",
    category: "tool-surface",
    status: "available-tool",
    preferredDriver: "computer-use",
    launchHint: "Desktop control through Codex app when GUI driving is needed",
    controls: [
      control(
        "desktop-click",
        "Click/type/inspect",
        "command",
        "Drive desktop apps when script drivers are not enough.",
        { risk: "medium" },
      ),
      control(
        "workstation-return",
        "Return to Codex",
        "command",
        "Restore the workstation after external app work.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "gui-escape-hatch",
        "GUI escape hatch",
        "use native apps and arbitrary UI when deterministic drivers fail",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route("computer-use-plugin", "computer-use", undefined, [
        "Use with workstation leases and receipts.",
      ]),
    ],
    leasePolicy: APP_LEASE,
    knownIssues: ["Must never become unlogged external account action."],
    masteryGaps: ["Codify per-app fallback recipes after each manual rescue."],
    notes: ["This is the general-purpose hand, not an evidence source by itself."],
  },
  {
    surface: "codex/plugins-skills",
    family: "operator-tool",
    label: "Codex plugins and skills",
    category: "tool-surface",
    status: "available-tool",
    preferredDriver: "plugin",
    launchHint: "Enabled Codex plugins/skills/MCP tools",
    controls: [
      control(
        "skill-load",
        "Load relevant skill",
        "command",
        "Use the matching skill/plugin for app, web, iOS, GitHub, Gmail, Drive, Calendar, Cloudflare, etc.",
        { risk: "low" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "tool-expansion",
        "Tool expansion",
        "use specialized skills/MCP/connectors instead of brittle UI automation when available",
        "can-act-with-policy",
      ),
      ability(
        "connector-work",
        "Connector work",
        "Gmail, Calendar, Drive, GitHub, Netlify, Render, Stripe, Cloudflare, and document tools",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route("codex-tool-search", "mcp", "tool_search", [
        "Discover deferred tools before falling back to GUI/manual methods.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: [
      "Tool availability is session-specific; dashboard should show current atlas, not pretend permanence.",
    ],
    masteryGaps: ["Add automatic capability discovery snapshot for enabled MCP apps/tools."],
    notes: [
      "Maximize tools first, browser/Computer Use second, model reasoning third for operational tasks.",
    ],
  },
  {
    surface: "github/connector",
    family: "connector",
    label: "GitHub connector / CLI",
    category: "connector",
    status: "available-tool",
    preferredDriver: "connector",
    launchHint: "GitHub connector, gh CLI, and logged-in browser as needed",
    controls: [
      control(
        "github-review",
        "Review repository/PR/branches",
        "command",
        "Inspect remotes, PRs, issues, CI, and branch hygiene.",
        { risk: "medium" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "remote-hygiene",
        "Remote hygiene",
        "clean branches, PRs, issues, and CI once local lanes are clean",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route("github-plugin", "connector", "GitHub plugin / gh CLI", [
        "Prefer connector/CLI over browser UI for durability.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: ["Account identity must be verified before destructive remote cleanup."],
    masteryGaps: ["Record current GitHub identity in hygiene snapshot without exposing secrets."],
    notes: ["Remote cleanup should follow lane cleanup, not upload the storm."],
  },
  {
    surface: "gmail/connector",
    family: "connector",
    label: "Gmail connector",
    category: "connector",
    status: "available-tool",
    preferredDriver: "connector",
    launchHint: "Gmail app connector when email work is requested",
    controls: [
      control(
        "gmail-search",
        "Search/triage Gmail",
        "command",
        "Search, summarize, classify, and draft replies.",
        { risk: "medium" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "mail-memory",
        "Mail context",
        "email triage and operator context, with provenance tags",
        "can-draft",
      ),
    ],
    toolRoutes: [
      route("gmail-plugin", "connector", "Gmail connector", [
        "Connector-first; no arbitrary mailbox UI driving unless needed.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: [
      "User has multiple Gmail accounts; account selection must be explicit in receipts.",
    ],
    masteryGaps: ["Add account-aware operator surface records for both Gmail accounts."],
    notes: ["Private data; cite provenance and minimize payload."],
  },
  {
    surface: "google-calendar/connector",
    family: "connector",
    label: "Google Calendar connector",
    category: "connector",
    status: "available-tool",
    preferredDriver: "connector",
    launchHint: "Calendar connector for scheduling/availability",
    controls: [
      control(
        "calendar-read-write",
        "Calendar actions",
        "command",
        "Read availability, prep meetings, and propose calendar changes.",
        { risk: "medium" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "schedule",
        "Schedule intelligence",
        "briefs, availability, and meeting prep",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route("calendar-plugin", "connector", "Google Calendar connector", [
        "Approval required for disruptive calendar writes.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: ["Voice or phone UI must never bypass approval for calendar writes."],
    masteryGaps: [],
    notes: ["Connector-first surface."],
  },
  {
    surface: "google-drive/connector",
    family: "connector",
    label: "Google Drive / Docs / Sheets / Slides",
    category: "connector",
    status: "available-tool",
    preferredDriver: "connector",
    launchHint: "Drive connector for documents and files",
    controls: [
      control(
        "drive-docs",
        "Drive/Docs operations",
        "command",
        "Search, read, edit, comment, and create Drive artifacts.",
        { risk: "medium" },
      ),
    ],
    shortcuts: [],
    abilities: [
      ability(
        "document-work",
        "Document work",
        "Docs, Sheets, Slides, Drive files and connector exports",
        "can-act-with-policy",
      ),
    ],
    toolRoutes: [
      route("drive-plugin", "connector", "Google Drive connector", [
        "Prefer connector over browser unless visual formatting demands browser proof.",
      ]),
    ],
    leasePolicy: NO_LEASE,
    knownIssues: ["Document edits require scoped receipts and rollback where possible."],
    masteryGaps: [],
    notes: ["Part of the Document Evidence Pipeline source set."],
  },
];

export function surfaceAtlasEntries(
  config: ChuckConfig = configWithSafeCliScoutSurfaces(DEFAULT_CHUCK_CONFIG),
): SurfaceAtlasEntry[] {
  const bySurface = new Map<string, SurfaceAtlasEntry>();
  for (const entry of BASE_ATLAS) {
    bySurface.set(entry.surface, cloneEntry(entry));
  }
  for (const fleetEntry of config.fleet) {
    const existing = bySurface.get(fleetEntry.surface);
    if (existing) {
      existing.family = fleetEntry.family;
      existing.status = "configured";
      existing.notes = uniqueText([...existing.notes, fleetEntry.rationale]);
      continue;
    }
    bySurface.set(fleetEntry.surface, {
      surface: fleetEntry.surface,
      family: fleetEntry.family,
      label: fleetEntry.voice,
      category: "fleet-surface",
      status: "configured",
      preferredDriver: "script",
      launchHint: "Configured Fleet surface; detailed controls not catalogued yet.",
      forms: [form("local-runtime", "automation-substrate", "configured runner adapter")],
      controls: [
        control("surface-runner", "Runner", "command", "Invoke configured runner adapter.", {
          risk: "low",
        }),
      ],
      shortcuts: [],
      abilities: [
        ability(
          "configured-fleet-signal",
          "Configured Fleet signal",
          fleetEntry.capabilityProfile,
          "can-draft",
        ),
      ],
      toolRoutes: [route("configured-runner", "script", undefined, [fleetEntry.rationale])],
      leasePolicy: NO_LEASE,
      knownIssues: [],
      masteryGaps: ["Add exact controls, driver path, and proof receipts to Surface Atlas."],
      notes: [fleetEntry.rationale],
    });
  }
  return [...bySurface.values()].toSorted((a, b) =>
    surfaceSortKey(a).localeCompare(surfaceSortKey(b)),
  );
}

export function surfaceAtlasEntry(
  surface: string,
  config?: ChuckConfig,
): SurfaceAtlasEntry | undefined {
  return surfaceAtlasEntries(config).find((entry) => entry.surface === surface);
}

export function surfaceAtlasSummary({
  config = configWithSafeCliScoutSurfaces(DEFAULT_CHUCK_CONFIG),
  generatedAt = new Date().toISOString(),
}: {
  config?: ChuckConfig;
  generatedAt?: string;
} = {}): SurfaceAtlasSummary {
  const entries = surfaceAtlasEntries(config);
  const families = uniqueText(entries.map((entry) => entry.family));
  const fleetFamilies = uniqueText(
    entries
      .filter(
        (entry) =>
          entry.category === "fleet-surface" ||
          entry.category === "same-family-surface" ||
          entry.category === "local-runtime",
      )
      .map((entry) => entry.family)
      .filter((family): family is ChuckFamily => isChuckFamily(family)),
  );
  return {
    generatedAt,
    totalSurfaces: entries.length,
    configuredSurfaces: entries.filter((entry) => entry.status === "configured").length,
    availableToolSurfaces: entries.filter((entry) => entry.status === "available-tool").length,
    plannedSurfaces: entries.filter((entry) => entry.status === "planned").length,
    families,
    fleetFamilies,
    controls: entries.reduce((sum, entry) => sum + entry.controls.length, 0),
    shortcuts: entries.reduce((sum, entry) => sum + entry.shortcuts.length, 0),
    abilities: entries.reduce((sum, entry) => sum + entry.abilities.length, 0),
    returnRequired: entries.filter((entry) => entry.leasePolicy.returnRequired).length,
    keepOpenDuringActiveWork: entries.filter((entry) => entry.leasePolicy.keepOpenDuringActiveWork)
      .length,
    entries,
    masteryGaps: entries
      .filter((entry) => entry.masteryGaps.length > 0)
      .map((entry) => ({ surface: entry.surface, gaps: entry.masteryGaps })),
  };
}

export function formatSurfaceAtlasReport(
  summary: SurfaceAtlasSummary = surfaceAtlasSummary(),
  { surface, ledger }: { surface?: string; ledger?: CapabilityLedger } = {},
): string {
  const entries = surface
    ? summary.entries.filter((entry) => entry.surface === surface)
    : summary.entries;
  if (surface && entries.length === 0) {
    return `Chuck Surface Atlas\nNo atlas entry found for ${surface}. Use /chuck onboard candidate <family-or-product> ${surface} to docket it.`;
  }
  const lines = [
    "Chuck Surface Atlas",
    `Surfaces: ${summary.totalSurfaces} total; ${summary.configuredSurfaces} configured; ${summary.availableToolSurfaces} tools/connectors; ${summary.plannedSurfaces} planned.`,
    `Families/tools: ${summary.families.join(", ")}`,
    `Controls: ${summary.controls}; shortcuts: ${summary.shortcuts}; abilities: ${summary.abilities}; return-required surfaces: ${summary.returnRequired}.`,
    "",
  ];
  for (const entry of entries) {
    const ledgerEntry = ledger?.entries.find((candidate) => candidate.surface === entry.surface);
    const controls =
      entry.controls
        .slice(0, 5)
        .map((controlItem) => `${controlItem.label} (${controlItem.kind})`)
        .join(", ") || "none";
    const shortcuts =
      entry.shortcuts
        .map((shortcutItem) => `${shortcutItem.keys}: ${shortcutItem.action}`)
        .join("; ") || "none";
    const abilities = entry.abilities.map((abilityItem) => abilityItem.label).join(", ") || "none";
    const forms =
      entry.forms?.map((surfaceForm) => `${surfaceForm.kind}/${surfaceForm.role}`).join(", ") ||
      "not catalogued";
    lines.push(
      ...[
        `- ${entry.family} · ${entry.surface} · ${entry.status}`,
        `  label: ${entry.label}`,
        `  driver: ${entry.preferredDriver}${entry.primaryScript ? ` · ${entry.primaryScript}` : ""}`,
        `  forms: ${forms}`,
        `  lease: ${entry.leasePolicy.mode}; keep-open=${entry.leasePolicy.keepOpenDuringActiveWork ? "yes" : "no"}; return=${entry.leasePolicy.returnRequired ? "yes" : "no"}`,
        ledgerEntry
          ? `  readiness: ${ledgerEntry.readiness}${ledgerEntry.countsAsIndependentFamily ? " · family-count" : ""}; prompt=${ledgerEntry.promptDeliveryProof.verdict}; answer=${ledgerEntry.answerAttributionProof.verdict}`
          : undefined,
        `  controls: ${controls}`,
        `  shortcuts: ${shortcuts}`,
        `  abilities: ${abilities}`,
      ].filter((line): line is string => Boolean(line)),
    );
    if (entry.masteryGaps.length > 0) {
      lines.push(`  gaps: ${entry.masteryGaps.join("; ")}`);
    }
  }
  if (!surface && summary.masteryGaps.length > 0) {
    lines.push("", "Mastery gaps:");
    for (const gap of summary.masteryGaps.slice(0, 10)) {
      lines.push(`- ${gap.surface}: ${gap.gaps.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function control(
  id: string,
  label: string,
  kind: SurfaceControlKind,
  action: string,
  opts: Partial<Omit<SurfaceControl, "id" | "label" | "kind" | "action">> = {},
): SurfaceControl {
  return {
    id,
    label,
    kind,
    action,
    risk: opts.risk ?? "low",
    selector: opts.selector,
    shortcut: opts.shortcut,
    coordinate: opts.coordinate,
    source: opts.source,
  };
}

function shortcut(keys: string, action: string, caveat?: string): SurfaceShortcut {
  return { keys, action, caveat };
}

function ability(
  id: string,
  label: string,
  bestFor: string,
  authority: SurfaceAbility["authority"],
  notes: string[] = [],
): SurfaceAbility {
  return { id, label, bestFor, authority, notes };
}

function route(
  routeId: string,
  toolKind: SurfaceToolKind,
  command: string | undefined,
  notes: string[],
): SurfaceToolRoute {
  return { route: routeId, toolKind, command, notes };
}

function form(
  kind: SurfaceFormKind,
  role: SurfaceFormRole,
  bestFor: string,
  caveats: string[] = [],
): SurfaceForm {
  return { kind, role, bestFor, caveats };
}

function cloneEntry(entry: SurfaceAtlasEntry): SurfaceAtlasEntry {
  return {
    ...entry,
    controls: entry.controls.map((item) => ({ ...item })),
    shortcuts: entry.shortcuts.map((item) => ({ ...item })),
    abilities: entry.abilities.map((item) => ({
      ...item,
      notes: item.notes ? [...item.notes] : undefined,
    })),
    toolRoutes: entry.toolRoutes.map((item) => ({ ...item, notes: [...item.notes] })),
    forms: entry.forms?.map((item) => ({ ...item, caveats: [...item.caveats] })),
    leasePolicy: { ...entry.leasePolicy, caveats: [...entry.leasePolicy.caveats] },
    knownIssues: [...entry.knownIssues],
    masteryGaps: [...entry.masteryGaps],
    notes: [...entry.notes],
  };
}

function surfaceSortKey(entry: SurfaceAtlasEntry): string {
  const statusRank =
    entry.status === "configured" ? "0" : entry.status === "available-tool" ? "1" : "2";
  const family = entry.family.padEnd(20, " ");
  return `${statusRank}:${family}:${entry.surface}`;
}

function uniqueText<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function isChuckFamily(family: SurfaceAtlasFamily): family is ChuckFamily {
  return [
    "anthropic",
    "openai",
    "google",
    "perplexity",
    "sovereign-local",
    "xai",
    "unknown",
  ].includes(family);
}

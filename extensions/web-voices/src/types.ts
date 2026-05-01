// Public types for @openclaw/plugin-web-voices.
//
// Each web voice has a stable contract (id, vendor, surface, capability
// matrix) and a private DOM-fragile harness that lives behind it. The
// contract is what callers depend on; the harness can be replaced or
// patched without breaking a single caller.

export type WebVoiceVendor = "openai" | "anthropic" | "google" | "xai" | "perplexity";

export type WebVoiceSurface =
  | "web-chrome" // standard Chrome browser session
  | "web-chrome-pwa" // Chrome-installed PWA (separate window)
  | "native-mac"; // native macOS app via osascript

export interface WebVoiceCapabilityMatrix {
  text: boolean;
  image: boolean;
  pdf: boolean;
  audio: boolean;
  video: boolean;
  /** Voice can read the local repo via uploads or shared folders. */
  codeRepo: boolean;
  /** Voice produces grounded citations / web search results. */
  grounding: boolean;
}

export interface WebVoiceCatalogEntry {
  id: string;
  vendor: WebVoiceVendor;
  surface: WebVoiceSurface;
  label: string;
  description: string;
  /** URL the harness expects to find the chat surface at. */
  url: string;
  capabilities: WebVoiceCapabilityMatrix;
  /**
   * True when this voice survives a simultaneous Anthropic + OpenAI outage —
   * the panel-synthesis canonical failure-mode mitigation.
   */
  outageResilient: boolean;
  /**
   * Estimated latency band for a typical request (page load + reply). Used
   * by the workstation lease to schedule conservatively.
   */
  latencyBand: "fast-cli-like" | "medium-web" | "slow-web" | "very-slow-pwa";
}

export interface WebVoiceAskInput {
  voiceId: string;
  prompt: string;
  /** Optional artifact attachments (paths). Rendered into the harness via vendor-specific upload paths when supported. */
  attachments?: string[];
  /** Hard timeout. Falls back to plugin config perVoiceTimeoutMs when unset. */
  timeoutMs?: number;
  /** Filename stem for the saved reply artifact. Defaults to ASK. */
  label?: string;
  /** Output directory. Defaults to ~/Documents. */
  outputDir?: string;
  /** When true, return the dispatch plan + skip the actual harness call. */
  dryRun?: boolean;
}

export interface WebVoiceAskResult {
  ok: boolean;
  voiceId: string;
  label: string;
  /** Path to the saved reply artifact (.md), or null on failure. */
  replyPath: string | null;
  /** Inline reply text. */
  reply: string;
  chars: number;
  ms: number;
  /** Which DOM selector profile was used. Useful for diagnostic when selectors drift. */
  selectorProfile?: string;
  /** Lease ledger entry id when the call held the workstation lease. */
  leaseId?: string;
  error?: string | null;
  warnings?: string[];
}

/**
 * A selector profile is a vendor + version-pinned set of CSS selectors the
 * harness needs (composer textarea, send button, reply container, copy
 * button, etc.). The selector registry holds all known profiles; the
 * harness picks the freshest matching profile at request time and falls
 * through to the auto-patch detector on miss.
 */
export interface SelectorProfile {
  voiceId: string;
  version: string; // YYYY-MM-DD or vendor build id
  selectors: Record<string, string>;
  notes?: string;
}

export interface SelectorRegistry {
  version: 1;
  profiles: SelectorProfile[];
  lastUpdated: string;
}

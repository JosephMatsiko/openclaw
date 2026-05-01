// Public types for @openclaw/skill-panel-ask.
//
// PanelAskInput / PanelAskOutput are the agent-tool I/O contract. They also
// drive the in-process JS API exposed via `runPanelAsk()` in api.ts.

export type PanelAskMode = "raw" | "synthesize";

export type VoiceFamily = "anthropic" | "openai" | "google" | "xai" | "perplexity" | "local";

export type VoiceSurface = "cli" | "web-chrome" | "native-app" | "api" | "local-runtime";

export interface VoiceCatalogEntry {
  id: string;
  family: VoiceFamily;
  surface: VoiceSurface;
  label: string;
  description: string;
  capabilities: ReadonlyArray<"text" | "image" | "pdf" | "audio" | "video" | "code-repo">;
  /** True when this voice survives a simultaneous Anthropic + OpenAI outage. */
  outageResilient: boolean;
}

export interface PanelAskInput {
  /** Inline prompt body. Mutually exclusive with `file`. */
  prompt?: string;
  /** Absolute path to a prompt file. Mutually exclusive with `prompt`. */
  file?: string;
  /** Subset of voice ids. Empty / undefined = all healthy. */
  voices?: string[];
  /** raw = collect per-voice replies; synthesize = also fold via Opus. */
  mode?: PanelAskMode;
  /** Filename stem for per-voice artifacts. */
  label?: string;
  /** Suffix appended to every voice's prompt. "" disables the dispatcher's default suffix. */
  suffix?: string;
  /** Hard ceiling per voice (ms). Slow voices do not block faster ones. */
  timeoutMs?: number;
  /** Output directory for per-voice artifacts. */
  outputDir?: string;
  /** Preview the dispatch plan and exit without calling voices. */
  dryRun?: boolean;
}

export interface VoiceResult {
  id: string;
  label: string;
  ok: boolean;
  /** Filesystem path to the saved reply, or null on failure / dry run. */
  path: string | null;
  /** Character count of the reply body. */
  chars: number;
  /** End-to-end latency for this voice. */
  ms: number;
  error?: string | null;
}

export interface SynthesisResult {
  ok: boolean;
  path: string | null;
  chars: number;
  ms: number;
  /** Voice ids folded into the synthesis. */
  voices: string[];
  /** Synthesizer voice id (must NOT share family with the dominant contributor). */
  synthesizer?: string;
  error?: string | null;
}

export interface PanelAskOutput {
  ok: boolean;
  mode: PanelAskMode;
  voices: VoiceResult[];
  synthesis?: SynthesisResult;
  /** Hash-chained ledger receipt id from the dispatch bus. */
  receiptHash?: string;
  /** Surfaced when the panel completes with at least one voice failure. */
  warnings?: string[];
  /** Surfaced on dry-run: the resolved dispatch plan. */
  plan?: {
    voices: string[];
    mode: PanelAskMode;
    label: string;
  };
}

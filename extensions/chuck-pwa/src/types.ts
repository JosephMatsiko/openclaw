// Public types for @openclaw/plugin-chuck-pwa.

export type VoiceFamily = "anthropic" | "openai" | "google" | "xai" | "perplexity" | "local";

export type VoiceSurface = "cli" | "web-chrome" | "native-app" | "local-runtime";

export interface VoiceCatalogEntry {
  id: string;
  label: string;
  family: VoiceFamily;
  surface: VoiceSurface;
  outageResilient: boolean;
  note: string;
}

export interface AskRequestBody {
  voice: string;
  prompt: string;
  label?: string;
}

export interface AskResponse {
  ok: boolean;
  voice: string;
  label: string;
  ms: number;
  reply: string;
  replyPath: string | null;
  chars: number;
  transport: "cli" | "chrome-driver" | "openclaw-native";
  /** When the dispatch failed, the per-voice metadata if any. */
  voiceMeta?: unknown;
  error?: string | null;
}

export interface VoicesResponse {
  voices: VoiceCatalogEntry[];
  defaultVoice: string;
  updatedAt: string;
}

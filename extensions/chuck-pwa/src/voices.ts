// 8-voice catalog for the chat picker. Outage-resilient voices come first
// so a Joseph who lost Anthropic + OpenAI sees gemini-web / grok-web /
// perplexity-web at the top.
//
// IDs match @openclaw/skill-panel-ask voice ids exactly so the chat
// dispatch can pass them straight through.

import type { VoiceCatalogEntry } from "./types.js";

export const PWA_VOICES: ReadonlyArray<VoiceCatalogEntry> = [
  {
    id: "gemini-web",
    label: "Gemini-Web",
    family: "google",
    surface: "web-chrome",
    outageResilient: true,
    note: "Recommended outage default — Google AI Pro, unmetered.",
  },
  {
    id: "grok-web",
    label: "Grok-Web",
    family: "xai",
    surface: "web-chrome",
    outageResilient: true,
    note: "xAI family — independent of Anthropic + OpenAI.",
  },
  {
    id: "perplexity-web",
    label: "Perplexity-Web",
    family: "perplexity",
    surface: "web-chrome",
    outageResilient: true,
    note: "Best for grounded citations + recency.",
  },
  {
    id: "claude-ai",
    label: "Opus-47-Adaptive",
    family: "anthropic",
    surface: "web-chrome",
    outageResilient: false,
    note: "Claude Opus 4.7 via claude.ai web chat.",
  },
  {
    id: "chatgpt-web",
    label: "ChatGPT-Web",
    family: "openai",
    surface: "web-chrome",
    outageResilient: false,
    note: "GPT-5.5 via chatgpt.com.",
  },
  {
    id: "claude-cli",
    label: "Opus-47-CLI",
    family: "anthropic",
    surface: "cli",
    outageResilient: false,
    note: "Fast Anthropic path (Max sub).",
  },
  {
    id: "gemini-cli",
    label: "Gemini-Pro-CLI",
    family: "google",
    surface: "cli",
    outageResilient: true,
    note: "Quota-bound but reliable.",
  },
  {
    id: "ollama-local",
    label: "Ollama-Local",
    family: "local",
    surface: "local-runtime",
    outageResilient: true,
    note: "Last-resort offline; no network needed.",
  },
];

export function findVoice(id: string): VoiceCatalogEntry | undefined {
  return PWA_VOICES.find((v) => v.id === id);
}

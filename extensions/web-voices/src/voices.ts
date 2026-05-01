// Web voice catalog for @openclaw/plugin-web-voices.
//
// Stable IDs, vendor + surface metadata, and capability matrices for the
// 8 voices that ship in v0.1. The harness implementations live in
// `./harness/<voice-id>.ts` (added in v0.2).
//
// Why this catalog matters for upstream: today every OpenClaw user who
// wants their ChatGPT Plus / AI Pro / xAI / Perplexity Pro subs as a fleet
// writes their own bespoke DOM-intercept scripts. This catalog + the
// harness layer behind it is the contract those users get to depend on
// instead.

import type { WebVoiceCatalogEntry } from "./types.js";

export const WEB_VOICE_CATALOG: ReadonlyArray<WebVoiceCatalogEntry> = [
  {
    id: "chatgpt-web",
    vendor: "openai",
    surface: "web-chrome",
    label: "ChatGPT-Web",
    description: "GPT-5.5 via chatgpt.com web chat under ChatGPT Plus.",
    url: "https://chatgpt.com/",
    capabilities: {
      text: true,
      image: true,
      pdf: true,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: false,
    },
    outageResilient: false,
    latencyBand: "medium-web",
  },
  {
    id: "claude-ai-web",
    vendor: "anthropic",
    surface: "web-chrome",
    label: "Claude.ai Web",
    description: "Claude Opus 4.7 Adaptive via claude.ai web chat. Survives API throttling.",
    url: "https://claude.ai/",
    capabilities: {
      text: true,
      image: true,
      pdf: true,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: false,
    },
    outageResilient: false,
    latencyBand: "medium-web",
  },
  {
    id: "gemini-web",
    vendor: "google",
    surface: "web-chrome",
    label: "Gemini-Web",
    description: "Gemini 3.1 Pro via gemini.google.com under AI Pro. Unmetered.",
    url: "https://gemini.google.com/app",
    capabilities: {
      text: true,
      image: true,
      pdf: true,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: true,
    },
    outageResilient: true,
    latencyBand: "medium-web",
  },
  {
    id: "aistudio-web",
    vendor: "google",
    surface: "web-chrome-pwa",
    label: "AIStudio-Web",
    description:
      "Gemini variants via aistudio.google.com. Ships preview models ahead of gemini.google.com.",
    url: "https://aistudio.google.com/",
    capabilities: {
      text: true,
      image: true,
      pdf: false,
      audio: false,
      video: false,
      codeRepo: true,
      grounding: true,
    },
    outageResilient: true,
    latencyBand: "medium-web",
  },
  {
    id: "grok-web",
    vendor: "xai",
    surface: "web-chrome-pwa",
    label: "Grok-Web",
    description: "Grok via grok.com web chat. xAI family witness for cross-family discipline.",
    url: "https://grok.com/",
    capabilities: {
      text: true,
      image: false,
      pdf: false,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: false,
    },
    outageResilient: true,
    latencyBand: "slow-web",
  },
  {
    id: "perplexity-web",
    vendor: "perplexity",
    surface: "web-chrome",
    label: "Perplexity-Web",
    description:
      "Perplexity Pro via perplexity.ai. Best-in-class for grounded citations + recency.",
    url: "https://www.perplexity.ai/",
    capabilities: {
      text: true,
      image: false,
      pdf: true,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: true,
    },
    outageResilient: true,
    latencyBand: "medium-web",
  },
  {
    id: "comet-web",
    vendor: "perplexity",
    surface: "web-chrome",
    label: "Comet-Web",
    description: "Perplexity Comet browser surface. Distinct account scoping from perplexity-web.",
    url: "https://comet.perplexity.ai/",
    capabilities: {
      text: true,
      image: false,
      pdf: false,
      audio: false,
      video: false,
      codeRepo: false,
      grounding: true,
    },
    outageResilient: true,
    latencyBand: "slow-web",
  },
  {
    id: "notebooklm-web",
    vendor: "google",
    surface: "web-chrome",
    label: "NotebookLM-Web",
    description:
      "NotebookLM (notebooklm.google.com). Source-grounded multi-doc synthesis + Audio Overview.",
    url: "https://notebooklm.google.com/",
    capabilities: {
      text: true,
      image: false,
      pdf: true,
      audio: true,
      video: false,
      codeRepo: false,
      grounding: true,
    },
    outageResilient: true,
    latencyBand: "very-slow-pwa",
  },
];

export function listWebVoices(): ReadonlyArray<WebVoiceCatalogEntry> {
  return WEB_VOICE_CATALOG;
}

export function findWebVoice(id: string): WebVoiceCatalogEntry | undefined {
  return WEB_VOICE_CATALOG.find((v) => v.id === id);
}

/**
 * Filter the catalog by capability requirement. Returns voices that
 * support every requested capability.
 */
export function voicesSupporting(
  needs: ReadonlyArray<keyof WebVoiceCatalogEntry["capabilities"]>,
): WebVoiceCatalogEntry[] {
  return WEB_VOICE_CATALOG.filter((v) => needs.every((cap) => v.capabilities[cap] === true));
}

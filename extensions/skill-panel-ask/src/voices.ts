// Voice catalog for skill-panel-ask.
//
// Metadata-only mirror of the VOICES block in
// extensions/memory-graph/scripts/apex-panel-ask.mjs. Voice ids are kept
// identical so the dispatch subprocess can pass them straight through to
// `--only`. The dispatch logic itself stays in the existing battle-tested
// .mjs script for now; this TS layer is the typed metadata + tool surface.
//
// When the full migration moves dispatch into TypeScript (Stage 3 follow-on),
// this file is also where the per-voice driver functions land. Keeping the
// shape stable now means agent callers won't see any contract drift later.

import type { VoiceCatalogEntry } from "./types.js";

export const VOICE_CATALOG: ReadonlyArray<VoiceCatalogEntry> = [
  // Anthropic family
  {
    id: "claude-cli",
    family: "anthropic",
    surface: "cli",
    label: "Opus-47-CLI",
    description: "Claude Opus 4.7 via the `claude` CLI; unmetered under Anthropic Max.",
    capabilities: ["text", "code-repo"],
    outageResilient: false,
  },
  {
    id: "claude-cli-web-styled",
    family: "anthropic",
    surface: "cli",
    label: "Opus-47-CLI-WebStyled",
    description: "Claude Opus 4.7 via CLI with a claude.ai parity system prompt.",
    capabilities: ["text"],
    outageResilient: false,
  },
  {
    id: "claude-ai",
    family: "anthropic",
    surface: "web-chrome",
    label: "Opus-47-Adaptive-ClaudeAi",
    description: "Claude Opus 4.7 Adaptive via claude.ai web chat; survives API throttling.",
    capabilities: ["text", "image", "pdf"],
    outageResilient: false,
  },

  // OpenAI family
  {
    id: "chatgpt-web",
    family: "openai",
    surface: "web-chrome",
    label: "ChatGPT-Web",
    description: "GPT-5.5 via chatgpt.com web chat under ChatGPT Plus.",
    capabilities: ["text", "image", "pdf"],
    outageResilient: false,
  },
  {
    id: "chatgpt-mac",
    family: "openai",
    surface: "native-app",
    label: "ChatGPT-Mac",
    description:
      "GPT-5.5 via the ChatGPT.app native macOS client; the only path that accepts file attachments at the OpenAI surface.",
    capabilities: ["text", "image", "pdf", "audio"],
    outageResilient: false,
  },
  {
    id: "codex",
    family: "openai",
    surface: "cli",
    label: "Codex-CLI",
    description: "OpenAI codex/gpt-5.5 via Codex CLI; reads the local repo at file:line precision.",
    capabilities: ["text", "code-repo"],
    outageResilient: false,
  },

  // Google family
  {
    id: "gemini-cli",
    family: "google",
    surface: "cli",
    label: "Gemini-31-Pro-CLI",
    description:
      "Gemini 3.1 Pro via the `gemini` CLI; subject to Google-side daily quota on Pro tier.",
    capabilities: ["text"],
    outageResilient: true,
  },
  {
    id: "gemini-web",
    family: "google",
    surface: "web-chrome",
    label: "Gemini-Web",
    description: "Gemini 3.1 Pro via gemini.google.com web chat under AI Pro; unmetered.",
    capabilities: ["text", "image", "pdf"],
    outageResilient: true,
  },
  {
    id: "aistudio-web",
    family: "google",
    surface: "web-chrome",
    label: "AIStudio-Web",
    description:
      "Gemini variants via aistudio.google.com; ships preview models ahead of gemini.google.com.",
    capabilities: ["text", "image", "code-repo"],
    outageResilient: true,
  },

  // xAI family
  {
    id: "grok-web",
    family: "xai",
    surface: "web-chrome",
    label: "Grok-Web",
    description: "Grok via grok.com web chat; xAI family witness for cross-family discipline.",
    capabilities: ["text"],
    outageResilient: true,
  },

  // Perplexity family
  {
    id: "perplexity-web",
    family: "perplexity",
    surface: "web-chrome",
    label: "Perplexity-Web",
    description:
      "Perplexity Pro via perplexity.ai web chat; best-in-class for grounded citations + recency.",
    capabilities: ["text", "pdf"],
    outageResilient: true,
  },
  {
    id: "perplexity-mac",
    family: "perplexity",
    surface: "native-app",
    label: "Perplexity-Mac",
    description: "Perplexity.app native macOS client (Max seat); incognito + Pro Search.",
    capabilities: ["text", "pdf"],
    outageResilient: true,
  },

  // Local family (sovereign / offline)
  {
    id: "ollama-local",
    family: "local",
    surface: "local-runtime",
    label: "Ollama-Local",
    description: "Local-only via Ollama runtime; default qwen3:8b. No network, no quota.",
    capabilities: ["text"],
    outageResilient: true,
  },

  // Perplexity family (Chromium-based browser surface)
  {
    id: "comet-web",
    family: "perplexity",
    surface: "web-chrome",
    label: "Comet-Web",
    description: "Perplexity Comet browser surface; distinct account scoping from perplexity-web.",
    capabilities: ["text"],
    outageResilient: true,
  },

  // Google family (notebook synthesis surface)
  {
    id: "notebooklm-web",
    family: "google",
    surface: "web-chrome",
    label: "NotebookLM-Web",
    description:
      "NotebookLM (notebooklm.google.com); source-grounded multi-doc synthesis + Audio Overview.",
    capabilities: ["text", "pdf", "audio"],
    outageResilient: true,
  },
];

export function listVoices(): ReadonlyArray<VoiceCatalogEntry> {
  return VOICE_CATALOG;
}

export function findVoice(id: string): VoiceCatalogEntry | undefined {
  return VOICE_CATALOG.find((v) => v.id === id);
}

/**
 * Pick a synthesizer voice id whose family does NOT match the dominant
 * contributor's family. Encodes the panel-synthesis hard rule that the
 * auditor cannot share Chuck-PM's training family.
 *
 * Returns null when no eligible alternate exists (caller should fall back
 * to a safe default such as `claude-cli`).
 */
export function selectSynthesizer(
  contributorIds: ReadonlyArray<string>,
  candidatePool: ReadonlyArray<string> = ["claude-cli", "chatgpt-web", "gemini-cli", "grok-web"],
): string | null {
  const familyVotes = new Map<string, number>();
  for (const id of contributorIds) {
    const voice = findVoice(id);
    if (!voice) continue;
    familyVotes.set(voice.family, (familyVotes.get(voice.family) ?? 0) + 1);
  }
  let dominantFamily: string | null = null;
  let dominantCount = 0;
  for (const [family, count] of familyVotes) {
    if (count > dominantCount) {
      dominantFamily = family;
      dominantCount = count;
    }
  }
  if (!dominantFamily) return null;
  for (const candidateId of candidatePool) {
    const voice = findVoice(candidateId);
    if (!voice) continue;
    if (voice.family !== dominantFamily) {
      return candidateId;
    }
  }
  return null;
}

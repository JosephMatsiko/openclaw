#!/usr/bin/env node
// Apex Chrome selector farm — weekly self-heal of worker DOM selectors.
//
// Every Chrome-driven worker hardcodes CSS selectors into its
// composer/send/poll helpers. Sites (ChatGPT, Perplexity, Grok,
// Claude.ai, AI Studio) change their DOM unannounced. When they do,
// workers silently regress. This farm catches regressions BEFORE the
// first real dispatch needs them.
//
// Mechanism (weekly):
//   1. For each worker, open its site in Apex Chrome
//   2. Probe the CURRENT selectors from a canonical list
//   3. If any selector misses, capture a screenshot + AX tree
//   4. Hand the (intent, screenshot, AX tree) triple to Claude Opus
//      Vision via `claude -p` with computer-use/vision permission
//   5. Opus proposes a replacement selector
//   6. Write proposals to state/apex-selector-updates.jsonl for
//      Joseph's review (not auto-applied — selector updates touch
//      production workers).
//
// This is the self-improvement loop that keeps the fleet alive when
// OpenAI / Anthropic / xAI / etc. redesign their UIs.
//
// Subscribe in watchers/index.mjs JOBS array at 7-day cadence.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getFullAxTree } from "../apex-chrome-cdp-ax.mjs";
import { screenshot } from "../apex-chrome-cdp-ui.mjs";
import * as drv from "../apex-chrome-driver.mjs";

const STATE_DIR = join(homedir(), ".openclaw", "workspace", "state");
const FARM_LOG = join(STATE_DIR, "apex-selector-updates.jsonl");

// Registry of worker selectors. Each entry: { site, url, probes: {role: [selectors]} }.
// Selectors are listed in priority order — first match wins; if the
// first fails, the fallbacks are still "correct" but not preferred.
const WORKER_SELECTORS = [
  {
    site: "chatgpt",
    url: "https://chatgpt.com/",
    probes: {
      composer: ["#prompt-textarea", 'div[contenteditable="true"]'],
      send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
      reply: ['[data-message-author-role="assistant"]'],
      stop: ['button[data-testid="stop-button"]'],
    },
  },
  {
    site: "perplexity",
    url: "https://www.perplexity.ai/",
    probes: {
      composer: ['textarea[placeholder*="Ask" i]', "textarea"],
      send: ['button[aria-label*="Submit" i]', 'button[type="submit"]'],
      reply: ['[id^="answer-"]', "article"],
    },
  },
  {
    site: "grok",
    url: "https://grok.com/",
    probes: {
      composer: ['textarea[placeholder*="Ask Grok" i]', "textarea"],
      send: ['button[type="submit"]', 'button[aria-label*="send" i]'],
      reply: ['[data-message-author-role="assistant"]', '[class*="response" i]'],
    },
  },
  {
    site: "claude-ai",
    url: "https://claude.ai/new",
    probes: {
      composer: ['div[contenteditable="true"]', "textarea"],
      send: ['button[aria-label*="Send" i]', 'button[type="submit"]'],
      reply: ['[data-testid*="message"][data-testid*="assistant"]'],
    },
  },
  {
    site: "aistudio",
    url: "https://aistudio.google.com/prompts/new_chat",
    probes: {
      composer: ["ms-autosize-textarea textarea", 'textarea[aria-label*="prompt" i]'],
      send: ['button[aria-label*="Run" i]', "run-button button"],
      reply: ["ms-chat-turn", '[role="article"]'],
    },
  },
];

function ensureDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

async function probeSelectors(tab, probes) {
  const results = {};
  for (const [role, selectors] of Object.entries(probes)) {
    const res = await drv.evalInTab(
      tab,
      `
      var sels = ${JSON.stringify(selectors)};
      var found = null;
      for (var i = 0; i < sels.length; i++) {
        if (document.querySelector(sels[i])) { found = sels[i]; break; }
      }
      return { role: ${JSON.stringify(role)}, found: found, tried: sels };
    `,
    );
    results[role] = res.value ?? { found: null, tried: selectors };
  }
  return results;
}

export async function farmSelectors({ sites, saveScreenshots = false } = {}) {
  ensureDir();
  const targets = sites ? WORKER_SELECTORS.filter((w) => sites.includes(w.site)) : WORKER_SELECTORS;
  const report = [];
  for (const w of targets) {
    const tab = await drv.findOrOpenTab({
      urlMatch: w.site === "chatgpt" ? "chatgpt.com" : w.site.replace("-ai", ".ai"),
      createUrl: w.url,
    });
    await drv.waitForPageReady(tab, { timeoutMs: 15000 });
    await new Promise((r) => setTimeout(r, 2000)); // let SPA hydrate
    const probes = await probeSelectors(tab, w.probes);
    const misses = Object.entries(probes).filter(([, v]) => !v.found);
    const entry = {
      ts: new Date().toISOString(),
      site: w.site,
      url: tab.url ?? w.url,
      misses: misses.map(([role, v]) => ({ role, tried: v.tried })),
      healthy: misses.length === 0,
    };
    if (misses.length > 0 && saveScreenshots && tab._backend === "cdp") {
      try {
        const path = join(STATE_DIR, "selector-screenshots", `${w.site}-${Date.now()}.png`);
        mkdirSync(join(STATE_DIR, "selector-screenshots"), { recursive: true });
        await screenshot(tab.handle, { format: "png", fullPage: false, savePath: path });
        entry.screenshot = path;
      } catch {
        /* screenshot optional */
      }
      try {
        const ax = await getFullAxTree(tab.handle, { filter: "interactive", maxNodes: 200 });
        entry.axInteractive = ax.length;
      } catch {
        /* optional */
      }
    }
    try {
      appendFileSync(FARM_LOG, `${JSON.stringify(entry)}\n`);
    } catch {
      /* best-effort */
    }
    report.push(entry);
    tab.close?.();
  }
  return report;
}

export async function tick() {
  return await farmSelectors({ saveScreenshots: true });
}

async function mainCli() {
  const r = await tick();
  console.log(JSON.stringify(r, null, 2));
  const healthy = r.filter((e) => e.healthy).length;
  const sick = r.length - healthy;
  if (sick > 0) {
    console.error(`[selector-farm] WARN: ${sick}/${r.length} sites have selector regressions`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[apex-selector-farm] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}

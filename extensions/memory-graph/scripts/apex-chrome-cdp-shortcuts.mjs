#!/usr/bin/env node
// Apex Chrome CDP Shortcuts — JSON recipe engine.
//
// Absorbs Claude-in-Chrome `shortcuts_list` + `shortcuts_execute`.
// Shortcuts live at ~/.openclaw/workspace/apex-shortcuts/*.json and
// are arrays of actions. Actions dispatch against a driver map; the
// engine supports a small DSL of primitives: navigate, wait, click,
// type, key, screenshot, assert.
//
// Each shortcut file:
//
// {
//   "name": "chatgpt-daily-digest",
//   "description": "Open ChatGPT, ask for a daily digest, save reply",
//   "actions": [
//     { "type": "findOrOpen", "urlMatch": "chatgpt.com", "createUrl": "https://chatgpt.com/" },
//     { "type": "waitReady", "timeoutMs": 10000 },
//     { "type": "eval", "code": "document.querySelector('#prompt-textarea').focus(); true;" },
//     { "type": "insertText", "text": "Give me today's key news in 5 bullets." },
//     { "type": "wait", "ms": 500 },
//     { "type": "click", "selector": "button[data-testid='send-button']" },
//     { "type": "pollReply", "timeoutMs": 120000 },
//     { "type": "saveText", "out": "~/.openclaw/workspace/memory/daily-digest-$(date).md" }
//   ]
// }

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as drv from "./apex-chrome-driver.mjs";

const SHORTCUTS_DIR = join(homedir(), ".openclaw", "workspace", "apex-shortcuts");

export function listShortcuts() {
  if (!existsSync(SHORTCUTS_DIR)) {
    return [];
  }
  const out = [];
  for (const f of readdirSync(SHORTCUTS_DIR)) {
    if (!f.endsWith(".json")) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(join(SHORTCUTS_DIR, f), "utf8"));
      out.push({
        file: f,
        name: raw.name ?? f.replace(/\.json$/, ""),
        description: raw.description ?? "",
        actionCount: Array.isArray(raw.actions) ? raw.actions.length : 0,
      });
    } catch {
      /* ignore bad files */
    }
  }
  return out;
}

function expandPath(p) {
  if (!p) {
    return p;
  }
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return String(p)
    .replace(/^~/, homedir())
    .replace(/\$\(date\)/g, date);
}

export async function executeShortcut(name) {
  if (!existsSync(SHORTCUTS_DIR)) {
    throw new Error(`shortcuts dir missing: ${SHORTCUTS_DIR}`);
  }
  const file = join(SHORTCUTS_DIR, name.endsWith(".json") ? name : `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`shortcut not found: ${file}`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const ctx = { tab: null, lastResult: null, vars: {} };
  const log = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i];
    const step = { i, type: a.type, ok: true, error: null, result: null };
    try {
      switch (a.type) {
        case "findOrOpen":
          ctx.tab = await drv.findOrOpenTab({ urlMatch: a.urlMatch, createUrl: a.createUrl });
          step.result = { tabId: ctx.tab.id ?? ctx.tab.target };
          break;
        case "waitReady":
          await drv.waitForPageReady(ctx.tab, { timeoutMs: a.timeoutMs ?? 10000 });
          break;
        case "eval":
          step.result = await drv.evalInTab(ctx.tab, a.code);
          break;
        case "insertText": {
          // Use driver's insertText if CDP; else evalInTab fallback.
          if (ctx.tab?._backend === "cdp") {
            await drv.insertText?.(ctx.tab, a.text);
            break;
          }
          await drv.evalInTab(
            ctx.tab,
            `var el = document.activeElement; if (!el) return { ok: false }; if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { el.value = (el.value||'') + ${JSON.stringify(a.text)}; el.dispatchEvent(new Event('input', {bubbles:true})); } else { document.execCommand('insertText', false, ${JSON.stringify(a.text)}); } return { ok: true };`,
          );
          break;
        }
        case "click":
          await drv.evalInTab(
            ctx.tab,
            `var el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return { ok: false, error: "not found" }; el.click(); return { ok: true };`,
          );
          break;
        case "key":
          await drv.dispatchKey(ctx.tab, a.key ?? "Enter");
          break;
        case "wait":
          await new Promise((r) => setTimeout(r, Number(a.ms ?? 500)));
          break;
        case "pollReply": {
          const text = await drv.pollUntilStable({
            tab: ctx.tab,
            read: async (t) => {
              const r = await drv.evalInTab(
                t,
                `var msgs = document.querySelectorAll("[data-message-author-role=\\"assistant\\"]"); var last = msgs[msgs.length - 1]; var md = last ? last.querySelector(".markdown") : null; var text = (md && (md.innerText || md.textContent)) || (last && last.textContent) || ""; var stop = document.querySelector("button[data-testid=\\"stop-button\\"]"); return { text: text.trim(), streaming: !!stop };`,
              );
              return r.value ?? { text: "", streaming: false };
            },
            timeoutMs: a.timeoutMs ?? 120000,
          });
          ctx.vars.lastReply = text;
          step.result = { chars: text.length };
          break;
        }
        case "saveText": {
          const out = expandPath(a.out);
          const dir = dirname(out);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(out, ctx.vars.lastReply ?? "", "utf8");
          step.result = { savedTo: out };
          break;
        }
        case "assert": {
          const r = await drv.evalInTab(ctx.tab, `return ${a.expr};`);
          if (!r.value) {
            throw new Error(`assert failed: ${a.expr}`);
          }
          break;
        }
        default:
          throw new Error(`unknown action type: ${a.type}`);
      }
    } catch (err) {
      step.ok = false;
      step.error = err instanceof Error ? err.message : String(err);
      log.push(step);
      return { ok: false, log, shortcut: raw.name };
    }
    log.push(step);
  }
  return { ok: true, log, shortcut: raw.name };
}

async function mainCli() {
  const cmd = process.argv[2] ?? "list";
  if (cmd === "list") {
    const items = listShortcuts();
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (cmd === "exec") {
    const name = process.argv[3];
    if (!name) {
      console.error("usage: apex-chrome-cdp-shortcuts.mjs exec <name>");
      process.exit(2);
    }
    const r = await executeShortcut(name);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) {
      process.exitCode = 1;
    }
    return;
  }
  console.error("usage: apex-chrome-cdp-shortcuts.mjs [list|exec <name>]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[apex-shortcuts] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}

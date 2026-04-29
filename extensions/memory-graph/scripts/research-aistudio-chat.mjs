#!/usr/bin/env node
// Research + ask worker — Google AI Studio (aistudio.google.com).
//
// AI Studio exposes Gemini models with its own quota pool, separate
// from the CLI OAuth tier. Useful in TRIO+ as a second Gemini voice or
// a cascade target when CLI Pro quota exhausts.
//
// Drives through apex-chrome-driver. Sovereign.

import {
  dispatchKey,
  evalInTab,
  findOrOpenTab,
  pollUntilStable,
  waitForPageReady,
} from "./apex-chrome-driver.mjs";

const AIS_URL_MATCH = "aistudio.google.com";
const AIS_START_URL = "https://aistudio.google.com/prompts/new_chat";
const MODEL_LABEL = "aistudio/web-chat";

async function waitComposerReady(tab, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalInTab(
      tab,
      `
      var composer = document.querySelector('textarea[aria-label*="prompt" i]')
                  || document.querySelector('textarea[aria-label*="type" i]')
                  || document.querySelector('textarea[placeholder*="type" i]')
                  || document.querySelector('ms-autosize-textarea textarea')
                  || document.querySelector('textarea');
      var loginBtn = document.querySelector('a[href*="accounts.google"]');
      return { composer: !!composer, loginBtn: !!loginBtn, title: document.title, url: location.href };
    `,
    );
    const v = r.value ?? {};
    if (v.composer) {
      return { ok: true, ...v };
    }
    if (v.loginBtn) {
      return { ok: false, reason: "not-signed-in", ...v };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return { ok: false, reason: "timeout" };
}

async function readCurrentModel(tab) {
  const r = await evalInTab(
    tab,
    `
    var body = document.body.innerText || "";
    var selected = body.match(/\\n(Gemini[^\\n]+)\\n(gemini-[a-z0-9_.-]+)/i);
    if (selected) return (selected[1] + " " + selected[2]).trim();
    var el = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(node) {
      var text = (node.innerText || node.getAttribute('aria-label') || '').trim();
      return /^Gemini\\b/i.test(text) && /gemini-/i.test(text);
    });
    return el ? (el.innerText || el.getAttribute('aria-label') || "").trim() : "";
  `,
  );
  return (r.ok && r.value) || "gemini";
}

async function dismissBlockingBanners(tab) {
  await evalInTab(
    tab,
    `
    for (var b of Array.from(document.querySelectorAll('button'))) {
      var text = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim();
      if (/^(Dismiss|Got it|Close)$/i.test(text) && !b.disabled) {
        b.click();
      }
    }
    return true;
  `,
  );
}

// AI Studio Run-Settings — comprehensive toggle/select/slider coverage.
// Live-DOM verified 2026-04-28: AI Studio's right-rail "Run settings"
// panel exposes these controls. Joseph caught that earlier coverage was
// only 3 of 12+ tools.
//
// SWITCHES (boolean, button[role="switch"][aria-label="<label>"]):
//   - grounding        → "Grounding with Google Search"
//   - groundingMaps    → "Grounding with Google Maps"  (NEW geo-grounding)
//   - urlContext       → "Browse the url context"
//   - codeExec         → "Code execution"
//   - functionCalling  → "Function calling"             (tool use)
//   - structuredOutputs→ "Structured outputs"           (JSON / typed)
//
// SELECTS (mat-select / [role="combobox"]):
//   - thinkingLevel    → "Thinking Level" (Low|Medium|High)
//   - mediaResolution  → "Media resolution" (Default|Low|Medium|High)
//
// SLIDERS / inputs (skipped here — set via input event if needed):
//   - temperature, topP, outputLength
//
// All toggles are idempotent: only clicked if state mismatches target.
// Returns per-key {found, was, target, clicked} so callers can verify.
async function setAiStudioRunOptions(
  tab,
  {
    grounding,
    groundingMaps,
    urlContext,
    codeExec,
    functionCalling,
    structuredOutputs,
    thinkingLevel,
    mediaResolution,
  } = {},
) {
  // Build the "wants" object from only the keys actually passed (so we
  // don't toggle off something the user didn't mention).
  const want = {};
  if (typeof grounding === "boolean") {
    want.grounding = grounding;
  }
  if (typeof groundingMaps === "boolean") {
    want.groundingMaps = groundingMaps;
  }
  if (typeof urlContext === "boolean") {
    want.urlContext = urlContext;
  }
  if (typeof codeExec === "boolean") {
    want.codeExec = codeExec;
  }
  if (typeof functionCalling === "boolean") {
    want.functionCalling = functionCalling;
  }
  if (typeof structuredOutputs === "boolean") {
    want.structuredOutputs = structuredOutputs;
  }

  const r = await evalInTab(
    tab,
    `
    var want = ${JSON.stringify(want)};
    var labels = {
      grounding: /^Grounding with Google Search$/i,
      groundingMaps: /^Grounding with Google Maps$/i,
      urlContext: /^Browse the url context$|^URL context$/i,
      codeExec: /^Code execution$/i,
      functionCalling: /^Function calling$/i,
      structuredOutputs: /^Structured outputs$/i
    };
    var result = {};
    for (var key of Object.keys(want)) {
      var rx = labels[key];
      if (!rx) { result[key] = { found: false, error: "no label mapping" }; continue; }
      var sw = Array.from(document.querySelectorAll('button[role="switch"]')).find(function(b) {
        return rx.test((b.getAttribute('aria-label') || '').trim());
      });
      if (!sw) {
        result[key] = { found: false };
        continue;
      }
      var current = sw.getAttribute('aria-checked') === 'true';
      if (current !== want[key]) {
        sw.click();
      }
      result[key] = { found: true, was: current, target: want[key], clicked: current !== want[key] };
    }
    return result;
  `,
  );
  const out = { switches: r.value ?? {} };

  // Selects (Thinking Level, Media resolution) — open mat-select, click option.
  if (thinkingLevel || mediaResolution) {
    out.selects = {};
    const selectTargets = [];
    if (thinkingLevel) {
      selectTargets.push({ key: "thinkingLevel", label: "Thinking Level", value: thinkingLevel });
    }
    if (mediaResolution) {
      selectTargets.push({
        key: "mediaResolution",
        label: "Media resolution",
        value: mediaResolution,
      });
    }
    for (const t of selectTargets) {
      const click = await evalInTab(
        tab,
        `
        // Find the mat-select / combobox whose aria-label matches
        var label = ${JSON.stringify(t.label)};
        var select = Array.from(document.querySelectorAll('mat-select, [role="combobox"]'))
          .find(function(s) { return new RegExp('^' + label + '$', 'i').test((s.getAttribute('aria-label') || '').trim()); });
        if (!select) return { ok: false, error: "no select" };
        var currentText = (select.innerText || '').trim();
        if (currentText.toLowerCase() === ${JSON.stringify(t.value.toLowerCase())}) {
          return { ok: true, already: currentText };
        }
        select.click();
        return { ok: true, opened: true, was: currentText };
      `,
      );
      if (!click.ok || click.value?.ok === false) {
        out.selects[t.key] = { ok: false, error: click.value?.error };
        continue;
      }
      if (click.value.already) {
        out.selects[t.key] = { ok: true, already: click.value.already };
        continue;
      }
      // Wait for menu, click matching option.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pick = await evalInTab(
        tab,
        `
        var target = ${JSON.stringify(t.value)};
        var options = Array.from(document.querySelectorAll('mat-option, [role="option"]'));
        var match = options.find(function(o) {
          return new RegExp('^' + target + '\\\\b', 'i').test((o.innerText || '').trim());
        });
        if (!match) {
          document.body.click();
          return { ok: false, error: "no option " + target };
        }
        match.click();
        return { ok: true, picked: (match.innerText || '').trim() };
      `,
      );
      out.selects[t.key] = pick.value ?? { ok: false, error: pick.error };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return out;
}

async function submitPrompt(tab, prompt) {
  const insert = await evalInTab(
    tab,
    `
    var c = document.querySelector('ms-autosize-textarea textarea')
         || document.querySelector('textarea[aria-label*="prompt" i]')
         || document.querySelector('textarea');
    if (!c) return { ok: false, error: "no composer" };
    c.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(c, ${JSON.stringify(prompt)});
    else c.value = ${JSON.stringify(prompt)};
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  `,
  );
  if (!insert.ok || insert.value?.ok === false) {
    throw new Error(`aistudio insert: ${insert.error ?? insert.value?.error}`);
  }
  await new Promise((r) => setTimeout(r, 500));
  await dismissBlockingBanners(tab);
  const send = await evalInTab(
    tab,
    `
    function visible(el) {
      return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }
    var buttons = Array.from(document.querySelectorAll('button'));
    var b = buttons.find(function(el) {
          var lines = (el.innerText || '').trim().split(/\\n+/).map(function(line) { return line.trim(); });
          return visible(el) && !el.disabled && lines.includes('Run');
        })
         || document.querySelector('run-button button:not([disabled])')
         || buttons.find(function(el) {
          var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          return visible(el) && !el.disabled && /\\b(Run|Send)\\b/i.test(label);
        });
    if (!b) return { ok: false, error: "no send" };
    if (b.disabled) return { ok: false, error: "disabled" };
    b.scrollIntoView({ block: 'center', inline: 'center' });
    for (var type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    b.click();
    return { ok: true, buttonText: (b.innerText || b.getAttribute('aria-label') || '').trim() };
  `,
  );
  if (!send.ok || send.value?.ok === false) {
    try {
      await dispatchKey(tab, "Enter");
      return {
        ok: true,
        buttonText: "keyboard-fallback",
        caveats: [`Run button dispatch failed: ${send.value?.error ?? send.error ?? "unknown"}`],
      };
    } catch (e) {
      throw new Error(`aistudio send: ${send.value?.error}`, { cause: e });
    }
  }
  return {
    ok: true,
    buttonText: String(send.value?.buttonText ?? "Run"),
    caveats: [],
  };
}

async function readReply(tab, prompt = "") {
  const r = await evalInTab(
    tab,
    `
    var promptText = ${JSON.stringify(prompt)};
    var requiresSurfaceProof = /\\bSURFACE_PROOF_OK\\b/.test(promptText);
    function clean(raw) {
      var lines = String(raw || "").split("\\n").map(function(line) { return line.trim(); }).filter(Boolean);
      var out = [];
      var drop = [
        /^edit$/i,
        /^more_vert$/i,
        /^thumb_up$/i,
        /^thumb_down$/i,
        /^info$/i,
        /^Google AI models may make mistakes/i,
        /^Use Arrow Up and Arrow Down/i,
        /^\\d+(?:\\.\\d+)?\\s*(?:ms|s)$/i
      ];
      for (var line of lines) {
        if (drop.some(function(rx) { return rx.test(line); })) continue;
        if (/^Response ready\\.?$/i.test(line)) break;
        out.push(line);
      }
      return out.join("\\n").trim();
    }
    function isPromptEcho(text) {
      return promptText && text.replace(/\\s+/g, " ").includes(promptText.replace(/\\s+/g, " ").slice(0, 120));
    }
    function isUserTurn(text) {
      return /^User\\s+\\d{1,2}:\\d{2}/i.test(text) || isPromptEcho(text);
    }
    var turns = Array.from(document.querySelectorAll('ms-chat-turn'));
    var candidates = turns.map(function(el) {
      var raw = el.innerText || el.textContent || "";
      return {
        raw: raw,
        text: clean(raw),
        done: /\\bthumb_up\\b/i.test(raw) || /\\bthumb_down\\b/i.test(raw) || /\\b\\d+(?:\\.\\d+)?\\s*s\\b/i.test(raw)
      };
    }).filter(function(text) {
      return text.text && !/^Thoughts\\b/i.test(text.text) && !isUserTurn(text.text);
    });
    var structured = candidates.filter(function(item) {
      return /\\b(SURFACE_PROOF_OK|CLAIMS:|RISKS:|MISSING_EVIDENCE:|DEEPEN_NEEDED:)\\b/i.test(item.text);
    });
    var selected = (structured.length ? structured[structured.length - 1] : candidates[candidates.length - 1]) || { text: "", done: false };
    if (requiresSurfaceProof && !/\\bSURFACE_PROOF_OK\\b/.test(selected.text)) {
      return { text: "", streaming: true, waitingFor: "SURFACE_PROOF_OK" };
    }
    var body = document.body.innerText || "";
    var explicitRunning = /\\bStop\\s+Running\\.\\.\\./i.test(body) ||
      !!document.querySelector('button[aria-label*="Stop" i], [aria-label*="Running" i]');
    return { text: selected.text.trim(), streaming: explicitRunning || !selected.done };
  `,
  );
  if (!r.ok) {
    throw new Error(`aistudio poll: ${r.error}`);
  }
  return r.value ?? { text: "", streaming: false };
}

export async function askAiStudioChat({
  prompt,
  forceFresh = true,
  grounding,
  groundingMaps,
  urlContext,
  codeExec,
  functionCalling,
  structuredOutputs,
  thinkingLevel,
  mediaResolution,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("askAiStudioChat: prompt required");
  }
  const tab = await findOrOpenTab({ urlMatch: AIS_URL_MATCH, createUrl: AIS_START_URL });
  if (forceFresh && !tab.created) {
    await evalInTab(tab, `location.href = ${JSON.stringify(AIS_START_URL)};`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (tab.created || forceFresh) {
    const ready = await waitForPageReady(tab, { timeoutMs: 20000, urlIncludes: AIS_URL_MATCH });
    if (!ready) {
      throw new Error("aistudio did not load");
    }
  }
  const state = await waitComposerReady(tab);
  if (!state.ok) {
    if (state.reason === "turnstile" || state.reason === "cf-challenge-path") {
      void import("./apex-cf-signal.mjs")
        .then((m) =>
          m.emitCfSignal({
            domain: "aistudio.google.com",
            reason: state.reason,
            tabUrl: state.url,
          }),
        )
        .catch(() => {});
    }
    throw new Error(`aistudio not ready: ${state.reason}`);
  }
  await dismissBlockingBanners(tab);
  // Engage Run-Settings BEFORE submit. Defaults read from env knobs:
  //   CHUCK_AISTUDIO_GROUNDING=1      → Grounding with Google Search
  //   CHUCK_AISTUDIO_GROUNDING_MAPS=1 → Grounding with Google Maps (geo)
  //   CHUCK_AISTUDIO_URL=1            → URL context (fetch URLs in prompt)
  //   CHUCK_AISTUDIO_CODE=1           → Code execution (Python tool)
  //   CHUCK_AISTUDIO_FUNCTION=1       → Function calling (tool use)
  //   CHUCK_AISTUDIO_STRUCTURED=1     → Structured outputs (JSON mode)
  //   CHUCK_AISTUDIO_THINKING=Low|Medium|High → Thinking Level
  //   CHUCK_AISTUDIO_MEDIA=Low|Medium|High|Default → Media resolution
  // Per-call overrides via function args take precedence over env.
  const envBool = (v) =>
    v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined;
  const runOpts = {
    grounding: grounding ?? envBool(process.env.CHUCK_AISTUDIO_GROUNDING),
    groundingMaps: groundingMaps ?? envBool(process.env.CHUCK_AISTUDIO_GROUNDING_MAPS),
    urlContext: urlContext ?? envBool(process.env.CHUCK_AISTUDIO_URL),
    codeExec: codeExec ?? envBool(process.env.CHUCK_AISTUDIO_CODE),
    functionCalling: functionCalling ?? envBool(process.env.CHUCK_AISTUDIO_FUNCTION),
    structuredOutputs: structuredOutputs ?? envBool(process.env.CHUCK_AISTUDIO_STRUCTURED),
    thinkingLevel: thinkingLevel ?? process.env.CHUCK_AISTUDIO_THINKING,
    mediaResolution: mediaResolution ?? process.env.CHUCK_AISTUDIO_MEDIA,
  };
  // Drop undefineds so the helper only touches options the caller meant
  for (const k of Object.keys(runOpts)) {
    if (runOpts[k] === undefined) {
      delete runOpts[k];
    }
  }
  if (Object.keys(runOpts).length > 0) {
    try {
      const toggleResult = await setAiStudioRunOptions(tab, runOpts);
      process.stderr.write(`[aistudio] run-options: ${JSON.stringify(toggleResult)}\n`);
    } catch (err) {
      process.stderr.write(`[aistudio] toggle threw: ${err?.message ?? err}\n`);
    }
  }
  const model = await readCurrentModel(tab);
  const submitProof = await submitPrompt(tab, String(prompt));
  // 300s — AI Studio streams reasoning/thinking for long-prompt 2.5 Pro runs.
  const text = await pollUntilStable({
    tab,
    read: async (activeTab) => await readReply(activeTab, String(prompt)),
    timeoutMs: 300_000,
  });
  return {
    text: text.trim(),
    modelUsed: `${MODEL_LABEL} (${model})`,
    transportProofs: transportProofsForAiStudio({
      model,
      submitProof,
      url: state.url,
    }),
  };
}

function transportProofsForAiStudio({ model = "", submitProof = {}, url = "" } = {}) {
  const checkedAt = new Date().toISOString();
  const runButtonVisible = /\bRun\b/i.test(String(submitProof.buttonText ?? ""));
  const modelKnown = Boolean(model.trim());
  return [
    {
      surface: "aistudio/web",
      criterion: "open-target",
      verdict: "proved",
      method: "browser-cdp-tab",
      evidence: url || AIS_START_URL,
      checkedAt,
      caveats: [],
    },
    {
      surface: "aistudio/web",
      criterion: "mode-switch",
      verdict: runButtonVisible && modelKnown ? "proved" : "missing",
      method: "browser-cdp-run-button-and-model-selector",
      evidence: `model=${model || "unknown"}; submit=${submitProof.buttonText ?? "unknown"}`,
      checkedAt,
      caveats: [
        ...(submitProof.caveats ?? []),
        "Mode proof confirms Run-button/model-selector control path; entitlement remains separately tracked by model label and receipts.",
      ],
    },
  ];
}

function buildResearchPrompt(beat, n) {
  return `Pull ${n} cited news items from past 7 days on beat: ${beat}. Output ONLY a JSON array of {title, summary, source, url, publishedHint}.`;
}

function parseArray(raw) {
  const s = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const a = s.indexOf("["),
    b = s.lastIndexOf("]");
  if (a < 0 || b < 0) {
    throw new Error(`aistudio: no array`);
  }
  return JSON.parse(s.slice(a, b + 1));
}

export async function researchBeat(beat, { items = 5 } = {}) {
  const { text, modelUsed } = await askAiStudioChat({ prompt: buildResearchPrompt(beat, items) });
  const parsed = parseArray(text);
  const normalized = parsed
    .map((it) => ({
      title: String(it?.title ?? "").trim(),
      summary: String(it?.summary ?? "").trim(),
      source: String(it?.source ?? "").trim(),
      url: String(it?.url ?? "").trim(),
      publishedHint: String(it?.publishedHint ?? "").trim(),
    }))
    .filter((it) => it.title && it.summary && it.url);
  return { beat, modelUsed, items: normalized };
}

async function mainCli() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const ask = argv.includes("--ask");
  const idx = argv.indexOf("--items");
  const n = idx >= 0 ? Number.parseInt(argv[idx + 1] ?? "5", 10) : 5;
  const text = argv
    .filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--items")
    .join(" ")
    .trim();
  if (!text) {
    console.error("usage: research-aistudio-chat.mjs [--ask] [--json] [--items N] <text>");
    process.exit(2);
  }
  const r = ask ? await askAiStudioChat({ prompt: text }) : await researchBeat(text, { items: n });
  console.log(
    asJson
      ? JSON.stringify(r, null, 2)
      : ask
        ? `# AI Studio — ${r.modelUsed}\n\n${r.text}`
        : JSON.stringify(r, null, 2),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mainCli().catch((e) => {
    console.error(`[research-aistudio-chat] fatal: ${e.stack ?? e}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// Apex Chrome CDP Observe — absorbs Claude-in-Chrome's read-side
// capabilities into sovereign CDP:
//   read_page         → getAXTree(tab, opts)
//   get_page_text     → getPageText(tab)
//   read_console      → readConsole(tab, opts)
//   read_network      → readNetwork(tab, opts)
//   find              → findElements(tab, query)  (CSS + text heuristic;
//                                                  LLM fallback pluggable)
//   find_in_page      → findInPage(tab, query, index)
//   search_open_tabs  → searchOpenTabs(query)
//
// Event buffers (console + network) attach lazily to a tab on first
// read. Subscribed events accumulate in the ApexTab instance; reads
// return the current buffer (optionally cleared).

import { evalInTab, listTabs } from "./apex-chrome-cdp.mjs";

// ---- Event buffers (attached lazily to tabs) --------------------------

async function ensureConsoleBuffer(tab) {
  if (tab._consoleBuffer) {
    return;
  }
  tab._consoleBuffer = [];
  const conn = await tab.conn();
  await conn.send("Log.enable").catch(() => {});
  await conn.send("Runtime.enable").catch(() => {});
  conn.on("Runtime.consoleAPICalled", (params) => {
    const args = (params.args ?? [])
      .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");
    tab._consoleBuffer.push({
      ts: params.timestamp,
      type: params.type,
      text: args,
      stackTrace: params.stackTrace,
    });
    // Cap buffer
    if (tab._consoleBuffer.length > 500) {
      tab._consoleBuffer.shift();
    }
  });
  conn.on("Log.entryAdded", (params) => {
    const e = params.entry ?? {};
    tab._consoleBuffer.push({
      ts: e.timestamp,
      type: e.level,
      text: e.text,
      source: e.source,
      url: e.url,
    });
    if (tab._consoleBuffer.length > 500) {
      tab._consoleBuffer.shift();
    }
  });
  conn.on("Runtime.exceptionThrown", (params) => {
    const d = params.exceptionDetails ?? {};
    tab._consoleBuffer.push({
      ts: params.timestamp,
      type: "exception",
      text: d.exception?.description ?? d.text ?? "uncaught exception",
      url: d.url,
      line: d.lineNumber,
    });
    if (tab._consoleBuffer.length > 500) {
      tab._consoleBuffer.shift();
    }
  });
}

async function ensureNetworkBuffer(tab) {
  if (tab._networkBuffer) {
    return;
  }
  tab._networkBuffer = [];
  const conn = await tab.conn();
  await conn.send("Network.enable").catch(() => {});
  conn.on("Network.requestWillBeSent", (params) => {
    tab._networkBuffer.push({
      ts: params.timestamp,
      id: params.requestId,
      phase: "sent",
      method: params.request?.method,
      url: params.request?.url,
      type: params.type,
      initiator: params.initiator?.type,
    });
    if (tab._networkBuffer.length > 500) {
      tab._networkBuffer.shift();
    }
  });
  conn.on("Network.responseReceived", (params) => {
    tab._networkBuffer.push({
      ts: params.timestamp,
      id: params.requestId,
      phase: "response",
      status: params.response?.status,
      url: params.response?.url,
      mime: params.response?.mimeType,
      from: params.response?.fromServiceWorker
        ? "sw"
        : params.response?.fromDiskCache
          ? "cache"
          : "network",
    });
    if (tab._networkBuffer.length > 500) {
      tab._networkBuffer.shift();
    }
  });
  conn.on("Network.loadingFailed", (params) => {
    tab._networkBuffer.push({
      ts: params.timestamp,
      id: params.requestId,
      phase: "failed",
      error: params.errorText,
      canceled: params.canceled,
    });
    if (tab._networkBuffer.length > 500) {
      tab._networkBuffer.shift();
    }
  });
}

export async function readConsole(
  tab,
  { pattern, onlyErrors = false, limit = 100, clear = false } = {},
) {
  await ensureConsoleBuffer(tab);
  let entries = tab._consoleBuffer.slice();
  if (onlyErrors) {
    entries = entries.filter(
      (e) => e.type === "error" || e.type === "exception" || e.type === "warn",
    );
  }
  if (pattern) {
    const re = new RegExp(pattern);
    entries = entries.filter((e) => re.test(e.text ?? ""));
  }
  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }
  if (clear) {
    tab._consoleBuffer.length = 0;
  }
  return entries;
}

export async function readNetwork(tab, { urlPattern, limit = 100, clear = false, phase } = {}) {
  await ensureNetworkBuffer(tab);
  let entries = tab._networkBuffer.slice();
  if (phase) {
    entries = entries.filter((e) => e.phase === phase);
  }
  if (urlPattern) {
    entries = entries.filter((e) => typeof e.url === "string" && e.url.includes(urlPattern));
  }
  if (entries.length > limit) {
    entries = entries.slice(-limit);
  }
  if (clear) {
    tab._networkBuffer.length = 0;
  }
  return entries;
}

// ---- Accessibility tree -----------------------------------------------

export async function getAXTree(tab, { filter = "all", maxNodes = 1000 } = {}) {
  const conn = await tab.conn();
  await conn.send("Accessibility.enable").catch(() => {});
  const res = await conn.send("Accessibility.getFullAXTree");
  let nodes = res.nodes ?? [];
  if (filter === "interactive") {
    const interactiveRoles = new Set([
      "button",
      "link",
      "textbox",
      "combobox",
      "checkbox",
      "radio",
      "menuitem",
      "tab",
      "searchbox",
      "listbox",
      "option",
    ]);
    nodes = nodes.filter((n) => interactiveRoles.has(n.role?.value));
  }
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
  }
  // Flatten for serialization — drop heavy fields.
  return nodes.map((n) => ({
    nodeId: n.nodeId,
    role: n.role?.value,
    name: n.name?.value,
    value: n.value?.value,
    description: n.description?.value,
    childIds: n.childIds,
    backendDOMNodeId: n.backendDOMNodeId,
  }));
}

// ---- Page text (readability-style) ------------------------------------

export async function getPageText(tab, { limit = 100000 } = {}) {
  const code = `
    var candidates = [document.querySelector('article'), document.querySelector('main'),
                      document.querySelector('[role="main"]'), document.body].filter(Boolean);
    var best = candidates[0];
    var bestLen = (best && best.innerText ? best.innerText.length : 0);
    for (var i = 1; i < candidates.length; i++) {
      var c = candidates[i];
      var len = (c.innerText || '').length;
      if (len > bestLen) { best = c; bestLen = len; }
    }
    if (!best) return null;
    var title = document.title || (document.querySelector('h1') ? document.querySelector('h1').innerText : '');
    var byline = (function(){
      var el = document.querySelector('[rel="author"]') || document.querySelector('.byline') || document.querySelector('[itemprop="author"]');
      return el ? el.innerText : null;
    })();
    var pubDate = (function(){
      var el = document.querySelector('time[datetime]') || document.querySelector('[itemprop="datePublished"]');
      return el ? (el.getAttribute('datetime') || el.innerText) : null;
    })();
    var text = (best.innerText || '').trim().replace(/\\n{3,}/g, '\\n\\n');
    return { title: title, byline: byline, pubDate: pubDate, text: text.slice(0, ${limit}), chars: text.length, url: location.href };
  `;
  const res = await evalInTab(tab, code);
  if (!res.ok) {
    throw new Error(`getPageText: ${res.error}`);
  }
  return res.value;
}

// ---- Find elements (natural-language heuristic, LLM-pluggable) --------

// Strategy: attempt CSS selectors from common intents, then text-content
// contains match, then ARIA role+name match. Returns up to 20 candidates
// with { tag, text, id, cls, rect, refHint }. `refHint` is a stable
// CSS-selector fingerprint the caller can use with click/formInput.
export async function findElements(tab, query, { limit = 20 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) {
    return [];
  }
  const code = `
    var q = ${JSON.stringify(q.toLowerCase())};
    var matches = [];
    var intents = [
      ['search bar', ['input[type="search"]', 'input[aria-label*="search" i]', '[role="search"] input', 'textarea[placeholder*="search" i]']],
      ['send button', ['button[data-testid="send-button"]', 'button[aria-label*="send" i]', 'button[type="submit"]']],
      ['composer', ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea[placeholder*="ask" i]', 'textarea']],
      ['login button', ['button[data-testid="login-button"]', 'a[href*="/auth/login"]', 'a[href*="/login"]']],
      ['close button', ['button[aria-label*="close" i]', '[data-testid*="close"]']],
    ];
    function rectOf(el) {
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    function cssOf(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
      var path = [];
      var cur = el;
      for (var d = 0; d < 4 && cur && cur.tagName !== 'BODY'; d++) {
        var sel = cur.tagName.toLowerCase();
        if (cur.className && typeof cur.className === 'string') {
          var cls = cur.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
          if (cls) sel += '.' + cls;
        }
        path.unshift(sel);
        cur = cur.parentElement;
      }
      return path.join(' > ');
    }
    // Try intent selectors first if query matches a known intent name.
    for (var i = 0; i < intents.length; i++) {
      var name = intents[i][0], selectors = intents[i][1];
      if (q.includes(name)) {
        for (var s = 0; s < selectors.length; s++) {
          var els = document.querySelectorAll(selectors[s]);
          for (var j = 0; j < els.length && matches.length < ${limit}; j++) {
            var el = els[j];
            if (el.offsetParent === null) continue;
            matches.push({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120), id: el.id || null, cls: String(el.className || '').slice(0, 80), rect: rectOf(el), refHint: cssOf(el), source: 'intent' });
          }
        }
      }
    }
    // Fallback: text contains match on visible clickables.
    if (matches.length < ${limit}) {
      var clickables = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"]');
      for (var k = 0; k < clickables.length && matches.length < ${limit}; k++) {
        var e = clickables[k];
        if (e.offsetParent === null) continue;
        var txt = (e.innerText || e.getAttribute('aria-label') || e.title || '').toLowerCase();
        if (txt.includes(q)) {
          matches.push({ tag: e.tagName.toLowerCase(), text: (e.innerText || '').slice(0, 120), id: e.id || null, cls: String(e.className || '').slice(0, 80), rect: rectOf(e), refHint: cssOf(e), source: 'text' });
        }
      }
    }
    return matches;
  `;
  const res = await evalInTab(tab, code);
  if (!res.ok) {
    throw new Error(`findElements: ${res.error}`);
  }
  return res.value ?? [];
}

export async function findInPage(tab, query, { index = 0 } = {}) {
  const code = `
    var q = ${JSON.stringify(query)};
    var body = document.body.innerText || '';
    var positions = [];
    var lower = body.toLowerCase();
    var qLower = q.toLowerCase();
    var pos = 0;
    while ((pos = lower.indexOf(qLower, pos)) !== -1) { positions.push(pos); pos += qLower.length; }
    if (positions.length === 0) return { matches: 0 };
    var target = ${index};
    if (target >= positions.length) target = 0;
    var desiredPos = positions[target];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var cur = 0;
    var node;
    while ((node = walker.nextNode())) {
      var len = node.textContent.length;
      if (cur + len > desiredPos) {
        var el = node.parentElement;
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (el) { var prev = el.style.backgroundColor; el.style.backgroundColor = 'yellow'; setTimeout(function(){ el.style.backgroundColor = prev; }, 1500); }
        return { matches: positions.length, atIndex: target, tag: el ? el.tagName.toLowerCase() : null };
      }
      cur += len;
    }
    return { matches: positions.length, atIndex: target };
  `;
  const res = await evalInTab(tab, code);
  if (!res.ok) {
    throw new Error(`findInPage: ${res.error}`);
  }
  return res.value;
}

// ---- Search across open tabs ------------------------------------------

export async function searchOpenTabs(query, { limit = 10 } = {}) {
  const tabs = await listTabs();
  const hits = [];
  for (const t of tabs.slice(0, 30)) {
    try {
      const res = await evalInTab(
        t,
        `
        var t = document.body.innerText || '';
        var q = ${JSON.stringify(String(query))};
        var i = t.toLowerCase().indexOf(q.toLowerCase());
        if (i === -1) return null;
        return { match: t.substring(Math.max(0, i - 60), Math.min(t.length, i + 120)), position: i, total: t.length };
      `,
      );
      if (res.ok && res.value) {
        hits.push({
          id: t.id,
          url: t.url,
          title: t.title,
          snippet: res.value.match,
          position: res.value.position,
          total: res.value.total,
        });
      }
      if (hits.length >= limit) {
        break;
      }
    } catch {
      /* skip un-evaluable tabs (about:blank, extension tabs) */
    } finally {
      t.close();
    }
  }
  return hits;
}

#!/usr/bin/env node
// Apex Chrome Lib — shared AppleScript-based drive primitives for every
// Chrome-web worker in the Apex stack (research-chatgpt-chat,
// research-gemini-chat, research-perplexity-chat, etc.).
//
// Sovereignty guarantee: pure osascript + Chrome AppleScript dictionary
// + `execute javascript`. No subprocess to claude, no Claude-in-Chrome
// extension, no third-party dependencies. Runs in any node context —
// daemon, launchd, subprocess, interactive.
//
// Pre-req (one-time): Chrome menu → View → Developer → Allow
// JavaScript from Apple Events must be enabled. apex-flags-probe.mjs
// reports status; fleet-coordinator surfaces degradation.
//
// Exports:
//   escAS(str)
//   runAppleScript(script, opts)
//   findOrOpenTab({ urlMatch, createUrl })
//   evalInTab(target, code)
//   waitForPageReady(target, opts)
//   keystrokeReturn()                       — System Events fallback for stubborn send buttons
//   pollUntilStable({ target, read, opts }) — generic stability-based poller

import { spawn } from "node:child_process";

export function escAS(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function runAppleScript(script, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    p.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || "spawn failed" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Find a tab whose URL contains `urlMatch`. If none, create a new tab
// navigating to `createUrl` (falls back to `urlMatch` when `createUrl`
// is omitted). Returns { winIdx, tabIdx, target, created }.
export async function findOrOpenTab({ urlMatch, createUrl } = {}) {
  if (!urlMatch) {
    throw new Error("findOrOpenTab: urlMatch required");
  }
  const findScript = `
set out to ""
tell application "Google Chrome"
  repeat with wIdx from 1 to count windows
    set tabs_ to tabs of window wIdx
    repeat with tIdx from 1 to count tabs_
      set t to item tIdx of tabs_
      try
        if URL of t contains "${escAS(urlMatch)}" then
          set out to (wIdx as string) & "," & (tIdx as string)
          exit repeat
        end if
      end try
    end repeat
    if out is not "" then exit repeat
  end repeat
end tell
return out
`;
  const find = await runAppleScript(findScript);
  if (find.ok && find.stdout) {
    const [w, t] = find.stdout.split(",").map(Number);
    await runAppleScript(`
tell application "Google Chrome"
  activate
  set index of window ${w} to 1
  set active tab index of window ${w} to ${t}
end tell
`);
    return { winIdx: w, tabIdx: t, target: `tab ${t} of window ${w}`, created: false };
  }
  const url = createUrl ?? `https://${urlMatch}/`;
  const newTabScript = `
tell application "Google Chrome"
  activate
  if (count windows) = 0 then make new window
  set newTab to make new tab at end of tabs of front window with properties {URL:"${escAS(url)}"}
  set activeIdx to count tabs of front window
  set active tab index of front window to activeIdx
  return "1," & (activeIdx as string)
end tell
`;
  const created = await runAppleScript(newTabScript);
  if (!created.ok) {
    throw new Error(`findOrOpenTab: could not open tab at ${url}: ${created.stderr.slice(0, 200)}`);
  }
  const [w, t] = created.stdout.split(",").map(Number);
  return { winIdx: w, tabIdx: t, target: `tab ${t} of window ${w}`, created: true };
}

// Execute `code` as a JS function body in `target`. Wraps in a JSON
// stringifier so results come back structured. Returns { ok, value } or
// { ok:false, error }. Recognizes the "Allow JS from Apple Events" gate
// and surfaces the fix in the error.
export async function evalInTab(target, code) {
  const wrapped = `(function(){ try { var __r = (function(){ ${code} })(); return JSON.stringify({ok:true, value:__r}); } catch (e) { return JSON.stringify({ok:false, error:String(e)}); } })();`;
  const script = `
tell application "Google Chrome"
  tell ${target}
    set r to execute javascript "${escAS(wrapped)}"
  end tell
end tell
return r
`;
  const res = await runAppleScript(script, { timeoutMs: 30000 });
  if (!res.ok) {
    const hint =
      res.stderr.includes("Allow JavaScript from Apple Events") || res.stderr.includes("-10004")
        ? " — Enable Chrome menu: View → Developer → Allow JavaScript from Apple Events."
        : "";
    return { ok: false, error: (res.stderr.slice(0, 240) || "no output") + hint };
  }
  try {
    return JSON.parse(res.stdout || "{}");
  } catch {
    return { ok: true, value: res.stdout };
  }
}

// Poll until document.readyState === "complete" AND URL matches the
// expected substring.
export async function waitForPageReady(target, { timeoutMs = 15000, urlIncludes } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await evalInTab(
      target,
      `return { ready: document.readyState, url: location.href };`,
    );
    if (res.ok) {
      const v = res.value ?? {};
      const urlOk = urlIncludes ? String(v.url ?? "").includes(urlIncludes) : true;
      if (v.ready === "complete" && urlOk) {
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// System Events keystroke fallback when a page's send button ignores
// click() or isn't found. Presses Return in the frontmost Chrome tab.
// Requires Accessibility permission on the running process.
export async function keystrokeReturn() {
  return await runAppleScript(
    `tell application "System Events" to tell process "Google Chrome" to key code 36`,
  );
}

// Generic stability poller. Reads `read(target) -> { text, streaming }`
// at 1.5s cadence; returns the stabilized `text` after
// `stableTicksRequired` unchanged reads with `streaming === false`.
// If streaming was never observed (fast replies), requires
// stableTicksRequired + 1 reads to reduce false-early returns.
export async function pollUntilStable({
  target,
  read,
  timeoutMs = 180_000,
  stableTicksRequired = 2,
  tickMs = 1500,
  stabilityFallbackTicks = 6,
  minFallbackChars = 200,
  growthThreshold = 80,
} = {}) {
  if (!target || typeof read !== "function") {
    throw new Error("pollUntilStable: target + read required");
  }
  const t0 = Date.now();
  let lastLen = -1;
  let stableTicks = 0;
  let fallbackTicks = 0;
  let sawStreaming = false;
  let sawGrowth = false;
  while (Date.now() - t0 < timeoutMs) {
    const v = await read(target);
    const len = v?.text ? String(v.text).length : 0;
    if (v?.streaming) {
      sawStreaming = true;
    }
    if (len >= growthThreshold) {
      sawGrowth = true;
    }
    if (!v?.streaming && len > 0 && len === lastLen) {
      stableTicks += 1;
      if (sawStreaming && stableTicks >= stableTicksRequired) {
        return String(v.text);
      }
      if (!sawStreaming && stableTicks >= stableTicksRequired + 1) {
        return String(v.text);
      }
    } else {
      stableTicks = 0;
    }
    // Streaming-flag-independent fallback. Now requires BOTH min
    // meaningful length AND saw-growth before exit — fixes the
    // "exits on 17-char header" failure that hit claude-ai.
    if (len >= minFallbackChars && sawGrowth && len === lastLen) {
      fallbackTicks += 1;
      if (fallbackTicks >= stabilityFallbackTicks) {
        process.stderr.write(
          `[pollUntilStable] fallback exit after ${fallbackTicks} stable ticks (streaming flag: ${v?.streaming ? "stuck-on" : "off"}, len=${len})\n`,
        );
        return String(v.text);
      }
    } else {
      fallbackTicks = 0;
    }
    lastLen = len;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error(`pollUntilStable timed out after ${timeoutMs}ms`);
}

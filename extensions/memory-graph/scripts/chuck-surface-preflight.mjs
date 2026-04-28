#!/usr/bin/env node
// Chuck surface preflight — cheap readiness probe before Fleet dispatch.
//
// This is intentionally not an LLM call. It checks the local substrate that
// determines whether GUI/app/web surfaces can be driven at all: macOS
// Accessibility, region screenshots, Chrome Apple Events, app installation,
// open web tabs, CLI binaries, and Ollama service state.

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPEN_TABS = [
  "https://chatgpt.com/",
  "https://claude.ai/new",
  "https://gemini.google.com/app",
  "https://aistudio.google.com/prompts/new_chat",
  "https://grok.com/",
];

const APP_SURFACES = [
  {
    id: "chrome",
    name: "Google Chrome",
    requiredFor: ["chatgpt-web", "claude-ai-web", "gemini-web", "gemini-studio", "grok"],
  },
  { id: "claude-mac", name: "Claude", requiredFor: ["claude-ai/mac-app"] },
  { id: "perplexity-mac", name: "Perplexity", requiredFor: ["perplexity/mac-app-incognito"] },
  { id: "chatgpt-mac", name: "ChatGPT", requiredFor: ["chatgpt/mac-app"] },
  { id: "gemini-pwa", name: "Gemini", requiredFor: ["gemini/pwa"] },
];

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 8000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    error: r.error ? (r.error.message ?? r.error) : "",
  };
}

function osa(script, opts = {}) {
  return run("/usr/bin/osascript", ["-e", script], opts);
}

function commandExists(bin) {
  const r = run("/bin/zsh", ["-lc", `command -v ${JSON.stringify(bin)} 2>/dev/null`], {
    timeoutMs: 3000,
  });
  return r.ok && r.stdout.length > 0;
}

function appBundleId(name) {
  const r = osa(`id of app ${JSON.stringify(name)}`, { timeoutMs: 3000 });
  return r.ok ? r.stdout : null;
}

function chromeTabs() {
  const r = osa(
    `tell application "Google Chrome"
       set out to ""
       if (count of windows) = 0 then return out
       repeat with w in windows
         repeat with t in tabs of w
           set out to out & (URL of t as text) & "\\n"
         end repeat
       end repeat
       return out
     end tell`,
    { timeoutMs: 5000 },
  );
  if (!r.ok) {
    return { ok: false, error: r.stderr || r.error, urls: [] };
  }
  return {
    ok: true,
    urls: r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function chromeAppleEventsJs() {
  const r = osa(
    `tell application "Google Chrome" to tell active tab of front window to execute javascript "JSON.stringify({title:document.title,url:location.href})"`,
    { timeoutMs: 5000 },
  );
  return { ok: r.ok, detail: r.ok ? r.stdout : r.stderr || r.error };
}

function accessibilityEnabled() {
  const r = osa(`tell application "System Events" to get UI elements enabled`, { timeoutMs: 5000 });
  return { ok: r.ok && r.stdout === "true", raw: r.stdout || r.stderr || r.error };
}

function screenshotProbe() {
  const full = join(tmpdir(), `chuck-preflight-full-${process.pid}.png`);
  const region = join(tmpdir(), `chuck-preflight-region-${process.pid}.png`);
  const fullRun = run("/usr/sbin/screencapture", ["-x", full], { timeoutMs: 8000 });
  const regionRun = run("/usr/sbin/screencapture", ["-x", "-R", "1,1,20,20", region], {
    timeoutMs: 8000,
  });
  const out = {
    full: fullRun.ok && existsSync(full),
    region: regionRun.ok && existsSync(region),
    fullError: fullRun.ok ? "" : fullRun.stderr || fullRun.error,
    regionError: regionRun.ok ? "" : regionRun.stderr || regionRun.error,
  };
  for (const p of [full, region]) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function ollamaStatus() {
  const list = run("ollama", ["list"], { timeoutMs: 5000 });
  const ps = run("ollama", ["ps"], { timeoutMs: 5000 });
  return {
    installed: commandExists("ollama"),
    responsive: list.ok,
    runningModels: ps.ok ? ps.stdout.split("\n").slice(1).filter(Boolean).length : 0,
    models: list.ok
      ? list.stdout
          .split("\n")
          .slice(1)
          .map((s) => s.trim().split(/\s+/)[0])
          .filter(Boolean)
      : [],
    error: list.ok ? "" : list.stderr || list.error,
  };
}

function openSurfaces() {
  run("/usr/bin/open", ["-a", "Google Chrome"], { timeoutMs: 5000 });
  run("/usr/bin/open", ["-a", "Claude"], { timeoutMs: 5000 });
  run("/usr/bin/open", ["-a", "Perplexity"], { timeoutMs: 5000 });
  const script = `
    tell application "Google Chrome"
      activate
      if (count of windows) = 0 then make new window
      set bounds of front window to {40, 40, 1280, 900}
      set urls to ${JSON.stringify(OPEN_TABS)}
      repeat with u in urls
        set foundIt to false
        repeat with w in windows
          repeat with t in tabs of w
            if (URL of t as text) starts with (u as text) then set foundIt to true
          end repeat
        end repeat
        if foundIt is false then make new tab at end of tabs of front window with properties {URL:(u as text)}
      end repeat
    end tell`;
  osa(script, { timeoutMs: 8000 });
}

function classifySurface({ id, accessibility, screenshots, apps, tabs, chromeJs, ollama }) {
  switch (id) {
    case "claude-cli":
      return commandExists("claude") ? "ready" : "missing-cli";
    case "codex":
    case "codex-review":
      return commandExists(`${process.env.HOME ?? ""}/.openclaw/bin/codex`) ||
        commandExists("codex")
        ? "ready"
        : "missing-cli";
    case "gemini-cli":
      return commandExists("gemini") ? "installed-quota-unknown" : "missing-cli";
    case "ollama-local":
      return ollama.responsive ? "ready" : "ollama-down";
    case "chatgpt-web":
      return chromeJs.ok && tabs.urls.some((u) => u.includes("chatgpt.com"))
        ? "ready-or-needs-chat-probe"
        : "needs-chrome-tab";
    case "claude-ai":
      return chromeJs.ok && tabs.urls.some((u) => u.includes("claude.ai"))
        ? accessibility.ok
          ? "mac-and-web-available"
          : "web-available-mac-app-blocked-by-accessibility"
        : "needs-claude-tab";
    case "gemini-web":
      return chromeJs.ok && tabs.urls.some((u) => u.includes("gemini.google.com"))
        ? "ready-or-needs-chat-probe"
        : "needs-gemini-tab";
    case "gemini-studio":
      return chromeJs.ok && tabs.urls.some((u) => u.includes("aistudio.google.com"))
        ? "ready-or-entitlement-unverified"
        : "needs-aistudio-tab";
    case "grok":
      return chromeJs.ok && tabs.urls.some((u) => u.includes("grok.com"))
        ? "ready-or-needs-login/probe"
        : "needs-grok-tab";
    case "perplexity-mac":
      if (!apps["perplexity-mac"]) {
        return "missing-app";
      }
      if (!accessibility.ok) {
        return "blocked-by-accessibility";
      }
      if (!screenshots.region) {
        return "blocked-by-screen-capture-region";
      }
      return "ready-or-needs-chat-probe";
    default:
      return "unknown";
  }
}

function main() {
  const shouldOpen = process.argv.includes("--open");
  const asJson = process.argv.includes("--json");
  if (shouldOpen) {
    openSurfaces();
  }

  const accessibility = accessibilityEnabled();
  const screenshots = screenshotProbe();
  const tabs = chromeTabs();
  const chromeJs = chromeAppleEventsJs();
  const apps = Object.fromEntries(APP_SURFACES.map((app) => [app.id, !!appBundleId(app.name)]));
  const appBundleIds = Object.fromEntries(
    APP_SURFACES.map((app) => [app.id, appBundleId(app.name)]),
  );
  const ollama = ollamaStatus();
  const voices = [
    "claude-cli",
    "claude-ai",
    "chatgpt-web",
    "codex",
    "codex-review",
    "gemini-cli",
    "gemini-web",
    "gemini-studio",
    "grok",
    "perplexity-mac",
    "ollama-local",
  ].map((id) => ({
    id,
    status: classifySurface({ id, accessibility, screenshots, apps, tabs, chromeJs, ollama }),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    openedSurfaces: shouldOpen,
    mac: {
      accessibility,
      screenshots,
    },
    chrome: {
      appleEventsJavascript: chromeJs,
      tabCount: tabs.urls.length,
      tabs: tabs.urls,
    },
    apps: appBundleIds,
    ollama,
    voices,
    caveats: [
      !accessibility.ok
        ? "Mac-app GUI drivers that use System Events/cliclick are blocked until Accessibility is enabled for this runner."
        : null,
      !screenshots.region
        ? "Screenshot-region OCR/vision drivers are blocked; Perplexity incognito verification and local UI OCR will fail."
        : null,
      "AI Studio entitlement must be treated as unverified unless the model-selector DOM or a successful response receipt proves Pro; do not infer free-tier from a failed DOM probe.",
    ].filter(Boolean),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`# Chuck Surface Preflight — ${report.generatedAt}`);
  console.log("");
  console.log(
    `Accessibility: ${accessibility.ok ? "ok" : `blocked (${accessibility.raw || "unknown"})`}`,
  );
  console.log(
    `Screenshot full/region: ${screenshots.full ? "ok" : "blocked"} / ${screenshots.region ? "ok" : "blocked"}`,
  );
  console.log(`Chrome AppleEvents JS: ${chromeJs.ok ? "ok" : "blocked"}`);
  console.log(`Chrome tabs: ${tabs.urls.length}`);
  console.log(
    `Ollama: ${ollama.responsive ? `ready (${ollama.models.join(", ") || "no models"})` : `down (${ollama.error || "unknown"})`}`,
  );
  console.log("");
  for (const voice of voices) {
    console.log(`- ${voice.id}: ${voice.status}`);
  }
  if (report.caveats.length) {
    console.log("");
    console.log("Caveats:");
    for (const caveat of report.caveats) {
      console.log(`- ${caveat}`);
    }
  }
}

main();

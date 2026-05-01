// HTTP route handlers for @openclaw/plugin-chuck-pwa.
//
// All handlers conform to openclaw's registerHttpRoute contract:
//   handler: async (req, res) => boolean
// Return true when the route handled the request.
//
// Path scheme:
//   /chuck-v3/chat.html              — chat surface (the new MVP UI)
//   /chuck-v3/                       — React cockpit (legacy)
//   /chuck-v3/<file>                 — static assets under PWA dir
//   /api/chuck-v3/voices             — voice catalog (GET)
//   /api/chuck-v3/ask                — chat dispatch (POST)
//   /api/chuck-v3/health             — server liveness (GET)

import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { runPanelAsk } from "../../skill-panel-ask/api.js";
import type { ChuckPwaConfig } from "./config.js";
import { buildChuckPreamble } from "./persona.js";
import type { AskRequestBody, AskResponse, VoicesResponse } from "./types.js";
import { findVoice, PWA_VOICES } from "./voices.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_BODY_BYTES = 256 * 1024;
const CORS_ORIGIN = "*";

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setSecurityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

export interface RouteContext {
  config: ChuckPwaConfig;
  pwaDir: string;
}

// ─── /api/chuck-v3/health ──────────────────────────────────────────────────
export function makeHealthHandler(_ctx: RouteContext) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    sendJson(res, 200, {
      ok: true,
      plugin: "@openclaw/plugin-chuck-pwa",
      uptimeSec: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    });
    return true;
  };
}

// ─── /api/chuck-v3/voices ──────────────────────────────────────────────────
export function makeVoicesHandler(ctx: RouteContext) {
  return async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const body: VoicesResponse = {
      voices: [...PWA_VOICES],
      defaultVoice: ctx.config.defaultVoice,
      updatedAt: new Date().toISOString(),
    };
    sendJson(res, 200, body);
    return true;
  };
}

// ─── /api/chuck-v3/ask ─────────────────────────────────────────────────────
//
// Salvaged from chuck-pwa-server.mjs handleAsk — but instead of subprocess-
// spawning apex-panel-ask.mjs, we call runPanelAsk() directly through the
// skill-panel-ask programmatic API. That's the architectural payoff of
// re-housing inside openclaw: no subprocess hop, no spawn-and-parse-stdout
// dance, no plugin-cold-start tax. When skill-panel-ask v0.x lifts more
// voice drivers into TS (Option 4 already covered the 4 CLI voices), the
// dispatch path keeps getting faster without changing this code.
export function makeAskHandler(ctx: RouteContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let body: AskRequestBody;
    try {
      body = await readJsonBody<AskRequestBody>(req);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
      return true;
    }
    const voiceId = typeof body.voice === "string" ? body.voice.trim() : "";
    const userPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const label =
      typeof body.label === "string" && body.label.trim() ? body.label.trim() : "CHUCK-PWA";
    if (!voiceId) {
      sendError(res, 400, "voice required");
      return true;
    }
    if (!userPrompt) {
      sendError(res, 400, "prompt required");
      return true;
    }
    const voiceMeta = findVoice(voiceId);
    if (!voiceMeta) {
      sendError(res, 400, `unknown voice: ${voiceId}`);
      return true;
    }

    const preamble = await buildChuckPreamble(ctx.config);
    const fullPrompt = preamble + userPrompt;

    const start = Date.now();
    const result = await runPanelAsk({
      prompt: fullPrompt,
      voices: [voiceId],
      mode: "raw",
      label,
      suffix: "",
      timeoutMs: ctx.config.askTimeoutMs,
    });
    const ms = Date.now() - start;

    const voice0 = result.voices[0];
    if (!voice0 || !voice0.ok) {
      const askResp: AskResponse = {
        ok: false,
        voice: voiceId,
        label,
        ms,
        reply: "",
        replyPath: voice0?.path ?? null,
        chars: 0,
        transport: "cli",
        error:
          voice0?.error ?? (result.warnings?.join("; ") || "dispatch returned no voice result"),
      };
      sendJson(res, 502, askResp);
      return true;
    }

    let reply = "";
    if (voice0.path && existsSync(voice0.path)) {
      try {
        reply = readFileSync(voice0.path, "utf8");
      } catch (err) {
        const askResp: AskResponse = {
          ok: false,
          voice: voiceId,
          label,
          ms,
          reply: "",
          replyPath: voice0.path,
          chars: 0,
          transport: "cli",
          error: `read reply file failed: ${err instanceof Error ? err.message : String(err)}`,
        };
        sendJson(res, 500, askResp);
        return true;
      }
    }

    const transport: AskResponse["transport"] =
      voiceMeta.surface === "web-chrome" || voiceMeta.surface === "native-app"
        ? "chrome-driver"
        : "cli";

    const askResp: AskResponse = {
      ok: true,
      voice: voiceId,
      label,
      ms,
      reply,
      replyPath: voice0.path ?? null,
      chars: reply.length,
      transport,
      voiceMeta: voice0,
    };
    sendJson(res, 200, askResp);
    return true;
  };
}

// ─── static assets under /<routePrefix>/ ───────────────────────────────────
//
// Serves the chat.html (and any other PWA assets) from the workspace dir.
// SPA-style fallback: requests for paths that don't match a real file land
// on index.html so client-side routing keeps working.
export function makeStaticHandler(ctx: RouteContext, urlPrefix: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = (req.url ?? "/").split("?")[0].split("#")[0];
    let rel = url.startsWith(urlPrefix) ? url.slice(urlPrefix.length) : url;
    if (rel === "" || rel === "/") rel = "/index.html";
    const safeRel = rel.replace(/^\/+/, "");
    const resolved = normalize(join(ctx.pwaDir, safeRel));
    if (
      !resolved.startsWith(ctx.pwaDir + "/") &&
      resolved !== ctx.pwaDir &&
      resolved !== join(ctx.pwaDir, "index.html")
    ) {
      setSecurityHeaders(res);
      res.statusCode = 404;
      res.end("Path traversal denied");
      return true;
    }
    let target = resolved;
    if (!existsSync(target) || !statSync(target).isFile()) {
      target = join(ctx.pwaDir, "index.html");
      if (!existsSync(target)) {
        setSecurityHeaders(res);
        res.statusCode = 404;
        res.end(`PWA index missing at ${target}`);
        return true;
      }
    }
    const buf = readFileSync(target);
    const mime = MIME[extname(target)] ?? "application/octet-stream";
    setSecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
    return true;
  };
}

#!/usr/bin/env node
// Apex Chrome CDP GIF — screencast + GIF export.
//
// Absorbs Claude-in-Chrome `gif_creator`. Uses CDP Page.startScreencast
// to stream JPEG frames, writes them to a temp dir, then encodes with
// ffmpeg (if present). Defaults output to
// ~/.openclaw/workspace/screenshots/<timestamp>.gif
//
// Usage:
//   const rec = await startRecording(tab, { fps: 8 });
//   await doInteractions();
//   const { gif } = await stopAndExport(rec, { out: '/tmp/demo.gif' });
//
// Requires: ffmpeg on $PATH (brew install ffmpeg).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_OUT_DIR = join(homedir(), ".openclaw", "workspace", "screenshots");

function whichFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn("/usr/bin/which", ["ffmpeg"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c) => {
      out += c.toString();
    });
    p.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
    p.on("error", () => resolve(null));
  });
}

export async function startRecording(
  tab,
  { fps = 8, format = "jpeg", quality = 70, framesDir } = {},
) {
  const conn = await tab.conn();
  await conn.send("Page.enable").catch(() => {});
  const id = Date.now().toString(36);
  const dir = framesDir ?? join("/tmp", `apex-gif-${id}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const state = {
    tab,
    conn,
    dir,
    framesWritten: 0,
    lastFrameTs: 0,
    frameMinMs: Math.floor(1000 / fps),
    stopped: false,
  };
  conn.on("Page.screencastFrame", async (params) => {
    if (state.stopped) {
      return;
    }
    const now = Date.now();
    if (now - state.lastFrameTs < state.frameMinMs) {
      try {
        await conn.send("Page.screencastFrameAck", { sessionId: params.sessionId });
      } catch {
        /* ignore */
      }
      return;
    }
    state.lastFrameTs = now;
    const framePath = join(
      state.dir,
      `f${String(state.framesWritten).padStart(5, "0")}.${format === "jpeg" ? "jpg" : "png"}`,
    );
    try {
      writeFileSync(framePath, Buffer.from(params.data, "base64"));
      state.framesWritten += 1;
    } catch {
      /* drop frame */
    }
    try {
      await conn.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch {
      /* ignore */
    }
  });
  await conn.send("Page.startScreencast", { format, quality, everyNthFrame: 1 });
  return state;
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    p.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      }
    });
    p.on("error", reject);
  });
}

export async function stopAndExport(state, { out, fps = 8, keepFrames = false } = {}) {
  if (!state || state.stopped) {
    throw new Error("stopAndExport: invalid state");
  }
  state.stopped = true;
  try {
    await state.conn.send("Page.stopScreencast");
  } catch {
    /* may be closed */
  }
  if (state.framesWritten === 0) {
    if (!keepFrames) {
      try {
        rmSync(state.dir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
    throw new Error("stopAndExport: no frames captured");
  }
  const ff = await whichFfmpeg();
  const target = out ?? join(DEFAULT_OUT_DIR, `apex-${Date.now()}.gif`);
  if (!existsSync(DEFAULT_OUT_DIR)) {
    mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  }
  if (!ff) {
    return {
      ok: true,
      framesDir: state.dir,
      frames: state.framesWritten,
      gif: null,
      note: "ffmpeg not found — frames preserved. brew install ffmpeg to enable GIF export.",
    };
  }
  const palette = join(state.dir, "palette.png");
  await runFfmpeg(ff, [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(state.dir, "f%05d.jpg"),
    "-vf",
    `fps=${fps},scale=iw:ih:flags=lanczos,palettegen`,
    palette,
  ]);
  await runFfmpeg(ff, [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(state.dir, "f%05d.jpg"),
    "-i",
    palette,
    "-lavfi",
    `fps=${fps},scale=iw:ih:flags=lanczos [x]; [x][1:v] paletteuse`,
    target,
  ]);
  if (!keepFrames) {
    try {
      rmSync(state.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return { ok: true, gif: target, frames: state.framesWritten };
}

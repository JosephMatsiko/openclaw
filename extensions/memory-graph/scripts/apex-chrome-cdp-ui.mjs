#!/usr/bin/env node
// Apex Chrome CDP UI — absorbs every pixel/mouse/screenshot capability
// from Claude-in-Chrome into sovereign CDP calls.
//
// Maps Claude-in-Chrome → apex-chrome-cdp-ui:
//   computer(left_click)     → click(tab, coord, {modifiers})
//   computer(right_click)    → click(tab, coord, {button: "right"})
//   computer(double_click)   → click(tab, coord, {count: 2})
//   computer(triple_click)   → click(tab, coord, {count: 3})
//   computer(hover)          → hover(tab, coord)
//   computer(left_click_drag)→ drag(tab, start, end)
//   computer(scroll)         → scroll(tab, direction, amount, coord?)
//   computer(screenshot)     → screenshot(tab, opts)
//   computer(zoom)           → zoomRegion(tab, region)
//   computer(type)           → already in apex-chrome-cdp (insertText)
//   computer(key)            → already in apex-chrome-cdp (dispatchKey,
//                              extended here to support modifiers + shortcuts)
//   form_input               → formInput(tab, selector, value)
//   file_upload              → uploadFiles(tab, selector, paths)
//   resize_window            → resizeWindow(tab, width, height)
//
// All pixel coordinates are CSS pixels from the viewport origin.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { evalInTab } from "./apex-chrome-cdp.mjs";

// ---- Input: click / hover / scroll / drag / key with modifiers -------

const KEY_MODIFIERS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

function modifiersToBitmask(mod) {
  if (!mod) {
    return 0;
  }
  return String(mod)
    .toLowerCase()
    .split("+")
    .map((m) => m.trim())
    .filter(Boolean)
    .reduce((acc, m) => acc | (KEY_MODIFIERS[m] ?? 0), 0);
}

export async function click(tab, { coordinate, modifiers, button = "left", count = 1 } = {}) {
  if (!Array.isArray(coordinate) || coordinate.length !== 2) {
    throw new Error("click: coordinate [x, y] required");
  }
  const conn = await tab.conn();
  const [x, y] = coordinate;
  const bits = modifiersToBitmask(modifiers);
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    modifiers: bits,
  });
  for (let i = 0; i < count; i += 1) {
    await conn.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "right" ? 2 : 1,
      clickCount: i + 1,
      modifiers: bits,
    });
    await conn.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: i + 1,
      modifiers: bits,
    });
  }
}

export async function hover(tab, { coordinate } = {}) {
  if (!Array.isArray(coordinate)) {
    throw new Error("hover: coordinate [x, y] required");
  }
  const conn = await tab.conn();
  const [x, y] = coordinate;
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    modifiers: 0,
  });
}

export async function drag(tab, { start, end, button = "left", modifiers } = {}) {
  if (!Array.isArray(start) || !Array.isArray(end)) {
    throw new Error("drag: start [x, y] and end [x, y] required");
  }
  const conn = await tab.conn();
  const bits = modifiersToBitmask(modifiers);
  await conn.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start[0],
    y: start[1],
    button,
    buttons: button === "right" ? 2 : 1,
    clickCount: 1,
    modifiers: bits,
  });
  // Interpolate a few intermediate mousemove events so the page sees a real drag.
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = start[0] + (end[0] - start[0]) * t;
    const y = start[1] + (end[1] - start[1]) * t;
    await conn.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button,
      buttons: button === "right" ? 2 : 1,
      modifiers: bits,
    });
  }
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end[0],
    y: end[1],
    button,
    buttons: 0,
    clickCount: 1,
    modifiers: bits,
  });
}

export async function scroll(
  tab,
  { direction = "down", amount = 400, coordinate = [400, 400], modifiers } = {},
) {
  const conn = await tab.conn();
  const [x, y] = coordinate;
  let deltaX = 0;
  let deltaY = 0;
  if (direction === "up") {
    deltaY = -amount;
  } else if (direction === "down") {
    deltaY = amount;
  } else if (direction === "left") {
    deltaX = -amount;
  } else if (direction === "right") {
    deltaX = amount;
  }
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
    modifiers: modifiersToBitmask(modifiers),
  });
}

// Keystroke with optional modifiers — handles shortcuts like cmd+a.
const VKEY_MAP = {
  Enter: 13,
  Return: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

export async function keyCombo(tab, combo) {
  const conn = await tab.conn();
  // Format: "cmd+a", "shift+Tab", "Enter"
  const parts = String(combo)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const keyName = parts[parts.length - 1];
  const modKeys = parts.slice(0, -1);
  const modifiers = modifiersToBitmask(modKeys.join("+"));
  const windowsVirtualKeyCode = VKEY_MAP[keyName];
  const isChar = keyName.length === 1;
  const event = {
    key: keyName,
    code: windowsVirtualKeyCode ? keyName : `Key${keyName.toUpperCase()}`,
    windowsVirtualKeyCode: windowsVirtualKeyCode ?? (isChar ? keyName.charCodeAt(0) : 0),
    modifiers,
  };
  if (isChar && modifiers === 0) {
    event.text = keyName;
  }
  await conn.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
}

// ---- Screenshot / zoom ------------------------------------------------

export async function screenshot(
  tab,
  { format = "png", quality, fullPage = false, clip, savePath } = {},
) {
  const conn = await tab.conn();
  const params = { format };
  if (format === "jpeg" && typeof quality === "number") {
    params.quality = quality;
  }
  if (fullPage) {
    params.captureBeyondViewport = true;
  }
  if (clip) {
    params.clip = { scale: 1, ...clip };
  }
  const res = await conn.send("Page.captureScreenshot", params);
  const buf = Buffer.from(res.data, "base64");
  if (savePath) {
    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(savePath, buf);
    return { path: savePath, bytes: buf.length, format };
  }
  return { base64: res.data, bytes: buf.length, format };
}

// Zoom = screenshot of a specific rectangle. Output: cropped image.
// `region` is {x, y, width, height} in viewport CSS pixels.
export async function zoomRegion(tab, { region, savePath } = {}) {
  if (!region) {
    throw new Error("zoomRegion: region {x, y, width, height} required");
  }
  const clip = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };
  return await screenshot(tab, { format: "png", clip, savePath });
}

// ---- Form helpers -----------------------------------------------------

// Set a form value by CSS selector. Handles input/textarea/select/
// contenteditable uniformly. Dispatches input+change events so React/
// Vue/Svelte pick up the change.
export async function formInput(tab, { selector, value } = {}) {
  if (!selector || value === undefined) {
    throw new Error("formInput: selector + value required");
  }
  const code = `
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: "selector not found" };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      var setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value') &&
                   Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      if (setter) setter.call(el, ${JSON.stringify(String(value))});
      else el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.getAttribute('contenteditable') === 'true') {
      while (el.firstChild) el.removeChild(el.firstChild);
      if (document.execCommand) {
        el.focus();
        document.execCommand('insertText', false, ${JSON.stringify(String(value))});
      } else {
        el.innerText = ${JSON.stringify(String(value))};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(String(value))} }));
      }
    } else {
      return { ok: false, error: "element not editable" };
    }
    return { ok: true, tag: el.tagName, id: el.id, value: el.value || el.innerText };
  `;
  const res = await evalInTab(tab, code);
  if (!res.ok) {
    throw new Error(`formInput eval: ${res.error}`);
  }
  if (res.value?.ok === false) {
    throw new Error(`formInput: ${res.value.error}`);
  }
  return res.value;
}

// Set files on a file input via CDP DOM.setFileInputFiles.
export async function uploadFiles(tab, { selector, paths } = {}) {
  if (!selector || !Array.isArray(paths)) {
    throw new Error("uploadFiles: selector + paths[] required");
  }
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(`uploadFiles: file not found: ${p}`);
    }
  }
  const conn = await tab.conn();
  const { root } = await conn.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodeRes = await conn.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeRes.nodeId) {
    throw new Error(`uploadFiles: selector not found: ${selector}`);
  }
  await conn.send("DOM.setFileInputFiles", {
    files: paths,
    nodeId: nodeRes.nodeId,
  });
  return { ok: true, nodeId: nodeRes.nodeId, uploaded: paths.length };
}

// Upload an image from a Buffer or a path to a drop-target at a
// coordinate. We write a temp file if given a Buffer, then use CDP's
// Input drop-event support. Simpler fallback: just use uploadFiles
// with a selector if available.
export async function uploadImageAt(tab, { imagePath, coordinate } = {}) {
  if (!imagePath) {
    throw new Error("uploadImageAt: imagePath required");
  }
  if (!existsSync(imagePath)) {
    throw new Error(`uploadImageAt: not found ${imagePath}`);
  }
  const conn = await tab.conn();
  // Pre-read the file as base64 to stash into the page, then use a
  // File-from-fetch trick + a simulated DragEvent at the coord.
  const b64 = readFileSync(imagePath).toString("base64");
  const code = `
    (async () => {
      const b64 = ${JSON.stringify(b64)};
      const filename = ${JSON.stringify(imagePath.split("/").pop())};
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], filename, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.elementFromPoint(${coordinate[0]}, ${coordinate[1]});
      if (!el) return { ok: false, error: 'no element at coord' };
      const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(evt);
      return { ok: true, target: el.tagName, files: 1 };
    })()
  `;
  const res = await conn.send("Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `uploadImageAt: ${res.exceptionDetails.exception?.description ?? "eval failed"}`,
    );
  }
  return res.result?.value ?? { ok: false };
}

// ---- Window control ---------------------------------------------------

export async function resizeWindow(tab, { width, height } = {}) {
  if (!width || !height) {
    throw new Error("resizeWindow: width + height required");
  }
  const conn = await tab.conn();
  // Browser.setWindowBounds needs the window id.
  try {
    const res = await conn.send("Browser.getWindowForTarget", { targetId: tab.id });
    await conn.send("Browser.setWindowBounds", {
      windowId: res.windowId,
      bounds: { width, height },
    });
    return { ok: true };
  } catch (err) {
    // Emulation fallback: change the viewport (doesn't resize the OS window
    // but sites see the new dimensions).
    await conn.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    return { ok: true, emulated: true, err: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Convenience Joseph-side shortcuts --------------------------------

export async function copyToClipboardFromPage(tab, { selector } = {}) {
  const code = selector
    ? `
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false };
      var text = el.innerText || el.value || "";
      navigator.clipboard.writeText(text).then(() => {}, () => {});
      return { ok: true, text: text.slice(0, 1000), length: text.length };
    `
    : `
      var text = getSelection().toString();
      if (!text) text = document.body.innerText;
      return { ok: true, text: text.slice(0, 1000), length: text.length };
    `;
  const res = await evalInTab(tab, code);
  if (!res.ok) {
    throw new Error(`copyToClipboardFromPage: ${res.error}`);
  }
  return res.value;
}

// Home directory constant for consumers that want to write screenshots
// into Joseph's standard workspace location.
export const WORKSPACE_SCREENSHOTS = join(homedir(), ".openclaw", "workspace", "screenshots");

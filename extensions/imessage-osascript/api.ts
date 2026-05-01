// Public API barrel for @openclaw/plugin-imessage-osascript.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export type { SendInput, SendResult } from "./src/types.js";
export { sendImessage } from "./src/send.js";
export { resolveConfig, type ImessageOsascriptConfig } from "./src/config.js";

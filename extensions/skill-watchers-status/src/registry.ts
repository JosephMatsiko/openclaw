// Default watcher registry — labels match what launchctl actually prints,
// busSources match what each script signs its bus events as.

import { homedir } from "node:os";
import { join } from "node:path";
import type { WatcherEntry } from "./types.js";

const HOME = homedir();
const STATE = join(HOME, ".openclaw", "workspace", "state");
const CHUCK_V3 = join(STATE, "chuck-v3");

export const DEFAULT_WATCHERS: WatcherEntry[] = [
  { label: "ai.openclaw.gateway", log: "gateway.err.log", busSource: null },
  {
    label: "com.openclaw.chuck-docket-executor",
    log: "chuck-docket-executor.err.log",
    busSource: "chuck-docket-executor",
    stateFile: join(CHUCK_V3, "executor-control.json"),
  },
  {
    label: "com.openclaw.chuck-dashboard",
    log: "chuck-dashboard.err.log",
    busSource: null,
  },
  {
    label: "com.openclaw.chuck-cascade-watcher",
    log: "chuck-cascade-watcher.err.log",
    busSource: "chuck-cascade-watcher",
    stateFile: join(CHUCK_V3, "cascade-watcher", "state.json"),
  },
  {
    label: "com.openclaw.chuck-decision-engine",
    log: "chuck-decision-engine.err.log",
    busSource: "chuck-decision-engine",
    stateFile: join(CHUCK_V3, "decisions", "last-scan.json"),
  },
  {
    label: "com.openclaw.chuck-introspect",
    log: "chuck-introspect.err.log",
    busSource: "chuck-introspect",
  },
  {
    label: "com.openclaw.chuck-mac-self-heal",
    log: "chuck-mac-self-heal.err.log",
    busSource: "chuck-mac-self-heal",
  },
  {
    label: "com.openclaw.chuck-morning-digest",
    log: "chuck-morning-digest.err.log",
    busSource: "chuck-morning-digest",
  },
  {
    label: "com.openclaw.chuck-self-improvement-scanner",
    log: "chuck-self-improvement-scanner.err.log",
    busSource: "chuck-self-improvement-scanner",
  },
  {
    label: "com.openclaw.apex-vanguard",
    log: "apex-vanguard.err.log",
    busSource: "apex-vanguard",
  },
  {
    label: "com.openclaw.apex-runtime-chooser",
    log: "apex-runtime-chooser.err.log",
    busSource: "apex-runtime-chooser",
    stateFile: join(CHUCK_V3, "runtime-chooser", "state.json"),
  },
  {
    label: "com.openclaw.chuck-pwa-server",
    log: "chuck-pwa-server.err.log",
    busSource: null,
  },
  {
    label: "com.openclaw.chuck-gateway-watchdog",
    log: "chuck-gateway-watchdog.err.log",
    busSource: "chuck-gateway-watchdog",
    stateFile: join(CHUCK_V3, "gateway-watchdog", "state.json"),
  },
];

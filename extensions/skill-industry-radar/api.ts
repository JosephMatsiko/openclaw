// Public API barrel for @openclaw/skill-industry-radar.

export { definePluginEntry, jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
export { runScan, summarizeStatus, statePath, sourcesPath } from "./src/scan.js";
export { scoreCommit } from "./src/score.js";
export { fetchRepoCommits } from "./src/fetch.js";
export { buildDigestMarkdown } from "./src/digest.js";
export { createEventEmitter } from "./src/events.js";
export { resolveConfig, type IndustryRadarConfig } from "./src/config.js";
export type {
  CommitAuthor,
  RadarState,
  RawCommit,
  RepoSignal,
  RepoSource,
  ScanOptions,
  ScanResult,
  ScoredCommit,
  Signal,
  SkippedSignal,
  SourcesConfig,
} from "./src/types.js";

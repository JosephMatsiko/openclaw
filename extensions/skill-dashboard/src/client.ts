// HTTP client for chuck-dashboard.mjs — query + health probes.
//
// Read-only by design. v0.1 never POSTs / never restarts the daemon. Callers
// (introspection plugins, the cockpit shell) query the live daemon's /api/*
// endpoints through this typed surface.

import { request } from "node:http";
import type { DashboardConfig } from "./config.js";
import type {
  DashboardFetcher,
  FetchResult,
  HealthResult,
  QueryOptions,
  QueryResult,
  RunDeps,
} from "./types.js";

export function defaultFetcher(): DashboardFetcher {
  return async ({ url, timeoutMs }) => {
    return new Promise<FetchResult>((resolvePromise, rejectPromise) => {
      const req = request(
        url,
        { method: "GET", headers: { Accept: "application/json" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolvePromise({
              ok:
                typeof res.statusCode === "number" && res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode ?? 0,
              text: body,
            });
          });
        },
      );
      const timer = setTimeout(() => {
        try {
          req.destroy(new Error(`dashboard request timed out after ${timeoutMs}ms`));
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      req.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
      req.on("close", () => {
        clearTimeout(timer);
      });
      req.end();
    });
  };
}

function buildQueryUrl(config: DashboardConfig, options: QueryOptions): string {
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const url = new URL(path, config.baseUrl);
  if (options.search) {
    for (const [k, v] of Object.entries(options.search)) {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function parseJsonSafe(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: text };
  }
}

export async function fetchDashboardEndpoint(
  config: DashboardConfig,
  options: QueryOptions,
  deps: RunDeps = {},
): Promise<QueryResult> {
  if (!options.path || typeof options.path !== "string") {
    throw new Error("query.path is required and must be a string");
  }
  const fetcher = deps.fetch ?? defaultFetcher();
  const url = buildQueryUrl(config, options);
  const timeoutMs = options.timeoutMs ?? config.queryTimeoutMs;
  const result = await fetcher({ url, timeoutMs });
  return {
    ok: result.ok,
    status: result.status,
    url,
    body: parseJsonSafe(result.text) as QueryResult["body"],
  };
}

export async function checkDashboardHealth(
  config: DashboardConfig,
  deps: RunDeps = {},
): Promise<HealthResult> {
  const url = `${config.baseUrl}/api/snapshot`;
  const fetcher = deps.fetch ?? defaultFetcher();
  try {
    const result = await fetcher({ url, timeoutMs: config.queryTimeoutMs });
    return {
      ok: result.ok,
      reachable: true,
      status: result.status,
      url,
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      url,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

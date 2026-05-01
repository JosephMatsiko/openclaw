// Docket / events loaders. Pure reads.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BusEvent, DocketTask } from "./types.js";
import { readJson, tailLines } from "./util.js";

export function loadDocket(docketDir: string): DocketTask[] {
  if (!existsSync(docketDir)) return [];
  const out: DocketTask[] = [];
  for (const name of readdirSync(docketDir)) {
    if (!name.endsWith(".json")) continue;
    const t = readJson<DocketTask | null>(join(docketDir, name), null);
    if (t) out.push(t);
  }
  return out;
}

export function loadEvents(eventsPath: string, maxLines = 500): BusEvent[] {
  return tailLines(eventsPath, maxLines)
    .map((l) => {
      try {
        return JSON.parse(l) as BusEvent;
      } catch {
        return null;
      }
    })
    .filter((ev): ev is BusEvent => ev !== null);
}

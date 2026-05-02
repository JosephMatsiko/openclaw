// Wrapper around skill-reach-cascade.notify(). Isolating the cross-plugin
// import here keeps the rest of the watcher's modules independent of the
// cascade plugin's API shape.

import {
  notify,
  type NotifyResult,
  type Severity,
  type Tier,
} from "../../skill-reach-cascade/api.js";

export interface FireOptions {
  subject: string;
  body: string;
  severity: Severity;
  tier: Tier;
  origin: { kind: string; ref?: string; mode?: string };
}

export async function fireCascade(opts: FireOptions): Promise<NotifyResult> {
  return await notify({
    subject: opts.subject,
    body: opts.body,
    severity: opts.severity,
    tier: opts.tier,
    origin: opts.origin,
  });
}

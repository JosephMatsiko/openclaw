// Post the digest markdown to Telegram via @openclaw/skill-reach-cascade.
//
// The cascade plugin already handles openclaw-native send + raw-bot-API
// fallback + reach-ledger writes + bus events for Telegram. We delegate
// instead of re-implementing the bot-API curl path here.

import { notify, type NotifyResult } from "../../skill-reach-cascade/api.js";

export async function postDigestToTelegram(markdown: string): Promise<NotifyResult> {
  // Long-update HTML formatter (in skill-panel-ask) auto-wraps long sections
  // in <blockquote expandable>, so the daily digest renders compactly even
  // when the prior day was busy. The Telegram channel attempter inside the
  // cascade picks up parse_mode=HTML when needed.
  return await notify({
    subject: "Chuck morning digest",
    body: markdown,
    severity: "info",
    tier: "digest",
    origin: { kind: "morning-digest" },
  });
}

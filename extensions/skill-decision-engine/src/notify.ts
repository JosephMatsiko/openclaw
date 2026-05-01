// Telegram notification — delegates to @openclaw/skill-reach-cascade.notify().
//
// The cascade plugin already handles openclaw-native send + raw-bot-API
// fallback + reach-ledger writes + bus events. Decision-engine doesn't
// need its own bot-API curl path here.

import { notify } from "../../skill-reach-cascade/api.js";
import type { Proposal } from "./types.js";

function buildText(proposal: Proposal): string {
  const recOption = proposal.options.find((o) => o.label === proposal.recommendation);
  return [
    `Chuck decision proposal (${proposal.riskClass.toUpperCase()})`,
    "",
    proposal.situation,
    "",
    `Recommendation: ${proposal.recommendation} — ${recOption?.action ?? ""}`,
    `Rationale: ${proposal.rationale}`,
    "",
    `Reply with /decision approve ${proposal.id} or /decision reject ${proposal.id}`,
  ].join("\n");
}

export interface NotifyResult {
  sent: boolean;
  messageId?: string | number | null;
  transport?: string | null;
  reason?: string | null;
}

export async function sendProposalNotification(proposal: Proposal): Promise<NotifyResult> {
  try {
    const result = await notify({
      subject: `Chuck decision proposal (${proposal.riskClass.toUpperCase()})`,
      body: buildText(proposal),
      severity: proposal.riskClass === "high" ? "critical" : "warn",
      tier: "immediate-low-friction",
      origin: { kind: "skill-decision-engine", id: proposal.id },
    });
    if (result.delivered) {
      const attempt = result.attempts.find((a) => a.ok);
      return {
        sent: true,
        messageId: attempt?.messageId ?? null,
        transport: attempt?.transport ?? null,
      };
    }
    return { sent: false, reason: result.finalReason ?? "cascade did not deliver" };
  } catch (err) {
    return { sent: false, reason: (err as Error).message ?? String(err) };
  }
}

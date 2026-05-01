// Risk → action policy.
//
// Auto-apply only "drop a docket task"-style low-risk actions. Config edits
// (even low-risk) stage as proposals for Joseph's review. Anything above
// low-risk always stages.

import type { Proposal } from "./types.js";

export function shouldAutoApply(proposal: Proposal): boolean {
  if (proposal.riskClass !== "low") return false;
  const rec = (proposal.recommendation || "").toLowerCase();
  const opt = (proposal.options || []).find((o) => (o.label || "").toLowerCase() === rec);
  const action = (opt?.action || "").toLowerCase();
  return (
    action.includes("drop a docket task") ||
    (action.includes("promote") && !action.includes("openclaw.json"))
  );
}

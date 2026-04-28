import type { StakeClass, TaskClass } from "./types.js";

const DESTRUCTIVE_RE =
  /\b(delete|remove|purge|wipe|drop table|reset --hard|force push|transfer money|send payment|revoke|rotate credential|change password|sudo|chmod -r|rm -rf)\b/i;
const PERSISTENT_RE =
  /\b(write|edit|patch|commit|migrate|deploy|install|enable|disable|create file|update config|modify|ship|send email|send message)\b/i;
const VAULT_RE =
  /\b(vault|doctrine|principle|persona|memory node|memory_forget|memory_set_persona)\b/i;
const ARCH_RE = /\b(architect|architecture|spec|design|invariant|trade-?off|roadmap|migration)\b/i;
const CODE_RE =
  /\b(code|test|typescript|javascript|function|class|import |export |bug|fix|refactor)\b/i;
const SKILL_RE = /\b(skill\.md|clawhub|plugin install|skill install|third-party skill)\b/i;

export type StakeAssessment = {
  stakeClass: StakeClass;
  taskClass: TaskClass;
  reasons: string[];
  requiresDecisionRecord: boolean;
  requiresOperatorApproval: boolean;
};

export function assessStake(text: string): StakeAssessment {
  const reasons: string[] = [];
  let stakeClass: StakeClass = "trivial";
  let taskClass: TaskClass = "factual";

  if (DESTRUCTIVE_RE.test(text)) {
    stakeClass = "destructive";
    taskClass = "destructive-action";
    reasons.push("destructive keyword or irreversible action");
  } else if (SKILL_RE.test(text)) {
    stakeClass = "high-mutating";
    taskClass = "skill-install";
    reasons.push("skill/plugin supply-chain surface");
  } else if (VAULT_RE.test(text)) {
    stakeClass = "high-mutating";
    taskClass = "vault-doctrine";
    reasons.push("Vault or doctrine state involved");
  } else if (PERSISTENT_RE.test(text) && CODE_RE.test(text)) {
    stakeClass = "high-mutating";
    taskClass = "code-mutation";
    reasons.push("code or filesystem mutation");
  } else if (ARCH_RE.test(text)) {
    stakeClass = "high-readonly";
    taskClass = "architecture";
    reasons.push("architecture/spec decision");
  } else if (CODE_RE.test(text)) {
    stakeClass = "medium";
    taskClass = "code-review";
    reasons.push("code reasoning without explicit mutation");
  } else if (text.length > 2_000 || /\b(review|evaluate|summarize|draft)\b/i.test(text)) {
    stakeClass = "medium";
    taskClass = "summary";
    reasons.push("medium-complexity review or draft");
  } else if (/\b(format|typo|quick|what is|who is)\b/i.test(text) || text.length < 240) {
    stakeClass = "trivial";
    taskClass = /\b(format|typo)\b/i.test(text) ? "formatting" : "factual";
    reasons.push("routine low-risk request");
  }

  if (reasons.length === 0) {
    reasons.push("default low-risk classification");
  }

  return {
    stakeClass,
    taskClass,
    reasons,
    requiresDecisionRecord: stakeClass !== "trivial",
    requiresOperatorApproval: stakeClass === "destructive",
  };
}

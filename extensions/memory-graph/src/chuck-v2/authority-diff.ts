import { createHash } from "node:crypto";
import type {
  AuthorityCapabilityId,
  AuthorityDiff,
  AuthorityRiskClass,
  ProtectedPathVerdict,
} from "./types.js";

export const DEFAULT_TIER0_PROTECTED_PATHS = [
  "extensions/memory-graph/src/chuck-v2/kernel.ts",
  "extensions/memory-graph/src/chuck-v2/protocol.ts",
  "extensions/memory-graph/src/chuck-v2/preflight.ts",
  "extensions/memory-graph/src/chuck-v2/stake.ts",
  "extensions/memory-graph/src/chuck-v2/receipt.ts",
  "extensions/memory-graph/src/chuck-v2/records.ts",
  "extensions/memory-graph/src/chuck-v2/authority-diff.ts",
  "extensions/memory-graph/scripts/apex-nplex-adjudicate.mjs",
  "extensions/memory-graph/scripts/apex-outcome-grader.mjs",
  "extensions/memory-graph/scripts/apex-chuck-signature.mjs",
  "extensions/memory-graph/data/chuck-v2-design/authority-diff.schema.json",
];

export type AuthorityDiffInput = {
  targetPaths: string[];
  addedImports?: string[];
  addedCapabilities?: AuthorityCapabilityId[];
  removedCapabilities?: AuthorityCapabilityId[];
  modifiesThresholds?: boolean;
  modifiesAllowlists?: boolean;
  touchesCredentials?: boolean;
  touchesSandboxPolicy?: boolean;
  generatedAt?: string;
};

export type AuthorityDiffPolicy = {
  tier0ProtectedPaths: string[];
};

export const DEFAULT_AUTHORITY_DIFF_POLICY: AuthorityDiffPolicy = {
  tier0ProtectedPaths: DEFAULT_TIER0_PROTECTED_PATHS,
};

export function assessAuthorityDiff(
  input: AuthorityDiffInput,
  policy: AuthorityDiffPolicy = DEFAULT_AUTHORITY_DIFF_POLICY,
): AuthorityDiff {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const targetPaths = [...new Set(input.targetPaths.map(normalizePath))].toSorted();
  const importedCapabilities = capabilitiesFromImports(input.addedImports ?? []);
  const addedCapabilities = [
    ...new Set([...(input.addedCapabilities ?? []), ...importedCapabilities]),
  ].toSorted();
  const removedCapabilities = [...new Set(input.removedCapabilities ?? [])].toSorted();
  const protectedPathVerdict = protectedPathVerdictFor(targetPaths, policy);
  const reasons: string[] = [];

  if (protectedPathVerdict === "touches-tier0") {
    reasons.push("patch touches Tier-0 protected Kernel/authority path");
  }
  if (addedCapabilities.length > 0) {
    reasons.push(`patch adds authority capabilities: ${addedCapabilities.join(", ")}`);
  }
  if (input.modifiesThresholds) {
    reasons.push("patch modifies routing, risk, or approval thresholds");
  }
  if (input.modifiesAllowlists) {
    reasons.push("patch modifies allowlists or protected scopes");
  }
  if (input.touchesCredentials) {
    reasons.push("patch touches credentials or credential proxy code");
  }
  if (input.touchesSandboxPolicy) {
    reasons.push("patch touches sandbox policy");
  }

  const riskClass = riskClassFor({
    protectedPathVerdict,
    addedCapabilities,
    modifiesThresholds: input.modifiesThresholds === true,
    modifiesAllowlists: input.modifiesAllowlists === true,
    touchesCredentials: input.touchesCredentials === true,
    touchesSandboxPolicy: input.touchesSandboxPolicy === true,
  });
  const diffId = `authdiff-${createHash("sha256")
    .update(
      JSON.stringify({ targetPaths, addedCapabilities, removedCapabilities, generatedAt, reasons }),
    )
    .digest("hex")
    .slice(0, 16)}`;

  return {
    diffId,
    generatedAt,
    targetPaths,
    protectedPathVerdict,
    addedCapabilities,
    removedCapabilities,
    riskClass,
    operatorApprovalRequired: riskClass === "high" || riskClass === "destructive",
    reasons,
  };
}

export function isAuthorityExpanding(diff: AuthorityDiff): boolean {
  return (
    diff.addedCapabilities.length > 0 ||
    diff.protectedPathVerdict === "touches-tier0" ||
    diff.riskClass === "high" ||
    diff.riskClass === "destructive"
  );
}

function capabilitiesFromImports(imports: readonly string[]): AuthorityCapabilityId[] {
  const capabilities: AuthorityCapabilityId[] = [];
  for (const specifier of imports.map((item) => item.toLowerCase())) {
    if (/(^|:)child_process$|execa|zx/.test(specifier)) {
      capabilities.push("shell.run");
    }
    if (/^node:fs$|^fs$|fs\/promises/.test(specifier)) {
      capabilities.push("filesystem.read", "filesystem.write");
    }
    if (/^node:http$|^node:https$|undici|axios|node-fetch/.test(specifier)) {
      capabilities.push("network.fetch");
    }
    if (/keychain|credential|secret|oauth/.test(specifier)) {
      capabilities.push("credentials.read");
    }
    if (/playwright|puppeteer|webdriver|chrome/.test(specifier)) {
      capabilities.push("browser.drive");
    }
    if (/^node:vm$|^vm$/.test(specifier)) {
      capabilities.push("code.eval");
    }
  }
  return capabilities;
}

function protectedPathVerdictFor(
  targetPaths: readonly string[],
  policy: AuthorityDiffPolicy,
): ProtectedPathVerdict {
  if (targetPaths.length === 0) {
    return "unknown";
  }
  const protectedPaths = policy.tier0ProtectedPaths.map(normalizePath);
  return targetPaths.some((target) =>
    protectedPaths.some(
      (protectedPath) => target === protectedPath || target.startsWith(`${protectedPath}/`),
    ),
  )
    ? "touches-tier0"
    : "clear";
}

function riskClassFor(input: {
  protectedPathVerdict: ProtectedPathVerdict;
  addedCapabilities: AuthorityCapabilityId[];
  modifiesThresholds: boolean;
  modifiesAllowlists: boolean;
  touchesCredentials: boolean;
  touchesSandboxPolicy: boolean;
}): AuthorityRiskClass {
  if (
    input.addedCapabilities.includes("filesystem.delete") ||
    input.addedCapabilities.includes("credentials.write")
  ) {
    return "destructive";
  }
  if (
    input.protectedPathVerdict === "touches-tier0" ||
    input.modifiesThresholds ||
    input.modifiesAllowlists ||
    input.touchesCredentials ||
    input.touchesSandboxPolicy ||
    input.addedCapabilities.some((capability) =>
      [
        "shell.run",
        "credentials.read",
        "sandbox.policy",
        "kernel.policy",
        "stake.policy",
        "threshold.modify",
      ].includes(capability),
    )
  ) {
    return "high";
  }
  if (input.addedCapabilities.length > 0) {
    return "medium";
  }
  return "none";
}

function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\/Users\/[^/]+\/Projects\/openclaw\//, "")
    .replace(/^\.\//, "");
}

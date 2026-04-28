import { createHash, createHmac } from "node:crypto";
import type { ChuckFamily, RunnerReceipt } from "./types.js";

export type RunnerReceiptInput = Omit<RunnerReceipt, "transcriptSha256" | "runnerSignature"> & {
  transcriptText?: string;
  signingSecret: string;
};

function stableReceiptPayload(receipt: Omit<RunnerReceipt, "runnerSignature">): string {
  return JSON.stringify({
    declaredVoice: receipt.declaredVoice,
    requestedFamily: receipt.requestedFamily,
    actualRunner: receipt.actualRunner,
    actualFamily: receipt.actualFamily,
    surface: receipt.surface,
    layerUsed: receipt.layerUsed,
    modelClaimed: receipt.modelClaimed,
    modelVerified: receipt.modelVerified,
    authProfileId: receipt.authProfileId ?? null,
    transcriptPath: receipt.transcriptPath ?? null,
    transcriptSha256: receipt.transcriptSha256,
    startedAt: receipt.startedAt,
    endedAt: receipt.endedAt,
  });
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function signRunnerReceipt(input: RunnerReceiptInput): RunnerReceipt {
  const { signingSecret, transcriptText, ...rest } = input;
  const transcriptSha256 = sha256Text(transcriptText ?? "");
  const unsigned: Omit<RunnerReceipt, "runnerSignature"> = {
    ...rest,
    transcriptSha256,
  };
  const runnerSignature = createHmac("sha256", signingSecret)
    .update(stableReceiptPayload(unsigned))
    .digest("hex");
  return { ...unsigned, runnerSignature };
}

export function verifyRunnerReceipt(receipt: RunnerReceipt, signingSecret: string): boolean {
  const { runnerSignature, ...unsigned } = receipt;
  const expected = createHmac("sha256", signingSecret)
    .update(stableReceiptPayload(unsigned))
    .digest("hex");
  return expected === runnerSignature;
}

export function receiptCountsForFamily(receipt: RunnerReceipt, family: ChuckFamily): boolean {
  return receipt.actualFamily === family && isReceiptValidForCounting(receipt);
}

export function isImpersonatedReceipt(receipt: RunnerReceipt): boolean {
  return receipt.actualFamily !== receipt.requestedFamily;
}

export function isReceiptValidForCounting(receipt: RunnerReceipt): boolean {
  return receipt.modelVerified && !isImpersonatedReceipt(receipt);
}

export type ReceiptInvariantReport = {
  validReceipts: RunnerReceipt[];
  validFamilies: ChuckFamily[];
  impersonatedReceipts: RunnerReceipt[];
  unverifiedReceipts: RunnerReceipt[];
  duplicateActualFamilies: ChuckFamily[];
};

export function summarizeReceiptInvariants(
  receipts: readonly RunnerReceipt[],
): ReceiptInvariantReport {
  const validReceipts = receipts.filter(isReceiptValidForCounting);
  const impersonatedReceipts = receipts.filter(isImpersonatedReceipt);
  const unverifiedReceipts = receipts.filter((r) => !r.modelVerified);
  const seen = new Set<ChuckFamily>();
  const duplicateActualFamilies: ChuckFamily[] = [];
  for (const receipt of validReceipts) {
    if (seen.has(receipt.actualFamily) && !duplicateActualFamilies.includes(receipt.actualFamily)) {
      duplicateActualFamilies.push(receipt.actualFamily);
    }
    seen.add(receipt.actualFamily);
  }
  return {
    validReceipts,
    validFamilies: [...seen],
    impersonatedReceipts,
    unverifiedReceipts,
    duplicateActualFamilies,
  };
}

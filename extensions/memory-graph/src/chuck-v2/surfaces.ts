import { isReceiptValidForCounting, sha256Text } from "./receipt.js";
import type { ChuckFamily, IntraFamilyFracture, RunnerReceipt, SurfaceReceipt } from "./types.js";

export type SurfaceVerdict = {
  family: ChuckFamily;
  voice: string;
  surface: string;
  verdict: string;
  finalAction: string;
  summary?: string;
};

export function surfaceReceiptsFromRunnerReceipts(
  receipts: readonly RunnerReceipt[],
): SurfaceReceipt[] {
  const bySurface = new Map<string, SurfaceReceipt>();
  for (const receipt of receipts) {
    const key = `${receipt.actualFamily}:${receipt.surface}`;
    const current = bySurface.get(key) ?? {
      family: receipt.actualFamily,
      surface: receipt.surface,
      voices: [],
      receiptIds: [],
      validForFamilyCount: false,
    };
    current.voices.push(receipt.declaredVoice);
    current.receiptIds.push(
      sha256Text(`${receipt.transcriptSha256}:${receipt.runnerSignature}`).slice(0, 16),
    );
    current.validForFamilyCount ||= isReceiptValidForCounting(receipt);
    bySurface.set(key, current);
  }
  return [...bySurface.values()];
}

export function detectIntraFamilyFractures(
  verdicts: readonly SurfaceVerdict[],
): IntraFamilyFracture[] {
  const byFamily = new Map<ChuckFamily, SurfaceVerdict[]>();
  for (const verdict of verdicts) {
    const bucket = byFamily.get(verdict.family) ?? [];
    bucket.push(verdict);
    byFamily.set(verdict.family, bucket);
  }

  const fractures: IntraFamilyFracture[] = [];
  for (const [family, rows] of byFamily) {
    const surfaces = [...new Set(rows.map((row) => row.surface))];
    if (surfaces.length < 2) {
      continue;
    }
    const verdictSet = new Set(rows.map((row) => normalizeLabel(row.verdict)));
    const actionSet = new Set(rows.map((row) => normalizeLabel(row.finalAction)));
    if (verdictSet.size > 1) {
      fractures.push({
        family,
        surfaces,
        kind: "opposing-verdict",
        operatorActionRequired: true,
        summary: `same family produced opposing verdicts across ${surfaces.join(", ")}`,
      });
    } else if (actionSet.size > 1) {
      fractures.push({
        family,
        surfaces,
        kind: "opposing-action",
        operatorActionRequired: true,
        summary: `same family produced opposing final actions across ${surfaces.join(", ")}`,
      });
    } else if (new Set(rows.map((row) => normalizeLabel(row.summary ?? ""))).size > 1) {
      fractures.push({
        family,
        surfaces,
        kind: "framing-divergence",
        operatorActionRequired: false,
        summary: `same family converged on verdict/action but framed the evidence differently`,
      });
    }
  }
  return fractures;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

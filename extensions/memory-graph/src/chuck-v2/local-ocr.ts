import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LocalOcrProvider = "apex-ocr" | "tesseract" | "external-vision" | "none";

export type LocalOcrStatus = "local-ready" | "buildable" | "missing";

export type LocalOcrCapability = {
  status: LocalOcrStatus;
  preferredProvider: LocalOcrProvider;
  providerOrder: LocalOcrProvider[];
  apexOcrPath: string;
  apexOcrSourcePath: string;
  swiftcPath: string;
  tesseractPath?: string;
  reasons: string[];
};

export type LocalOcrDetectionInput = {
  apexOcrPath?: string;
  apexOcrSourcePath?: string;
  swiftcPath?: string;
  tesseractPath?: string;
  exists?: (path: string) => boolean;
};

export type OcrRouteDecision = {
  chosenProvider: LocalOcrProvider;
  externalVisionAllowed: boolean;
  localOnly: boolean;
  reasons: string[];
};

const HOME = homedir();
const DEFAULT_APEX_OCR_PATH = join(HOME, ".openclaw", "workspace", "bin", "apex-ocr");
const DEFAULT_APEX_OCR_SOURCE = join(
  HOME,
  "Projects",
  "openclaw",
  "extensions",
  "memory-graph",
  "scripts",
  "apex-ocr.swift",
);

export function detectLocalOcrCapability({
  apexOcrPath = DEFAULT_APEX_OCR_PATH,
  apexOcrSourcePath = DEFAULT_APEX_OCR_SOURCE,
  swiftcPath = "/usr/bin/swiftc",
  tesseractPath = "/opt/homebrew/bin/tesseract",
  exists = existsSync,
}: LocalOcrDetectionInput = {}): LocalOcrCapability {
  const providerOrder: LocalOcrProvider[] = [];
  const reasons: string[] = [];
  const hasApex = exists(apexOcrPath);
  const hasApexSource = exists(apexOcrSourcePath);
  const hasSwiftc = exists(swiftcPath);
  const hasTesseract = exists(tesseractPath);

  if (hasApex) {
    providerOrder.push("apex-ocr");
    reasons.push("apex-ocr macOS Vision helper is available");
  } else if (hasApexSource && hasSwiftc) {
    providerOrder.push("apex-ocr");
    reasons.push("apex-ocr can be compiled from local Swift source");
  } else {
    reasons.push("apex-ocr is unavailable and cannot be built from local source");
  }

  if (hasTesseract) {
    providerOrder.push("tesseract");
    reasons.push("tesseract is available as an optional fallback");
  }

  if (providerOrder.length === 0) {
    providerOrder.push("none");
  }

  const preferredProvider = providerOrder[0] ?? "none";
  const status: LocalOcrStatus =
    hasApex || hasTesseract ? "local-ready" : hasApexSource && hasSwiftc ? "buildable" : "missing";
  return {
    status,
    preferredProvider,
    providerOrder,
    apexOcrPath,
    apexOcrSourcePath,
    swiftcPath,
    tesseractPath,
    reasons,
  };
}

export function chooseOcrRoute({
  capability = detectLocalOcrCapability(),
  externalVisionAllowed = false,
}: {
  capability?: LocalOcrCapability;
  externalVisionAllowed?: boolean;
} = {}): OcrRouteDecision {
  const reasons = [...capability.reasons];
  if (capability.preferredProvider !== "none") {
    reasons.push(`chosen local OCR provider: ${capability.preferredProvider}`);
    return {
      chosenProvider: capability.preferredProvider,
      externalVisionAllowed,
      localOnly: true,
      reasons,
    };
  }
  if (externalVisionAllowed) {
    reasons.push("local OCR missing; external vision allowed by explicit policy");
    return {
      chosenProvider: "external-vision",
      externalVisionAllowed,
      localOnly: false,
      reasons,
    };
  }
  reasons.push("local OCR missing; external vision is not allowed");
  return {
    chosenProvider: "none",
    externalVisionAllowed,
    localOnly: true,
    reasons,
  };
}

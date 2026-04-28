export type CalibrationGateInput = {
  objectiveSuiteUnanimousCorrectness: number;
  interFamilyDisagreementRate: number;
  falseConsensusCasesLogged: number;
  highRiskDegradedAutoShipCount: number;
  objectivePromptCount: number;
};

export type CalibrationGateResult = {
  canClaimAuthoritativeTruth: boolean;
  canAutoShipHighRisk: boolean;
  reasons: string[];
};

export function evaluateCalibrationGate({
  objectiveSuiteUnanimousCorrectness,
  interFamilyDisagreementRate,
  falseConsensusCasesLogged,
  highRiskDegradedAutoShipCount,
  objectivePromptCount,
}: CalibrationGateInput): CalibrationGateResult {
  const reasons: string[] = [];
  if (objectivePromptCount < 50) {
    reasons.push("objective suite below 50-prompt minimum");
  }
  if (objectiveSuiteUnanimousCorrectness < 0.8) {
    reasons.push("unanimous objective correctness below 80% gate");
  }
  if (interFamilyDisagreementRate < 0.15) {
    reasons.push("inter-family disagreement below 15% sensor-health gate");
  }
  if (falseConsensusCasesLogged === 0) {
    reasons.push("no false-consensus cases logged for calibration review");
  }
  if (highRiskDegradedAutoShipCount > 0) {
    reasons.push("high-risk task auto-shipped under degraded fleet");
  }
  return {
    canClaimAuthoritativeTruth: reasons.length === 0,
    canAutoShipHighRisk: highRiskDegradedAutoShipCount === 0,
    reasons,
  };
}

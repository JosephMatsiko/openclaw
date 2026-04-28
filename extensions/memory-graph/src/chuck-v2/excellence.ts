export type ExcellenceAxis =
  | "epistemic-quality"
  | "execution-reliability"
  | "safety-discipline"
  | "operator-alignment"
  | "autonomy"
  | "latency"
  | "cost"
  | "memory-quality"
  | "tool-coverage"
  | "user-experience";

export type CompetitiveCategory =
  | "vendor-agent"
  | "agent-framework"
  | "memory-system"
  | "local-sovereign-stack"
  | "enterprise-compliance"
  | "operator-specific";

export type GapClosureMode = "close" | "route-around" | "excel";

export type GapClosureTrack = {
  id: string;
  category: CompetitiveCategory;
  mode: GapClosureMode;
  metric: ExcellenceAxis;
  currentScore: number;
  targetScore: number;
  sampleCount: number;
  compromisesInvariant?: boolean;
  notes?: string[];
};

export type GapClosureEvaluation = {
  ready: boolean;
  averageGap: number;
  blockedBy: string[];
  closeNow: string[];
  routeAround: string[];
  excelInvestments: string[];
};

export type AxisScore = {
  axis: ExcellenceAxis;
  score: number;
  sampleCount: number;
};

export type ExcellenceSnapshot = {
  generatedAt: string;
  axes: AxisScore[];
  criticalIncidents: number;
  operatorRejectedSelfChanges: number;
  approvedSelfImprovementPatches: number;
};

export type ExcellenceEvaluation = {
  improving: boolean;
  compoundMomentum: number;
  blockedBy: string[];
  strongestAxes: ExcellenceAxis[];
  weakestAxes: ExcellenceAxis[];
};

function normalizedGap(track: GapClosureTrack): number {
  return clamp01(track.targetScore) - clamp01(track.currentScore);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(1, Math.max(0, n));
}

function scoreMap(snapshot: ExcellenceSnapshot): Map<ExcellenceAxis, AxisScore> {
  return new Map(snapshot.axes.map((axis) => [axis.axis, { ...axis, score: clamp01(axis.score) }]));
}

export function evaluateExcellenceTrajectory({
  previous,
  current,
  minimumSamplesPerAxis = 10,
  regressionTolerance = 0.03,
}: {
  previous: ExcellenceSnapshot;
  current: ExcellenceSnapshot;
  minimumSamplesPerAxis?: number;
  regressionTolerance?: number;
}): ExcellenceEvaluation {
  const prior = scoreMap(previous);
  const now = scoreMap(current);
  const blockedBy: string[] = [];
  const deltas: number[] = [];
  for (const [axis, currentScore] of now.entries()) {
    if (currentScore.sampleCount < minimumSamplesPerAxis) {
      blockedBy.push(`${axis}: insufficient samples`);
      continue;
    }
    const previousScore = prior.get(axis);
    if (!previousScore) {
      blockedBy.push(`${axis}: missing prior score`);
      continue;
    }
    const delta = currentScore.score - previousScore.score;
    deltas.push(delta);
    if (delta < -regressionTolerance) {
      blockedBy.push(`${axis}: regressed ${(delta * 100).toFixed(1)}%`);
    }
  }
  if (current.criticalIncidents > previous.criticalIncidents) {
    blockedBy.push("critical incidents increased");
  }
  if (current.operatorRejectedSelfChanges > previous.operatorRejectedSelfChanges + 2) {
    blockedBy.push("operator rejected too many self-change proposals");
  }

  const ranked = [...now.values()].toSorted((a, b) => b.score - a.score);
  const avgDelta = deltas.length
    ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
    : 0;
  const selfImprovementMomentum =
    current.approvedSelfImprovementPatches > previous.approvedSelfImprovementPatches ? 0.05 : 0;

  return {
    improving: blockedBy.length === 0 && avgDelta > 0,
    compoundMomentum: Number(clamp01(0.5 + avgDelta + selfImprovementMomentum).toFixed(4)),
    blockedBy,
    strongestAxes: ranked.slice(0, 3).map((axis) => axis.axis),
    weakestAxes: ranked.slice(-3).map((axis) => axis.axis),
  };
}

export function evaluateGapClosurePlan({
  tracks,
  minimumSamplesPerTrack = 5,
  gapTolerance = 0.05,
}: {
  tracks: GapClosureTrack[];
  minimumSamplesPerTrack?: number;
  gapTolerance?: number;
}): GapClosureEvaluation {
  const blockedBy: string[] = [];
  const closeNow: string[] = [];
  const routeAround: string[] = [];
  const excelInvestments: string[] = [];
  const gaps: number[] = [];

  for (const track of tracks) {
    const gap = normalizedGap(track);
    gaps.push(Math.max(0, gap));

    if (track.compromisesInvariant) {
      blockedBy.push(`${track.id}: would compromise a non-negotiable invariant`);
      continue;
    }
    if (track.sampleCount < minimumSamplesPerTrack) {
      blockedBy.push(`${track.id}: insufficient samples`);
      continue;
    }

    if (track.mode === "route-around") {
      routeAround.push(track.id);
      continue;
    }
    if (track.mode === "excel") {
      excelInvestments.push(track.id);
      continue;
    }
    if (gap > gapTolerance) {
      closeNow.push(track.id);
    }
  }

  const averageGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
  return {
    ready: blockedBy.length === 0 && closeNow.length === 0,
    averageGap: Number(averageGap.toFixed(4)),
    blockedBy,
    closeNow,
    routeAround,
    excelInvestments,
  };
}

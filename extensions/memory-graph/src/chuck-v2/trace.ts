import { randomUUID } from "node:crypto";
import type { TraceGrade, TraceGradeInput } from "./efficiency.js";
import { gradeEfficiencyTrace } from "./efficiency.js";
import type { ChuckFamily, Protocol, StakeClass, TaskClass } from "./types.js";

export type TraceDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): unknown;
    get(...values: unknown[]): unknown;
  };
};

export type FleetTraceRecord = TraceGradeInput & {
  traceId: string;
  runId: string;
  taskClass: TaskClass;
  stakeClass: StakeClass;
  routeTaken: string;
  scoutFamilies: ChuckFamily[];
  promptBudgetChars: number;
  surfaceReceiptCount: number;
  finalDisposition: string;
  protocol?: Protocol;
  memoryPressure?: string;
  quotaPolicy?: string;
  createdAt: string;
  grade: TraceGrade;
};

export function createFleetTraceRecord({
  traceId = `trace-${randomUUID()}`,
  createdAt = new Date().toISOString(),
  runId,
  taskClass,
  stakeClass,
  routeTaken,
  scoutFamilies,
  promptBudgetChars,
  surfaceReceiptCount = 0,
  finalDisposition,
  protocol,
  memoryPressure,
  quotaPolicy,
  metrics,
}: {
  traceId?: string;
  createdAt?: string;
  runId: string;
  taskClass: TaskClass;
  stakeClass: StakeClass;
  routeTaken: string;
  scoutFamilies: ChuckFamily[];
  promptBudgetChars: number;
  surfaceReceiptCount?: number;
  finalDisposition: string;
  protocol?: Protocol;
  memoryPressure?: string;
  quotaPolicy?: string;
  metrics?: TraceGradeInput;
}): FleetTraceRecord {
  const grade = gradeEfficiencyTrace(metrics ?? {});
  return {
    traceId,
    runId,
    taskClass,
    stakeClass,
    routeTaken,
    scoutFamilies,
    promptBudgetChars,
    surfaceReceiptCount,
    finalDisposition,
    protocol,
    memoryPressure,
    quotaPolicy,
    createdAt,
    grade,
    ...metrics,
  };
}

export function initializeFleetTraceDb(db: TraceDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chuck_v2_fleet_traces (
      trace_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      task_class TEXT NOT NULL,
      stake_class TEXT NOT NULL,
      route_taken TEXT NOT NULL,
      scout_families_json TEXT NOT NULL,
      prompt_budget_chars INTEGER NOT NULL,
      surface_receipt_count INTEGER NOT NULL,
      final_disposition TEXT NOT NULL,
      protocol TEXT,
      memory_pressure TEXT,
      quota_policy TEXT,
      grade TEXT NOT NULL,
      score REAL NOT NULL,
      regression_signals_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chuck_v2_fleet_traces_run_idx
      ON chuck_v2_fleet_traces(run_id);
    CREATE INDEX IF NOT EXISTS chuck_v2_fleet_traces_task_idx
      ON chuck_v2_fleet_traces(task_class, stake_class);
  `);
}

export function appendFleetTrace(db: TraceDatabase, record: FleetTraceRecord): void {
  initializeFleetTraceDb(db);
  db.prepare(`
    INSERT OR REPLACE INTO chuck_v2_fleet_traces (
      trace_id,
      run_id,
      created_at,
      task_class,
      stake_class,
      route_taken,
      scout_families_json,
      prompt_budget_chars,
      surface_receipt_count,
      final_disposition,
      protocol,
      memory_pressure,
      quota_policy,
      grade,
      score,
      regression_signals_json,
      metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.traceId,
    record.runId,
    record.createdAt,
    record.taskClass,
    record.stakeClass,
    record.routeTaken,
    JSON.stringify(record.scoutFamilies),
    record.promptBudgetChars,
    record.surfaceReceiptCount,
    record.finalDisposition,
    record.protocol ?? null,
    record.memoryPressure ?? null,
    record.quotaPolicy ?? null,
    record.grade.grade,
    record.grade.score,
    JSON.stringify(record.grade.regressionSignals),
    JSON.stringify(metricsOnly(record)),
  );
}

export function readFleetTrace(db: TraceDatabase, traceId: string): FleetTraceRecord | undefined {
  initializeFleetTraceDb(db);
  const row = db.prepare("SELECT * FROM chuck_v2_fleet_traces WHERE trace_id = ?").get(traceId) as
    | FleetTraceRow
    | undefined;
  if (!row) {
    return undefined;
  }
  const metrics = JSON.parse(row.metrics_json) as TraceGradeInput;
  return {
    ...metrics,
    traceId: row.trace_id,
    runId: row.run_id,
    createdAt: row.created_at,
    taskClass: row.task_class as TaskClass,
    stakeClass: row.stake_class as StakeClass,
    routeTaken: row.route_taken,
    scoutFamilies: JSON.parse(row.scout_families_json) as ChuckFamily[],
    promptBudgetChars: row.prompt_budget_chars,
    surfaceReceiptCount: row.surface_receipt_count,
    finalDisposition: row.final_disposition,
    protocol: row.protocol === null ? undefined : (row.protocol as Protocol),
    memoryPressure: row.memory_pressure === null ? undefined : row.memory_pressure,
    quotaPolicy: row.quota_policy === null ? undefined : row.quota_policy,
    grade: {
      grade: row.grade as TraceGrade["grade"],
      score: row.score,
      regressionSignals: JSON.parse(row.regression_signals_json) as string[],
    },
  };
}

type FleetTraceRow = {
  trace_id: string;
  run_id: string;
  created_at: string;
  task_class: string;
  stake_class: string;
  route_taken: string;
  scout_families_json: string;
  prompt_budget_chars: number;
  surface_receipt_count: number;
  final_disposition: string;
  protocol: string | null;
  memory_pressure: string | null;
  quota_policy: string | null;
  grade: string;
  score: number;
  regression_signals_json: string;
  metrics_json: string;
};

function metricsOnly(record: FleetTraceRecord): TraceGradeInput {
  return {
    correctness: record.correctness,
    evidenceQuality: record.evidenceQuality,
    latencyMs: record.latencyMs,
    memoryMb: record.memoryMb,
    quotaCalls: record.quotaCalls,
    operatorAttentionMinutes: record.operatorAttentionMinutes,
    refusalQuality: record.refusalQuality,
    failures: record.failures,
  };
}

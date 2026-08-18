// server/src/services/missions/qa-rework-cap-oversight-detection.ts
//
// [ purpose ] Detection for QA rework cap exhaustion. Finds semantic QA steps
//   that issued an official current `request_changes` (workflow_api source,
//   non-null heartbeatRunId matching the latest wakeup-bound heartbeat for its exact step run)
//   against a producer that has exhausted its rework cap.
//
//   Activation mirrors loop-driver.applyBackEdgeReworkPass exactly:
//     - barrier: ALL sibling QA back-edges must be terminal.
//     - producer-level cap = max(all sibling back-edge maxIterations), NOT per-edge.
//   Freshness requires both verdict observedAt AND bound heartbeat start >= producerCompletedAt.
//   No fallback: missing/stale/non-official verdict, delayed old heartbeat, or null
//   producerCompletedAt never qualifies. Pure DB read. Company-scoped (both sides).

import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, workflowTransitionEvents } from "@paperclipai/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import { isStructuralGateStep } from "../workflow/control-flow/structural-gate.js";
import { isQaLikeStep } from "../workflow-step-role.js";

export interface QaReworkCapExhaustion {
  workflowRunId: string;
  producerStepId: string;
  producerStepRunId: string;
  producerIssueId: string | null;
  producerIteration: number;
  producerCompletedAt: string;
  qaStepId: string;
  qaStepRunId: string;
  qaIssueId: string | null;
  maxIterations: number;
}

type RawStep = {
  id?: string;
  dependencies?: string[];
  conditionalDependencies?: Array<Record<string, unknown>>;
};

/** Terminal step-run statuses (mirrors loop-driver.TERMINAL_STEP_RUN_STATUSES). */
const TERMINAL_STEP_RUN_STATUSES = new Set(["completed", "failed", "skipped"]);

function readBackEdges(step: RawStep | null): Array<{ stepId: string; maxIterations: number }> {
  if (!step || !Array.isArray(step.conditionalDependencies)) return [];
  return step.conditionalDependencies
    .filter((edge) => {
      if (!edge || typeof edge !== "object") return false;
      const when = typeof edge.when === "string" ? edge.when.trim().toLowerCase() : "";
      const isBack = edge.isBackEdge === true || edge.isBackEdge === "true";
      const max = typeof edge.maxIterations === "number" && edge.maxIterations >= 1
        ? Math.floor(edge.maxIterations) : undefined;
      return when === "qa_request_changes" && isBack && max !== undefined;
    })
    .map((edge) => ({
      stepId: typeof edge.stepId === "string" ? edge.stepId : "",
      maxIterations: Math.floor(edge.maxIterations as number),
    }))
    .filter((edge) => edge.stepId.length > 0);
}

interface OfficialVerdict {
  verdict: string | null;
  heartbeatRunId: string;
  observedAt: Date;
}

/** Latest OFFICIAL verdict per QA step-run: reason=workflow_api + heartbeatRunId non-null only. */
async function loadOfficialVerdictsByStepRunId(
  db: Db, companyId: string, stepRunIds: string[],
): Promise<Map<string, OfficialVerdict>> {
  const result = new Map<string, OfficialVerdict>();
  if (stepRunIds.length === 0) return result;
  const rows = await db.select({
    stepRunId: workflowTransitionEvents.workflowStepRunId,
    verdict: workflowTransitionEvents.verdict,
    heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    createdAt: workflowTransitionEvents.createdAt,
  }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId),
    inArray(workflowTransitionEvents.workflowStepRunId, stepRunIds),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.reason, "workflow_api"),
    isNotNull(workflowTransitionEvents.heartbeatRunId),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  for (const row of rows) {
    if (!row.stepRunId || result.has(row.stepRunId) || !row.heartbeatRunId) continue;
    result.set(row.stepRunId, { verdict: row.verdict, heartbeatRunId: row.heartbeatRunId, observedAt: row.createdAt });
  }
  return result;
}

export interface QaRejectTrend {
  /** 최신 공식 판정부터 역방향으로 연속한 request_changes 개수(pass 등장 시 중단). */
  readonly count: number;
  /** 최신 request_changes 판정의 reason(payload, bounded). 없으면 null. */
  readonly latestReason: string | null;
}

/**
 * [repeated-defect trend] QA gate 이슈의 최신 공식 판정부터 연속 반려(request_changes) 횟수.
 *   같은 결함이 반복되면 생산자 output 패치가 아니라 원천/템플릿 수준 근본 원인을 의심해야 한다
 *   (2026-08-17 GAZ WCAG 사고: 같은 반려 6연속 — 오너가 추세를 못 보고 동일 재시도만 반복 승인).
 *   권위 필터는 loadOfficialVerdictsByStepRunId 와 동일(reason=workflow_api + heartbeatRunId non-null).
 */
export async function loadConsecutiveQaRejectTrend(
  db: Db, companyId: string, qaIssueId: string | null,
): Promise<QaRejectTrend> {
  if (!qaIssueId) return { count: 0, latestReason: null };
  const rows = await db.select({
    verdict: workflowTransitionEvents.verdict,
    payload: workflowTransitionEvents.payload,
    createdAt: workflowTransitionEvents.createdAt,
  }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId),
    eq(workflowTransitionEvents.issueId, qaIssueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.reason, "workflow_api"),
    isNotNull(workflowTransitionEvents.heartbeatRunId),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(12);
  let count = 0;
  let latestReason: string | null = null;
  for (const row of rows) {
    if (row.verdict !== "request_changes") break;
    count += 1;
    if (count === 1) {
      const reason = (row.payload as Record<string, unknown> | null)?.reason;
      latestReason = typeof reason === "string" && reason.trim().length > 0
        ? reason.trim().slice(0, 400)
        : null;
    }
  }
  return { count, latestReason };
}

/** Latest wakeup-bound heartbeat per exact workflow step-run (companyId-scoped on both sides). */
async function loadLatestHeartbeatPerStepRun(
  db: Db, companyId: string, stepRunIds: string[],
): Promise<Map<string, { heartbeatRunId: string; issueId: string | null; startedAt: Date }>> {
  const result = new Map<string, { heartbeatRunId: string; issueId: string | null; startedAt: Date }>();
  if (stepRunIds.length === 0) return result;
  const rows = await db.select({
    stepRunId: agentWakeupRequests.workflowStepRunId,
    heartbeatRunId: heartbeatRuns.id,
    issueId: heartbeatRuns.issueId,
    startedAt: heartbeatRuns.createdAt,
  }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(agentWakeupRequests.companyId, companyId),
      inArray(agentWakeupRequests.workflowStepRunId, stepRunIds),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const row of rows) {
    if (!row.stepRunId || result.has(row.stepRunId)) continue;
    result.set(row.stepRunId, { heartbeatRunId: row.heartbeatRunId, issueId: row.issueId, startedAt: row.startedAt });
  }
  return result;
}

type StepRunRow = MissionSupervisionWorkflowStepRow["stepRun"];

export async function detectQaReworkCapExhaustion(input: {
  db: Db; companyId: string;
  stepRows: MissionSupervisionWorkflowStepRow[];
}): Promise<QaReworkCapExhaustion[]> {
  const { db, companyId } = input;
  const byRun = new Map<string, { steps: RawStep[]; runStatus: string; runMap: Map<string, StepRunRow> }>();
  for (const row of input.stepRows) {
    const runId = row.run.id;
    if (!byRun.has(runId)) {
      const steps = (row.definition.stepsJson as RawStep[] | null) ?? [];
      byRun.set(runId, { steps, runStatus: row.run.status, runMap: new Map() });
    }
    const entry = byRun.get(runId)!;
    if (row.stepRun.stepId) entry.runMap.set(row.stepRun.stepId, row.stepRun);
  }

  const exhausted: QaReworkCapExhaustion[] = [];

  for (const [runId, entry] of byRun) {
    if (entry.runStatus === "cancelled") continue;

    const candidates: Array<{
      producerStepId: string; producerRun: StepRunRow;
      qaStepId: string; qaRun: StepRunRow; maxIterations: number;
    }> = [];

    for (const step of entry.steps) {
      const stepId = typeof step.id === "string" ? step.id : "";
      if (!stepId) continue;
      const backEdges = readBackEdges(step);
      if (backEdges.length === 0) continue;

      const producerRun = entry.runMap.get(stepId);
      if (!producerRun || producerRun.status !== "completed") continue;

      // [blocker 1] Authoritative activation (mirrors loop-driver.applyBackEdgeReworkPass):
      //   barrier — ALL sibling QA back-edges must be terminal before evaluating exhaustion.
      //   producer-level cap = max(all sibling back-edge maxIterations), NOT a per-edge cap.
      //   This prevents handoff while a sibling QA is still running or when only a short edge
      //   is exhausted but the producer-wide cap is not.
      const siblings = backEdges.map((edge) => {
        const qaRun = entry.runMap.get(edge.stepId) ?? null;
        const terminal = !!qaRun && TERMINAL_STEP_RUN_STATUSES.has(qaRun.status);
        return { edge, qaRun, terminal };
      });
      if (!siblings.every((s) => s.terminal)) continue; // barrier

      const producerMaxIterations = Math.max(...siblings.map((s) => s.edge.maxIterations));
      const iteration = producerRun.iterationIndex ?? 0;
      if (iteration < producerMaxIterations) continue; // producer-wide cap not exhausted

      for (const s of siblings) {
        const qaRun = s.qaRun!;
        const qaStepDef = entry.steps.find((st) => st.id === s.edge.stepId) ?? null;
        if (isStructuralGateStep(qaStepDef as never)) continue;
        if (!isQaLikeStep(qaStepDef as never)) continue;
        if (qaRun.status !== "failed") continue;
        candidates.push({ producerStepId: stepId, producerRun, qaStepId: s.edge.stepId, qaRun, maxIterations: producerMaxIterations });
      }
    }
    if (candidates.length === 0) continue;

    // Batch load official verdicts + exact step-run-bound latest heartbeats.
    const qaStepRunIds = candidates.map((c) => c.qaRun.id);
    const verdictMap = await loadOfficialVerdictsByStepRunId(db, companyId, qaStepRunIds);
    const heartbeatMap = await loadLatestHeartbeatPerStepRun(db, companyId, qaStepRunIds);

    for (const c of candidates) {
      // Fail closed: null producerCompletedAt → cannot verify freshness.
      if (!c.producerRun.completedAt) continue;
      // Fail closed: no QA issue → cannot verify heartbeat binding.
      if (!c.qaRun.issueId) continue;

      const fact = verdictMap.get(c.qaRun.id);
      if (!fact || fact.verdict !== "request_changes") continue; // no official current request_changes

      // Freshness: verdict observed after producer's current completion.
      if (fact.observedAt.getTime() < c.producerRun.completedAt.getTime()) continue;

      // Heartbeat binding: exact QA step-run wakeup and issue must match.
      const latestHb = heartbeatMap.get(c.qaRun.id);
      if (
        !latestHb
        || latestHb.issueId !== c.qaRun.issueId
        || fact.heartbeatRunId !== latestHb.heartbeatRunId
      ) continue;

      // [blocker 4] The bound heartbeat must have STARTED after producer completion — a delayed
      //   old heartbeat can produce a verdict with createdAt >= completion but actually began
      //   before this producer generation (stale run recycling a previous verdict).
      if (latestHb.startedAt.getTime() < c.producerRun.completedAt.getTime()) continue;

      exhausted.push({
        workflowRunId: runId,
        producerStepId: c.producerStepId,
        producerStepRunId: c.producerRun.id,
        producerIssueId: c.producerRun.issueId ?? null,
        producerIteration: c.producerRun.iterationIndex ?? 0,
        producerCompletedAt: c.producerRun.completedAt.toISOString(),
        qaStepId: c.qaStepId,
        qaStepRunId: c.qaRun.id,
        qaIssueId: c.qaRun.issueId,
        maxIterations: c.maxIterations,
      });
    }
  }
  return exhausted;
}

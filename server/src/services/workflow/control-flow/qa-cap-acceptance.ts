// server/src/services/workflow/control-flow/qa-cap-acceptance.ts
//
// [ purpose ] Opt-in, per-back-edge semantic-QA cap acceptance. When a producer's
//   individual back-edge is allowCapAcceptance:true and the rework cap (maxIterations) is
//   exhausted, a *current official* nonblocking verdict (POST /issues/:id/workflow/verdict,
//   verdict=request_changes + nonblockingAcceptance) for EVERY current fresh rejected
//   semantic QA lets that QA step complete instead of converging the run to failed.
//
// Guarantees: per-edge opt-in (default false; a non-opted sibling blocks); only official
//   workflow_api verdicts qualify; binds exact current QA step run + current producer
//   generation + current QA execution (heartbeat→wakeup→stepRun); structural/delivery
//   gates are hard-blocked; producer status never mutated (only FAILED QA CAS'd completed,
//   no reset/retry/LLM); all CASs + producer metadata + events are ONE transaction.

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import {
  conditionalEdgeHolds,
  resolveEdges,
  type EdgeBearingStep,
  type PredFacts,
} from "./edge-condition.js";
import { filterFreshRejectedQas } from "./stale-verdict-guard.js";
import { loadLatestNonblockingAcceptance } from "../validation-verdict-ledger.js";
import { recordWorkflowStepStatusTransition } from "../workflow-sync-source.js";
import { isStructuralGateStep, type StructuralGateStep } from "./structural-gate.js";
import { isDeliveryReadbackStep } from "../delivery-verification-gate.js";
import {
  QA_CAP_ACCEPTANCE_KEY,
  QA_CAP_ACCEPTED_SENTINEL,
  readAcceptanceRecord,
  readAcceptanceRecords,
  readMeta,
  type AcceptanceRecord,
} from "./qa-cap-acceptance-records.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

interface LoopRun {
  readonly id: string;
  readonly companyId: string;
  readonly status: string;
  readonly missionId?: string | null;
}

/** Step shape rich enough for the deterministic gate hard-block checks. */
type GateCheckStep = StructuralGateStep & { name: string; description?: string };

const TERMINAL = new Set(["completed", "failed", "skipped"]);
const CAP_CAS_LOST = "qa-cap-acceptance-cas-lost";

export interface ApplyCapAcceptanceInput {
  readonly db: Db;
  readonly run: LoopRun;
  readonly steps: ReadonlyArray<EdgeBearingStep>;
  readonly stepRuns: StepRun[];
  readonly predsByStepId: Map<string, PredFacts>;
  readonly validationVerdictsByIssueId?: ReadonlyMap<string, { observedAt: Date | null } | undefined>;
}

export interface ApplyCapAcceptanceResult {
  readonly stepRuns: StepRun[];
  readonly acceptedCount: number;
}

/**
 * [current-generation freshness, fail-closed] acceptance must belong to this producer
 *   generation: observed at/after the producer's current completion. Either timestamp
 *   unknown => CANNOT prove current generation => reject (false), never accept blindly.
 */
function isFreshAcceptance(observedAt: Date | null, producerCompletedAt: Date | null): boolean {
  if (!producerCompletedAt || !observedAt) return false;
  return observedAt.getTime() >= producerCompletedAt.getTime();
}

/**
 * [execution freshness] the official verdict's submitting heartbeat run must EQUAL the LATEST
 *   heartbeat run for this QA issue that is joined to a wakeup carrying this QA step run id.
 *   A newer QA heartbeat/wakeup (re-dispatch) after the verdict supersedes it => the verdict is
 *   no longer the current execution and must NOT qualify. Comments/prose never participate.
 */
async function isLatestQaExecution(db: Db, qaIssueId: string, qaStepRunId: string, verdictHeartbeatRunId: string | null): Promise<boolean> {
  if (!verdictHeartbeatRunId) return false;
  const latest = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
    .where(and(eq(heartbeatRuns.issueId, qaIssueId), eq(agentWakeupRequests.workflowStepRunId, qaStepRunId)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return latest?.id === verdictHeartbeatRunId;
}

function acceptanceRecord(input: {
  readonly limitations: readonly string[];
  readonly acceptedAt: string;
  readonly producerStepId: string;
  readonly producerIteration: number;
  readonly heartbeatRunId: string | null;
  readonly verdictWorkflowStepRunId: string | null;
}): AcceptanceRecord {
  return {
    classification: "nonblocking",
    limitations: input.limitations,
    acceptedAt: input.acceptedAt,
    producerStepId: input.producerStepId,
    producerIteration: input.producerIteration,
    heartbeatRunId: input.heartbeatRunId,
    verdictWorkflowStepRunId: input.verdictWorkflowStepRunId,
  };
}

function findQaStepDef(steps: ReadonlyArray<EdgeBearingStep>, stepId: string): GateCheckStep | null {
  const s = steps.find((x) => x.id === stepId);
  return s ? (s as unknown as GateCheckStep) : null;
}

/** Deterministic hard-block: structural / delivery-readback gates are never nonblocking-acceptable. */
function isHardBlockedQaStep(def: GateCheckStep | null): boolean {
  if (!def) return true; // cannot prove plain semantic QA => block (never accept blindly)
  return isStructuralGateStep(def) || isDeliveryReadbackStep(def);
}

interface QualifiedQa {
  readonly qaRun: StepRun;
  readonly limitations: readonly string[];
  readonly heartbeatRunId: string | null;
  readonly verdictStepRunId: string | null;
}

/**
 * [purpose] exact-state CAS: flip only qualifying FAILED semantic QA steps to completed,
 *   atomically with the producer-metadata record and acceptance events. Producer untouched.
 */
export async function applyCapAcceptancePass(input: ApplyCapAcceptanceInput): Promise<ApplyCapAcceptanceResult> {
  const { db, run, steps, predsByStepId } = input;
  if (run.status === "cancelled") return { stepRuns: input.stepRuns, acceptedCount: 0 };

  const srMap = new Map(input.stepRuns.map((sr) => [sr.stepId, sr]));
  const acceptedQaIds = new Set<string>();
  let acceptedCount = 0;

  for (const producer of steps) {
    const optedEdges = resolveEdges(producer).filter(
      (e) => e.isBackEdge === true && e.allowCapAcceptance === true && typeof e.maxIterations === "number" && e.maxIterations >= 1,
    );
    if (optedEdges.length === 0) continue;

    const pRun = srMap.get(producer.id);
    if (!pRun || pRun.status !== "completed") continue; // cap acceptance only at producer-completed

    const maxIterations = Math.max(...optedEdges.map((e) => e.maxIterations!));
    const iteration = pRun.iterationIndex ?? 0;
    if (iteration < maxIterations) continue; // under-cap: normal rework path owns it

    // sibling QA barrier over ALL of this producer's back-edges (mirror loop-driver coalesce).
    const allBackEdges = resolveEdges(producer).filter(
      (e) => e.isBackEdge === true && typeof e.maxIterations === "number" && e.maxIterations >= 1,
    );
    const siblingQas = allBackEdges.map((edge) => {
      const qaRun = srMap.get(edge.stepId);
      const pred = predsByStepId.get(edge.stepId);
      return {
        edge,
        qaRun,
        terminal: !!qaRun && TERMINAL.has(qaRun.status),
        rejected: conditionalEdgeHolds(edge, pred),
      };
    });
    if (!siblingQas.every((q) => q.terminal)) continue;

    const producerCompletedAt = pRun.completedAt ?? null;
    const freshRejectedQas = filterFreshRejectedQas(siblingQas, producerCompletedAt, input.validationVerdictsByIssueId);
    if (freshRejectedQas.length === 0) continue;

    // Every fresh rejected QA must itself be opted-in + (if failed) carry a current official
    // acceptance. A non-opted / hard-blocked / unaccepted sibling blocks the whole producer.
    const toFlip: QualifiedQa[] = [];
    let blocked = false;
    for (const q of freshRejectedQas) {
      const qaRun = q.qaRun;
      if (!qaRun) { blocked = true; break; }
      const edge = allBackEdges.find((e) => e.stepId === qaRun.stepId);
      if (!edge || edge.allowCapAcceptance !== true) { blocked = true; break; } // strict per-edge opt-in
      if (isHardBlockedQaStep(findQaStepDef(steps, qaRun.stepId))) { blocked = true; break; }
      if (qaRun.status === "completed") {
        // already cap-accepted only if its sentinel binds THIS producer + iteration; else block.
        const sentinel = readAcceptanceRecord(readMeta(qaRun.metadata)[QA_CAP_ACCEPTED_SENTINEL]);
        if (!sentinel || sentinel.producerStepId !== producer.id || sentinel.producerIteration !== iteration) {
          blocked = true; break;
        }
        continue; // stable, satisfied for this generation
      }
      if (qaRun.status !== "failed") { blocked = true; break; }
      const qaIssueId = qaRun.issueId;
      if (!qaIssueId) { blocked = true; break; }
      const acc = await loadLatestNonblockingAcceptance({ db, companyId: run.companyId, issueId: qaIssueId });
      if (!acc) { blocked = true; break; }
      // exact current QA step-run binding: non-null AND equal. Stale/foreign verdict never qualifies.
      if (!acc.workflowStepRunId || acc.workflowStepRunId !== qaRun.id) { blocked = true; break; }
      if (!isFreshAcceptance(acc.observedAt, producerCompletedAt)) { blocked = true; break; }
      // execution freshness: verdict heartbeat must EQUAL the latest QA heartbeat joined to a wakeup for this step.
      if (!(await isLatestQaExecution(db, qaIssueId, qaRun.id, acc.heartbeatRunId))) { blocked = true; break; }
      toFlip.push({
        qaRun,
        limitations: acc.acceptance.limitations,
        heartbeatRunId: acc.heartbeatRunId,
        verdictStepRunId: acc.workflowStepRunId,
      });
    }
    if (blocked || toFlip.length === 0) continue;

    // Atomic: all CASs + producer metadata + events commit together or roll back together.
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        for (const q of toFlip) {
          const casConds = [
            eq(workflowStepRuns.id, q.qaRun.id),
            eq(workflowStepRuns.status, "failed"),
            eq(workflowStepRuns.iterationIndex, q.qaRun.iterationIndex ?? 0),
          ];
          // exact snapshot: lock observed dispatch + completion so a newer generation survives.
          if (q.qaRun.lastDispatchRequestId) casConds.push(eq(workflowStepRuns.lastDispatchRequestId, q.qaRun.lastDispatchRequestId));
          else casConds.push(isNull(workflowStepRuns.lastDispatchRequestId));
          if (q.qaRun.completedAt) casConds.push(eq(workflowStepRuns.completedAt, q.qaRun.completedAt));
          else casConds.push(isNull(workflowStepRuns.completedAt));
          const meta = readMeta(q.qaRun.metadata);
          meta[QA_CAP_ACCEPTED_SENTINEL] = acceptanceRecord({
            limitations: q.limitations, acceptedAt: now.toISOString(), producerStepId: producer.id,
            producerIteration: iteration, heartbeatRunId: q.heartbeatRunId, verdictWorkflowStepRunId: q.verdictStepRunId,
          });
          const res = await tx.update(workflowStepRuns)
            .set({ status: "completed", completedAt: now, metadata: meta })
            .where(and(...casConds)).returning({
              id: workflowStepRuns.id,
              transitionVersion: workflowStepRuns.statusTransitionVersion,
            });
          if (res.length === 0) throw new Error(CAP_CAS_LOST);
          await recordWorkflowStepStatusTransition(tx, {
            companyId: run.companyId,
            missionId: run.missionId,
            workflowRunId: run.id,
            workflowStepRunId: q.qaRun.id,
            issueId: q.qaRun.issueId,
            heartbeatRunId: q.heartbeatRunId,
            fromStatus: q.qaRun.status,
            toStatus: "completed",
            source: "workflow_qa_cap_acceptance",
            transitionVersion: res[0]!.transitionVersion,
          });
        }
        // producer metadata: bounded acceptance record (status NOT mutated; CAS on completed).
        const pMeta = readMeta(pRun.metadata);
        const records = readAcceptanceRecords(pMeta[QA_CAP_ACCEPTANCE_KEY]);
        for (const q of toFlip) {
          records[q.qaRun.stepId] = acceptanceRecord({
            limitations: q.limitations, acceptedAt: now.toISOString(), producerStepId: producer.id,
            producerIteration: iteration, heartbeatRunId: q.heartbeatRunId, verdictWorkflowStepRunId: q.verdictStepRunId,
          });
        }
        pMeta[QA_CAP_ACCEPTANCE_KEY] = records;
        const pCas = [eq(workflowStepRuns.id, pRun.id), eq(workflowStepRuns.status, "completed"), eq(workflowStepRuns.iterationIndex, iteration)];
        if (pRun.completedAt) pCas.push(eq(workflowStepRuns.completedAt, pRun.completedAt));
        else pCas.push(isNull(workflowStepRuns.completedAt));
        if (pRun.lastDispatchRequestId) pCas.push(eq(workflowStepRuns.lastDispatchRequestId, pRun.lastDispatchRequestId));
        else pCas.push(isNull(workflowStepRuns.lastDispatchRequestId));
        const pres = await tx.update(workflowStepRuns).set({ metadata: pMeta }).where(and(...pCas)).returning({ id: workflowStepRuns.id });
        if (pres.length === 0) throw new Error(CAP_CAS_LOST);
        // acceptance ledger events — bounded limitations + run/step binding (idempotent).
        for (const q of toFlip) {
          await tx.insert(workflowTransitionEvents).values({
            companyId: run.companyId, missionId: run.missionId ?? null, workflowRunId: run.id,
            workflowStepRunId: q.qaRun.id, issueId: q.qaRun.issueId ?? null, heartbeatRunId: q.heartbeatRunId,
            eventType: "qa_cap_acceptance", layer: "workflow_validation", fromStatus: "failed", toStatus: "completed",
            decision: "nonblocking_acceptance", verdict: "request_changes", reason: "workflow_api", reasonCode: "qa_cap_acceptance",
            idempotencyKey: `qa-cap-acceptance:${run.companyId}:${q.qaRun.id}:${q.verdictStepRunId ?? "noStepRun"}:${q.heartbeatRunId ?? "noRun"}`,
            payload: {
              kind: "qa_cap_acceptance", producerStepId: producer.id, producerStepRunId: pRun.id, producerIteration: iteration,
              qaStepId: q.qaRun.stepId, nonblockingAcceptance: { classification: "nonblocking", limitations: q.limitations },
            },
          }).onConflictDoNothing();
        }
      });
    } catch {
      continue; // rolled back (lost CAS or concurrent change) — retry next sync, no partial state.
    }

    for (const q of toFlip) acceptedQaIds.add(q.qaRun.id);
    acceptedCount += toFlip.length;
  }

  if (acceptedQaIds.size > 0) {
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
    return { stepRuns, acceptedCount };
  }
  return { stepRuns: input.stepRuns, acceptedCount };
}

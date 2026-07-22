// server/src/services/workflow/control-flow/structural-gate-rework.ts
//
// [ purpose ] Hybrid QA structural gate rework pass with CAS guards.
//   Runs after applyBackEdgeReworkPass in syncWorkflowRunState.
//
//   Safety guarantees:
//   - CAS: producer/gate resets use conditional WHERE (id + expected status +
//     expected iteration). Losing concurrent syncs do nothing.
//   - Generation markers: persist producerIteration on gate reset; compare on
//     every sync. Fixes no-verdict retry loop and running-producer crash recovery.
//   - Sibling barrier: coalesce per producer only when all sibling gates terminal.
//   - Bounded diagnostics: per-item 200 chars, total 2000 chars.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, workflowStepRuns } from "@paperclipai/db";
import { resolveEdges } from "./edge-condition.js";
import {
  buildWorkflowReworkContract,
  renderWorkflowReworkComment,
  type QaReworkFeedback,
} from "./rework-contract.js";
import { loadProducerDependencyArtifacts, loadProducerOwnReworkContext } from "./rework-producer-context.js";
import { isStructuralGateStep, readStructuralGateProducerToken, sameStructuralGateProducerToken, type StructuralGateStep } from "./structural-gate.js";
import { isQaLikeStep } from "../../workflow-step-role.js";
import { loadStructuralGateVerdictByRequest, type StructuralGateVerdictRecord } from "./structural-gate-ledger.js";
import { QA_REWORK_DEFAULT_MAX_ITERATIONS } from "../../missions/workflow-qa-rework.js";

type StepRun = typeof workflowStepRuns.$inferSelect;
const TERMINAL = new Set(["completed", "failed", "skipped"]);
const GATE_CLEAR_KEYS = ["toolInvocation", "toolResult", "toolQueue", "cacheHit", "concurrencyBlocked", "controlFlowSkipped", "retentionDeleted"];
// Clear stale dispatch + verdict/tool metadata on a semantic QA reset so old
// completion evidence (request id, timestamps, error, verdict metadata) cannot
// leak into the new generation. Mirrors the gate-retry clean-pending surface.
const SEMANTIC_QA_CLEAR_KEYS = [
  "toolInvocation", "toolResult", "toolQueue", "cacheHit",
  "concurrencyBlocked", "controlFlowSkipped", "retentionDeleted",
  "structuralGateVerdict", "structuralGateProducerToken", "semanticQaVerdict",
];

interface LoopRun { id: string; companyId: string; status: string; missionId?: string | null }
interface ReworkableStep extends StructuralGateStep { conditionalDependencies?: import("./types.js").ConditionalEdge[] }

export function resolveProducerCap(step: ReworkableStep): number {
  let max: number | null = null;
  for (const edge of resolveEdges(step)) {
    if (edge.isBackEdge === true && typeof edge.maxIterations === "number") {
      max = max === null ? edge.maxIterations : Math.max(max, edge.maxIterations);
    }
  }
  return max ?? QA_REWORK_DEFAULT_MAX_ITERATIONS;
}

function findProducerForGate(gateId: string, steps: readonly ReworkableStep[]): ReworkableStep | null {
  const gate = steps.find((s) => s.id === gateId);
  if (!gate) return null;
  for (const depId of gate.dependencies ?? []) {
    const dep = steps.find((s) => s.id === depId);
    if (dep && (dep as { graphWorkProductRequired?: unknown }).graphWorkProductRequired === true) return dep;
  }
  for (const depId of gate.dependencies ?? []) {
    const dep = steps.find((s) => s.id === depId);
    if (dep && !isStructuralGateStep(dep)) return dep;
  }
  return null;
}

// A QA step is any non-gate step the shared classifier treats as QA-like
// (mirrors structural-semantic-readiness / structural-topology). This includes
// mission-level `[QA] Verify mission result` steps that carry NO qaType, so they
// are invalidated on producer rework exactly like qaType:"semantic" steps.
function isSemanticQaStep(step: ReworkableStep): boolean {
  if (isStructuralGateStep(step)) return false;
  return isQaLikeStep(step);
}

function readGateGen(meta: unknown): number | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>).structuralGateProducerGeneration;
  return typeof v === "number" ? v : null;
}

function boundedFeedback(gateId: string, verdictRec: StructuralGateVerdictRecord): string {
  const reason = typeof verdictRec.reason === "string" ? verdictRec.reason.slice(0, 500) : null;
  const diags = Array.isArray(verdictRec.diagnostics) ? verdictRec.diagnostics.slice(0, 10) : [];
  return [
    `### Structural gate feedback: ${gateId}`,
    `Verdict: REQUEST_CHANGES`,
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(diags.length > 0
      ? diags.map((d) => `- ${typeof d === "string" ? d.slice(0, 200) : JSON.stringify(d).slice(0, 200)}`).slice(0, 10)
      : ["- See the structural gate tool output for details."]),
  ].join("\n").slice(0, 2000);
}

export async function applyStructuralGatePass(input: {
  db: Db; run: LoopRun; steps: readonly ReworkableStep[]; stepRuns: StepRun[];
}): Promise<{ stepRuns: StepRun[]; reworkedCount: number }> {
  const { db, run, steps, stepRuns } = input;
  if (run.status === "cancelled") return { stepRuns, reworkedCount: 0 };
  const srMap = new Map(stepRuns.map((sr) => [sr.stepId, sr]));
  const resetIds = new Set<string>();


  // Phase 1: coalesce rejections by producer with sibling barrier
  interface Pending { pStep: ReworkableStep; pRun: StepRun; max: number; iter: number; fbs: QaReworkFeedback[] }
  const byProducer = new Map<string, Pending>();

  for (const s of steps) {
    if (!isStructuralGateStep(s)) continue;
    const sr = srMap.get(s.id);
    if (!sr || sr.status !== "failed") continue;
    // Query ONLY the exact current (stepRunId, lastDispatchRequestId) verdict.
    // A request_changes from old request A must not rework a gate now carrying request B.
    const currentGateRequestId = sr.lastDispatchRequestId;
    if (!currentGateRequestId) continue;
    const vRec = await loadStructuralGateVerdictByRequest(
      db, run.companyId, sr.id, currentGateRequestId,
    );
    if (!vRec || vRec.verdict !== "request_changes") continue;

    const producer = findProducerForGate(s.id, steps);
    if (!producer) continue;
    const pRun = srMap.get(producer.id);
    if (!pRun || pRun.status !== "completed") continue;
    const pCompleted = pRun.completedAt?.getTime() ?? 0;
    if (pCompleted && vRec.observedAt.getTime() < pCompleted) continue;

    // Exact producer tokens win. Legacy request-scoped gates without tokens
    // fall back to the exact request id and observed-after-completion checks above.
    const gateProducerToken = readStructuralGateProducerToken(
      (sr.metadata as Record<string, unknown> | null)?.structuralGateProducerToken,
    );
    if (vRec.producerToken) {
      if (!sameStructuralGateProducerToken(vRec.producerToken, {
        producerStepId: producer.id,
        iterationIndex: pRun.iterationIndex ?? 0,
        completedAt: pRun.completedAt ? pRun.completedAt.toISOString() : "",
      })) continue;
    } else if (gateProducerToken) {
      continue;
    }

    const max = resolveProducerCap(producer);
    const iter = pRun.iterationIndex ?? 0;
    if (iter >= max) continue;

    // Sibling barrier
    const allTerminal = steps.every((x) => {
      if (!isStructuralGateStep(x)) return true;
      const xProducer = findProducerForGate(x.id, steps);
      if (xProducer?.id !== producer.id) return true;
      return TERMINAL.has(srMap.get(x.id)?.status ?? "");
    });
    if (!allTerminal) continue;

    const fb: QaReworkFeedback = { qaStepId: s.id, qaIssueId: sr.issueId, feedback: boundedFeedback(s.id, vRec) };
    const existing = byProducer.get(producer.id);
    if (existing) existing.fbs.push(fb);
    else byProducer.set(producer.id, { pStep: producer, pRun, max, iter, fbs: [fb] });
  }

  // Execute coalesced reworks with CAS guard
  let reworkedCount = 0;
  for (const { pStep, pRun, max, iter, fbs } of byProducer.values()) {
    const dependencyArtifacts = await loadProducerDependencyArtifacts({ db, companyId: run.companyId, stepRunMap: srMap, producerStep: pStep });
    const producerOwnContext = await loadProducerOwnReworkContext({ db, companyId: run.companyId, missionId: run.missionId ?? null, workflowRunId: run.id, producerStepId: pStep.id, producerIssueId: pRun.issueId ?? null });
    const contract = buildWorkflowReworkContract({
      producerStepId: pStep.id,
      qaFeedbacks: fbs,
      currentIteration: iter,
      maxIterations: max,
      dependencyArtifacts,
      producerIssueInstruction: producerOwnContext.instruction,
      producerWorkProducts: producerOwnContext.workProducts,
    });

    // CAS: only reset if still completed with expected iteration + dispatch evidence.
    // Same-iteration newer completion (different requestId/completedAt) survives.
    const prodCasConditions = [
      eq(workflowStepRuns.id, pRun.id),
      eq(workflowStepRuns.status, "completed"),
      eq(workflowStepRuns.iterationIndex, iter),
    ];
    if (pRun.lastDispatchRequestId) {
      prodCasConditions.push(eq(workflowStepRuns.lastDispatchRequestId, pRun.lastDispatchRequestId));
    } else {
      prodCasConditions.push(isNull(workflowStepRuns.lastDispatchRequestId));
    }
    // Also lock to exact observed completedAt so a same-request newer completion survives
    if (pRun.completedAt) {
      prodCasConditions.push(eq(workflowStepRuns.completedAt, pRun.completedAt));
    } else {
      prodCasConditions.push(isNull(workflowStepRuns.completedAt));
    }
    const casResult = await db.update(workflowStepRuns).set({
      status: "pending", startedAt: null, completedAt: null,
      iterationIndex: iter + 1,
      metadata: (() => {
        const m = pRun.metadata && typeof pRun.metadata === "object" && !Array.isArray(pRun.metadata)
          ? { ...(pRun.metadata as Record<string, unknown>) } : {};
        m.workflowReworkContract = contract;
        delete m.controlFlowSkipped;
        return m;
      })(),
    }).where(and(...prodCasConditions)).returning({ id: workflowStepRuns.id });

    if (casResult.length === 0) continue; // CAS failed — another sync won

    if (pRun.issueId) {
      await db.insert(issueComments).values({ companyId: run.companyId, issueId: pRun.issueId, body: renderWorkflowReworkComment(contract) });
    }
    resetIds.add(pStep.id);
    reworkedCount++;

    // [W002] A structural request_changes reworks the producer for a new
    //   generation. Invalidate ONLY semantic QA steps that directly depend on
    //   BOTH the reworked producer AND its related structural gate(s) — so an
    //   OLD completed semantic PASS cannot satisfy the new generation. Ordinary
    //   downstream actions that depend on only one side (or neither) are left
    //   untouched; no graphWorkProductRequired / broad heuristic is used.
    const affectedGateIds = steps
      .filter((x) => isStructuralGateStep(x) && findProducerForGate(x.id, steps)?.id === pStep.id)
      .map((x) => x.id);
    const downstreamIds = steps
      .filter((step) => {
        if (step.id === pStep.id) return false;
        if (isStructuralGateStep(step)) return false; // gates have their own retry path
        if (!isSemanticQaStep(step)) return false; // only semantic QA steps
        const deps = step.dependencies ?? [];
        return deps.includes(pStep.id) && affectedGateIds.some((g) => deps.includes(g));
      })
      .map((step) => step.id);
    for (const downstreamId of downstreamIds) {
      const dRun = srMap.get(downstreamId);
      if (!dRun || !TERMINAL.has(dRun.status)) continue;
      // Mirror gate-retry clean pending: clear dispatch request/timestamps/error
      // and stale verdict/tool metadata, guarded by exact current snapshot so a
      // newer completion (different request/iteration) cannot be clobbered.
      const meta = dRun.metadata && typeof dRun.metadata === "object" && !Array.isArray(dRun.metadata)
        ? { ...(dRun.metadata as Record<string, unknown>) } : {};
      for (const k of SEMANTIC_QA_CLEAR_KEYS) delete meta[k];
      const dReset = await db.update(workflowStepRuns).set({
        status: "pending", startedAt: null, completedAt: null,
        lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null,
        lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null,
        metadata: meta,
      }).where(
        and(
          eq(workflowStepRuns.id, dRun.id),
          eq(workflowStepRuns.status, dRun.status),
          eq(workflowStepRuns.iterationIndex, dRun.iterationIndex ?? 0),
          dRun.lastDispatchRequestId
            ? eq(workflowStepRuns.lastDispatchRequestId, dRun.lastDispatchRequestId)
            : isNull(workflowStepRuns.lastDispatchRequestId),
        ),
      ).returning({ id: workflowStepRuns.id });
      if (dReset.length > 0) resetIds.add(downstreamId);
    }
  }

  // Phase 2: reset stale terminal gates using generation markers (CAS)
  for (const s of steps) {
    if (!isStructuralGateStep(s)) continue;
    const sr = srMap.get(s.id);
    if (!sr || !TERMINAL.has(sr.status)) continue;
    const producer = findProducerForGate(s.id, steps);
    if (!producer) continue;
    const pRun = srMap.get(producer.id);
    if (!pRun) continue;

    const pIter = pRun.iterationIndex ?? 0;
    // When producer was reset in THIS pass (Phase 1), its new iteration is pIter+1.
    // Gates reset alongside must record the NEW generation, not the stale snapshot value.
    const effectiveGen = resetIds.has(producer.id) ? pIter + 1 : pIter;
    let shouldReset = false;

    // (a) Producer reworked in this sync or still pending
    if (resetIds.has(producer.id) || (pRun.status === "pending" && pIter > 0)) shouldReset = true;

    // (b) Generation marker mismatch = stale gate from older producer generation
    const gateGen = readGateGen(sr.metadata);
    if (!shouldReset && pIter > 0) {
      if (gateGen === null || gateGen < pIter) shouldReset = true;
    }

    if (!shouldReset) continue;

    // CAS: tight match on exact observed status + iterationIndex + lastDispatchRequestId.
    // A newer callback/generation (same status but different request/iteration) cannot be reset.
    const meta = sr.metadata && typeof sr.metadata === "object" && !Array.isArray(sr.metadata) ? { ...(sr.metadata as Record<string, unknown>) } : {};
    for (const k of GATE_CLEAR_KEYS) delete meta[k];
    meta.structuralGateProducerGeneration = effectiveGen;

    const casConditions = [
      eq(workflowStepRuns.id, sr.id),
      eq(workflowStepRuns.status, sr.status),
      eq(workflowStepRuns.iterationIndex, sr.iterationIndex ?? 0),
    ];
    // Lock to exact observed requestId so a new-generation callback (different requestId)
    // with the same terminal status survives a stale reset attempt.
    if (sr.lastDispatchRequestId) {
      casConditions.push(eq(workflowStepRuns.lastDispatchRequestId, sr.lastDispatchRequestId));
    } else {
      casConditions.push(isNull(workflowStepRuns.lastDispatchRequestId));
    }

    const cas = await db.update(workflowStepRuns).set({
      status: "pending", startedAt: null, completedAt: null,
      lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null,
      metadata: meta,
    }).where(and(...casConditions)).returning({ id: workflowStepRuns.id });

    if (cas.length > 0) resetIds.add(s.id);
  }

  if (resetIds.size > 0) {
    const refreshed = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
    return { stepRuns: refreshed, reworkedCount };
  }
  return { stepRuns, reworkedCount: 0 };
}

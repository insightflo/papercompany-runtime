import { isDeepStrictEqual as same } from "node:util";
import { PgTransaction } from "drizzle-orm/pg-core";
import { findWorkflowVerdictCorrection } from "./workflow-verdict-current.js";
import { prepareWorkflowVerdictLocks, lockWorkflowVerdictDependencies } from "./workflow-verdict-write.js";
import { lockQualityAttemptBudget } from "../quality/retry-budget.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { QaCorrectionReadError } from "./control-flow/qa-correction-authority.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup, readQaCorrectionFollowupConsumption, QaCorrectionFollowupReadError } from "./control-flow/qa-correction-followup.js";
import { eq, is } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { buildStepRunMap } from "./dag-step-observation.js";
import { normalizeRecord, getMetadataRecord } from "./dag-metadata-helpers.js";
import { buildPredFactsMap } from "./dag-readiness-facts.js";
import { isWorkflowChildStep } from "./workflow-child-execution.js";
import { ownerPlanExecutionIntentCurrent } from "../missions/mission-owner-execution-state.js";
import { classifyStepActivation } from "./control-flow/edge-condition.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { isWorkflowControlNode } from "./control-flow/control-node-executor.js";
import { type PersistedWorkflowStep } from "./execution-steps.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { assertResumeAccepted } from "./resume/acceptance.js";
import type { WorkflowStep } from "./dag-engine.js";

export type WorkflowToolCorrection = NonNullable<Awaited<ReturnType<typeof findWorkflowVerdictCorrection>>>;

export function isQaCorrectionToolStep(step: WorkflowStep) {
  const toolNames = Array.isArray(step.toolNames)
    ? step.toolNames.filter(name => typeof name === "string" && name.trim()) : [];
  return !isStructuralGateStep(step) && !isWorkflowControlNode(step) && !isWorkflowChildStep(step)
    && normalizeRecord((step as PersistedWorkflowStep).toolArtifactContract).role === "qa"
    && toolNames.length === 1;
}

export async function readWorkflowToolCorrection(db: Pick<Db, "select">, run: typeof workflowRuns.$inferSelect,
  stepRun: typeof workflowStepRuns.$inferSelect, step: WorkflowStep) {
  if (!stepRun.issueId || !isQaCorrectionToolStep(step)) return null;
  const correction = await findWorkflowVerdictCorrection(db, { companyId: run.companyId,
    issueId: stepRun.issueId, workflowRunId: run.id, workflowStepRunId: stepRun.id });
  if (!correction || correction.issued.preparation.missionId !== run.missionId
    || !same(correction.followup.target, { stepRunId: stepRun.id, stepId: stepRun.stepId,
      issueId: stepRun.issueId, executionGeneration: stepRun.executionGeneration,
      retryCount: stepRun.retryCount, iterationIndex: stepRun.iterationIndex })) return null;
  return correction;
}

/** The ref is a lookup binding, never permission. Keep it across existing dispatch-failure metadata. */
export function hasWorkflowToolCorrectionInvocation(stepRun: typeof workflowStepRuns.$inferSelect,
  correction: WorkflowToolCorrection) {
  const invocation = getMetadataRecord(stepRun.metadata, "toolInvocation");
  const request = getMetadataRecord(stepRun.metadata, "toolArtifactRequest");
  const ref = normalizeRecord(stepRun.metadata).qaCorrectionToolFollowup ?? request.qaCorrectionFollowup;
  return same(ref, correction.ref) && typeof invocation.requestId === "string"
    && invocation.requestId === stepRun.lastDispatchRequestId;
}

/** Real root only: observe files first, then reuse the accepted ordered dependency locks and reservation. */
export async function withWorkflowToolCorrection<T>(input: {
  db: Db; run: typeof workflowRuns.$inferSelect; stepRun: typeof workflowStepRuns.$inferSelect;
  step: WorkflowStep; correction: WorkflowToolCorrection;
}, write: (tx: Db) => Promise<T>): Promise<T | null> {
  const { db, run, stepRun, step, correction } = input;
  if (is(db, PgTransaction)) return null;
  try {
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    if (!same(execution.steps.find(s => s.id === step.id), step)
      || await readQaCorrectionFollowupConsumption(db, correction.ref,
        createQaCorrectionHistorySession(db, correction.ref))) return null;
    const observation = await observeQaCorrectionFollowup(db, correction.ref,
      createQaCorrectionHistorySession(db, correction.ref));
    const dependencies = await prepareWorkflowVerdictLocks(db, correction, []);
    return await db.transaction(async tx => {
      const p = correction.issued.preparation;
      if (p.authority.kind === "quality_current_output") {
        await lockQualityAttemptBudget(tx, { companyId: run.companyId, actionId: p.authority.actionId, now: new Date() });
      }
      const currentRun = await lockUnreplacedRun(tx as unknown as Db, run.id, run.companyId);
      if (!currentRun || currentRun.status !== "running" || currentRun.missionId !== run.missionId) return null;
      await assertResumeAccepted(tx, run.id, currentRun.dispatchAuthorityVersion);
      await lockWorkflowVerdictDependencies(tx, dependencies);
      const current = await readCurrentQaCorrectionFollowup(tx, correction.ref, observation,
        createQaCorrectionHistorySession(tx, correction.ref));
      const latest = await readWorkflowToolCorrection(tx, currentRun, current.database.target.step, step);
      const captured = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
      if (!latest || !same(latest.ref, correction.ref) || !same(current.database.target.step, stepRun)
        || captured.definitionHash !== execution.definitionHash
        || !same(captured.steps.find(s => s.id === step.id), step)
        || await readQaCorrectionFollowupConsumption(tx, correction.ref,
          createQaCorrectionHistorySession(tx, correction.ref))) return null;
      const rows = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
      if (!classifyStepActivation(step, buildPredFactsMap(captured.steps, buildStepRunMap(rows))).runnable
        || !await ownerPlanExecutionIntentCurrent(tx as unknown as Db, run.companyId,
          { runMetadata: currentRun.metadata, stepMetadata: current.database.target.step.metadata })) return null;
      return write(tx as unknown as Db);
    });
  } catch (error) {
    // A refused/stale observation leaves the request unclaimed; unexpected DB errors still propagate.
    if (!(error instanceof QaCorrectionReadError) && !(error instanceof QaCorrectionFollowupReadError)) throw error;
    return null;
  }
}

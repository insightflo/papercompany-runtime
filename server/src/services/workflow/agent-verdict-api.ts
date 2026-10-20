import { agentWakeupRequests, heartbeatRuns, issues, missions, workflowRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { isDeepStrictEqual as same } from "node:util";
import { and, eq } from "drizzle-orm";
import { workflowValidationVerdictValueSchema } from "@paperclipai/shared";
import type { WorkflowVerdictSubmit } from "@paperclipai/shared/validators/workflow-agent-api";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { reconcileRecoveredWorkflowStep } from "../missions/recovery-closeout.js";
import type { WorkflowApiActor, WorkflowApiIssue } from "./agent-api.js";
import { workflowService } from "./engine.js";
import { recordWorkflowValidationVerdict, resolveWorkflowValidationContext } from "./validation-verdict-ledger.js";
import { findWorkflowVerdictCorrection } from "./workflow-verdict-current.js";
import { prepareWorkflowVerdictLocks, lockWorkflowVerdictDependencies, WorkflowVerdictConsumptionConflict,
  recordWorkflowValidationVerdict as writeCorrectionVerdict } from "./workflow-verdict-write.js";
import { readQaCorrectionWakeRef } from "../work-products/qa-correction-producer-attempt.js";
import { producerAttemptDetail } from "../work-products/producer-attempt.js";
import { lockQualityAttemptBudget } from "../quality/retry-budget.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { readIssuedQaCorrectionFollowupForAttempt } from "./control-flow/qa-correction-reader.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup,
  readQaCorrectionFollowupConsumption } from "./control-flow/qa-correction-followup.js";
import { qaCorrectionDeliverySchema, qaCorrectionDeliveryKey } from "./control-flow/qa-correction-contract.js";

type Submit = { readonly db: Db; readonly issue: WorkflowApiIssue; readonly actor: WorkflowApiActor;
  readonly data: WorkflowVerdictSubmit };
type Connection = Pick<Db, "select">;
type Run = typeof heartbeatRuns.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const requireVerdict = (ok: unknown) => { if (!ok) throw conflict("qa_correction_verdict_unproven"); };

/** Actual original wakes only; a missing/corrupt correction proof never becomes an ordinary submission. */
async function actorLineage(db: Connection, input: Submit) {
  const chain: Run[] = [], wakes: (typeof agentWakeupRequests.$inferSelect)[] = [], seen = new Set<string>();
  let id = input.actor.runId, missingWake = false;
  while (id) {
    requireVerdict(!seen.has(id) && seen.size < 32);
    seen.add(id);
    const [run]: Run[] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    requireVerdict(run && run.companyId === input.issue.companyId
      && run.issueId === input.issue.id && run.agentId === input.actor.agentId);
    chain.push(run!);
    if (!run!.wakeupRequestId) missingWake = true;
    else {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
      requireVerdict(wake);
      wakes.push(wake!);
      const ref = readQaCorrectionWakeRef(wake!);
      if (ref) return { chain, wakes, ref, missingWake };
    }
    id = run!.retryOfRunId;
  }
  return { chain, wakes, ref: null, missingWake };
}
type Lineage = Awaited<ReturnType<typeof actorLineage>>;

async function proveCorrectionActor(db: Connection, input: Submit, l: Lineage) {
  requireVerdict(l.ref && !l.missingWake);
  const h = await readIssuedQaCorrectionFollowupForAttempt(db, l.ref!), t = h.followup.target;
  const actor = l.chain[0]!;
  requireVerdict(h.ref.companyId === input.issue.companyId && t.issueId === input.issue.id
    && h.issued.preparation.missionId === input.issue.missionId && actor.id === input.actor.runId);
  const detail = await producerAttemptDetail(db, actor, {
    id: t.stepRunId, workflowRunId: h.ref.workflowRunId, stepId: t.stepId, issueId: t.issueId,
    executionGeneration: t.executionGeneration, retryCount: t.retryCount, iterationIndex: t.iterationIndex,
  });
  const [delivery] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, h.ref.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionDeliveryKey(h.ref.requestId))));
  requireVerdict(delivery);
  const delivered = qaCorrectionDeliverySchema.parse(delivery!.payload);
  requireVerdict(same(delivered.ref, h.ref) && delivered.followupEventId === h.followupEventId
    && detail.rootHeartbeatRunId === delivered.heartbeatRunId && detail.rootWakeupRequestId === delivered.wakeupRequestId);
  return { h, actor, deliveryEventId: delivery!.id };
}

/** Historical first effect precedes currentness and IO, including after completion or input replacement. */
async function replayCorrection(db: Db | Tx, input: Submit, l: Lineage) {
  const relation = await readQaCorrectionFollowupConsumption(db, l.ref!, createQaCorrectionHistorySession(db, l.ref!));
  if (!relation) return null;
  requireVerdict(relation.consumed.evidence.kind === "workflow_verdict");
  if (relation.consumed.evidence.kind !== "workflow_verdict") throw conflict("qa_correction_verdict_unproven");
  const { h } = await proveCorrectionActor(db, input, l), t = h.followup.target;
  const [event] = await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, relation.consumed.evidence.eventId));
  requireVerdict(event);
  return { isCandidate: true, satisfied: true, verdict: workflowValidationVerdictValueSchema.parse(event!.verdict),
    workflowRunId: h.ref.workflowRunId, workflowStepRunId: t.stepRunId, stepId: t.stepId,
    insufficientEvidence: false, insufficientEvidenceReason: null };
}

async function recordSubmission(input: Submit) {
  const db = input.db, scope = { companyId: input.issue.companyId, issueId: input.issue.id };
  const l = await actorLineage(db, input);
  if (l.ref) {
    const prior = await replayCorrection(db, input, l);
    if (prior) return { result: prior, replayed: true };
  }
  const context = await resolveWorkflowValidationContext(db, input.issue, { mode: "record" });
  const submission = {
    issue: input.issue, verdict: input.data.verdict, source: "workflow_api" as const,
    actorAgentId: input.actor.agentId, heartbeatRunId: input.actor.runId,
    sourceText: input.data.reason ?? input.data.verdict,
    nonblockingAcceptance: input.data.nonblockingAcceptance ?? null,
    findings: input.data.findings ?? null, remediations: input.data.remediations ?? null,
  };
  if (!l.ref) {
    requireVerdict(!await findWorkflowVerdictCorrection(db, { ...scope, ...context }));
    const result = await db.transaction(async tx => {
      const connection = tx as unknown as Db;
      if (context.workflowRunId) await lockUnreplacedRun(connection, context.workflowRunId, scope.companyId);
      const current = await resolveWorkflowValidationContext(connection, input.issue, { mode: "record" });
      requireVerdict(same(context, current) && !(await actorLineage(tx, input)).ref
        && !await findWorkflowVerdictCorrection(tx, { ...scope, ...current }));
      return recordWorkflowValidationVerdict({ ...submission, db: connection });
    });
    return { result, replayed: false };
  }
  const proof = await proveCorrectionActor(db, input, l), { h } = proof;
  requireVerdict(same((await findWorkflowVerdictCorrection(db, { ...scope, ...context }))?.ref, h.ref));
  const observation = await observeQaCorrectionFollowup(db, h.ref, createQaCorrectionHistorySession(db, h.ref));
  const dependencies = await prepareWorkflowVerdictLocks(db, h, l.chain);
  try {
    return await db.transaction(async tx => {
      const p = h.issued.preparation;
      if (p.authority.kind === "quality_current_output") {
        await lockQualityAttemptBudget(tx, { companyId: scope.companyId, actionId: p.authority.actionId, now: new Date() });
      }
      // Lock without rejecting terminal state until the serialized first-effect lookup has completed.
      const [mission] = await tx.select().from(missions).where(and(eq(missions.companyId, scope.companyId),
        eq(missions.id, p.missionId))).for("update");
      const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, scope.companyId),
        eq(workflowRuns.id, h.ref.workflowRunId))).for("update");
      requireVerdict(mission && run && run.missionId === mission.id);
      const replay = await replayCorrection(tx, input, await actorLineage(tx, input));
      if (replay) return { result: replay, replayed: true };
      await lockWorkflowVerdictDependencies(tx, dependencies);
      const fresh = await actorLineage(tx, input);
      requireVerdict(same(fresh, l));
      const current = await readCurrentQaCorrectionFollowup(tx, h.ref, observation, createQaCorrectionHistorySession(tx, h.ref));
      requireVerdict(same((await findWorkflowVerdictCorrection(tx, { ...scope, ...context }))?.ref, h.ref));
      const proved = await proveCorrectionActor(tx, input, fresh), issue = current.database.target.issue;
      requireVerdict(proved.deliveryEventId === proof.deliveryEventId
        && (!issue.assigneeAgentId || issue.assigneeAgentId === input.actor.agentId));
      // HTTP checkout authorization stays at the route; the captured owner tuple was rechecked under its lock.
      const result = await writeCorrectionVerdict({ ...submission, db: tx as unknown as Db },
        resolveWorkflowValidationContext, { selected: current, actor: proved.actor, deliveryEventId: proved.deliveryEventId });
      return { result, replayed: false };
    });
  } catch (error) {
    if (!(error instanceof WorkflowVerdictConsumptionConflict)) throw error;
    // Only a consumption uniqueness loss is replayable, after the whole losing transaction rolled back.
    const replay = await replayCorrection(db, input, l);
    if (!replay) throw error;
    return { result: replay, replayed: true };
  }
}

/** Check the durable row, not a caller-supplied origin/marker projection. */
export async function assertNotPlanQaWorkflowVerdict(db: Db, issue: Pick<WorkflowApiIssue, "id" | "companyId">) {
  const [row] = await db.select({ originKind: issues.originKind, marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id))).limit(1);
  if (!row) throw notFound("Issue not found");
  if (row.originKind === "mission_plan_qa" || row.marker !== null) {
    throw conflict("quality_plan_qa_dedicated_submission_required");
  }
}

export async function submitWorkflowVerdict(input: Submit) {
  await assertNotPlanQaWorkflowVerdict(input.db, input.issue);
  const { result, replayed } = await recordSubmission(input);
  if (!result.isCandidate) {
    throw unprocessable("Workflow verdict API can only be used on workflow execution issues linked to a workflow step run");
  }
  if (!result.satisfied) {
    throw unprocessable("Workflow verdict ledger was not recorded");
  }
  if (replayed) return result;
  // Recovery reads the durable current-generation workflow_validation_verdict event, never prose.
  if (result.verdict === "pass" && input.issue.missionId) {
    try {
      const closeout = await reconcileRecoveredWorkflowStep(input.db, {
        companyId: input.issue.companyId,
        missionId: input.issue.missionId,
        qaGateIssueId: input.issue.id,
        source: "workflow_api_qa_pass",
      });
      if ("reconciled" in closeout && closeout.reconciled) {
        await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
      }
    } catch (err) {
      logger.warn({ err, issueId: input.issue.id }, "recovery closeout failed after workflow verdict");
    }
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
  return result;
}

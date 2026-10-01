import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, issueWorkProducts, missionPlanQaVerdicts, missions, operatorDecisions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { notFound, badRequest } from "../../errors.js";
import { revisionCurrentHeartbeats } from "./revision-current-heartbeats.js";

/** Read-only planning reference, never permission to seed, retry, or complete execution. */
export async function buildMissionRevisionContext(db: Pick<Db, "select">,
  input: { companyId: string; missionId: string }) {
  const [mission] = await db.select().from(missions).where(and(
    eq(missions.companyId, input.companyId), eq(missions.id, input.missionId))).limit(1);
  if (!mission) throw notFound("Mission not found");
  if (!mission.sourceMissionId) return null;
  const [source] = await db.select({ id: missions.id }).from(missions).where(and(
    eq(missions.companyId, input.companyId), eq(missions.id, mission.sourceMissionId))).limit(1);
  if (!source) throw badRequest("Invalid revision source mission");
  const sourceRunId = mission.sourceWorkflowRunId;
  if (sourceRunId) {
    const [run] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, source.id), eq(workflowRuns.id, sourceRunId)));
    if (!run) throw badRequest("Invalid revision source workflow run");
  }
  const stepRows = sourceRunId ? await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, sourceRunId)).orderBy(asc(workflowStepRuns.stepId)) : [];
  const steps = await Promise.all(stepRows.map(async step => {
    const attempts = (await revisionCurrentHeartbeats(db, input.companyId, step)).map(h => ({
      heartbeatRunId: h.id, status: h.status, executionGeneration: h.workflowExecutionGeneration, errorCode: h.errorCode,
    }));
    return { stepRunId: step.id, stepId: step.stepId, status: step.status,
      executionGeneration: step.executionGeneration, retryCount: step.retryCount, attempt: step.retryCount + 1,
      iterationIndex: step.iterationIndex, errorCode: attempts[0]?.errorCode ?? null, attempts };
  }));
  const planQaVerdicts = await db.select({ id: missionPlanQaVerdicts.id, planQaIssueId: missionPlanQaVerdicts.planQaIssueId,
    decisionHash: missionPlanQaVerdicts.decisionHash, verdict: missionPlanQaVerdicts.verdict,
    sourceRunId: missionPlanQaVerdicts.sourceRunId }).from(missionPlanQaVerdicts)
    .innerJoin(issues, and(eq(issues.id, missionPlanQaVerdicts.planQaIssueId), eq(issues.companyId, input.companyId), eq(issues.missionId, source.id)))
    .where(and(eq(missionPlanQaVerdicts.companyId, input.companyId), eq(missionPlanQaVerdicts.missionId, source.id),
      isNull(missionPlanQaVerdicts.sourceCommentId))).orderBy(asc(missionPlanQaVerdicts.createdAt), asc(missionPlanQaVerdicts.id));
  const workflowQaVerdicts = sourceRunId ? await db.select({ id: workflowTransitionEvents.id,
    stepRunId: workflowTransitionEvents.workflowStepRunId, heartbeatRunId: heartbeatRuns.id,
    verdict: workflowTransitionEvents.verdict }).from(workflowTransitionEvents)
    .innerJoin(workflowStepRuns, and(eq(workflowStepRuns.id, workflowTransitionEvents.workflowStepRunId),
      eq(workflowStepRuns.workflowRunId, sourceRunId), eq(workflowStepRuns.issueId, workflowTransitionEvents.issueId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, workflowTransitionEvents.heartbeatRunId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, workflowTransitionEvents.issueId)))
    .where(and(eq(workflowTransitionEvents.companyId, input.companyId), eq(workflowTransitionEvents.missionId, source.id),
      eq(workflowTransitionEvents.workflowRunId, sourceRunId), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"), sql`${workflowTransitionEvents.payload}->>'sourceCommentId' is null`))
    .orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id)) : [];
  const decisions = await db.select({ id: operatorDecisions.id, status: operatorDecisions.status,
    definition: operatorDecisions.definition, result: operatorDecisions.result }).from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId), sql`${operatorDecisions.sourceContext}->>'missionId' = ${source.id}`,
    sql`(${operatorDecisions.sourceContext}->>'workflowRunId' is null or ${operatorDecisions.sourceContext}->>'workflowRunId' = ${sourceRunId})`,
  )).orderBy(asc(operatorDecisions.createdAt), asc(operatorDecisions.id));
  const products = sourceRunId ? await db.select({ product: issueWorkProducts, step: workflowStepRuns, heartbeat: heartbeatRuns })
    .from(issueWorkProducts).innerJoin(workflowStepRuns, and(eq(workflowStepRuns.issueId, issueWorkProducts.issueId),
      eq(workflowStepRuns.workflowRunId, sourceRunId), eq(workflowStepRuns.status, "completed")))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, issueWorkProducts.createdByRunId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, issueWorkProducts.issueId),
      eq(heartbeatRuns.workflowStepRunId, workflowStepRuns.id), eq(heartbeatRuns.workflowExecutionGeneration, workflowStepRuns.executionGeneration)))
    .where(eq(issueWorkProducts.companyId, input.companyId)).orderBy(asc(issueWorkProducts.id)) : [];
  const workProducts = products.flatMap(({ product, step, heartbeat }) => {
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    const sha256 = product.metadata?.sha256;
    if (!parsed.success || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
      || ["archived", "failed", "draft", "changes_requested"].includes(product.status)) return [];
    const p = parsed.data;
    if (p.companyId !== input.companyId || p.missionId !== source.id || p.workflowRunId !== sourceRunId
      || p.stepRunId !== step.id || p.stepId !== step.stepId || p.heartbeatRunId !== heartbeat.id
      || p.executionGeneration !== step.executionGeneration || p.retryCount !== step.retryCount
      || p.iterationIndex !== step.iterationIndex || product.sourceExecutionGeneration !== p.executionGeneration) return [];
    return [{ id: product.id, type: product.type, sha256, producer: p }];
  });
  return { schemaVersion: "mission-revision-context.v1" as const, sourceMissionId: source.id,
    sourceWorkflowRunId: sourceRunId, steps, planQaVerdicts, workflowQaVerdicts,
    operatorDecisions: decisions.map(d => ({ id: d.id, status: d.status,
      optionIds: d.definition.options.map(option => option.id),
      selectedOptionIds: d.result?.selectedOptionIds ?? [], outcome: d.result?.outcome ?? null })), workProducts };
}
export type MissionRevisionContext = Awaited<ReturnType<typeof buildMissionRevisionContext>>;

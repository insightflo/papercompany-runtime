import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { operatorDecisionSourceContextSchema } from "@paperclipai/shared/validators/operator-decision";
import { unprocessable } from "../../errors.js";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE } from "../operator-decision-currentness.js";
import { MISSION_OWNER_DECISION_EVENT_TYPE, MISSION_OWNER_DECISION_SOURCE, MISSION_OWNER_RECOVERY_LAYER }
  from "./mission-owner-decision-contract.js";
import type { OwnerHumanTx } from "./owner-human-request-contract.js";

const ownerUnblockOrigin = "mission_main_executor_unblock";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalidScope = (): never => { throw unprocessable("Legacy human request target is not bound to its company mission", {
  code: "owner_human_target_scope_unproven",
}); };

function isPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keep the existing owner-decision producer heartbeat-bound while recognizing the two
 * system producers whose structured event contracts intentionally have no heartbeat.
 * The exact recovery reader remains narrower and continues to require its own authority.
 */
function hasSupportedEventBinding(event: {
  eventType: string; layer: string; reason: string | null; reasonCode: string | null;
  decision: string | null; correlationId: string | null; workflowRunId: string | null;
  payload: unknown; heartbeatRunId: string | null;
}, issueId: string, sourceIssueId: string): boolean {
  if (!isPayload(event.payload)) return false;
  const payload = event.payload;

  if (event.eventType === MISSION_OWNER_DECISION_EVENT_TYPE) {
    return event.layer === MISSION_OWNER_RECOVERY_LAYER
      && event.reason === MISSION_OWNER_DECISION_SOURCE
      && event.reasonCode === MISSION_OWNER_DECISION_SOURCE
      && event.heartbeatRunId !== null
      && payload.kind === MISSION_OWNER_DECISION_EVENT_TYPE
      && payload.source === MISSION_OWNER_DECISION_SOURCE
      && payload.ownerActionIssueId === issueId
      && payload.sourceIssueId === sourceIssueId
      && payload.decision === event.decision;
  }

  if (event.eventType === "terminal_mission_human_operator_report") {
    return event.layer === "workflow_validation"
      && event.reason === "terminal_mission_no_continuation"
      && event.reasonCode === event.eventType
      && event.decision === "escalate"
      && event.correlationId === issueId
      && payload.ownerActionIssueId === issueId
      && payload.workflowRunId === event.workflowRunId
      && payload.status === "reported";
  }

  if (event.eventType === "mission_owner_dead_target_escalation") {
    return event.layer === "mission_owner_recovery"
      && event.reasonCode === event.eventType
      && event.decision === "escalate"
      && payload.kind === event.eventType
      && payload.ownerActionIssueId === issueId
      && payload.anchorIssueId === issueId
      && payload.sourceIssueId === sourceIssueId;
  }

  return false;
}

/** Serialize supported legacy owner-unblock cards under their existing mission prefix. */
export async function lockLegacyOwnerHumanCardMission(
  tx: OwnerHumanTx,
  companyId: string,
  input: CreateOperatorDecisionInput,
): Promise<void> {
  if (input.sourceType !== MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE || input.requestKey.startsWith("moi2:")) return;
  if (input.issueId === null) {
    if (input.requestKey.startsWith("moi1:")) invalidScope();
    return;
  }

  const [observedOwner] = await tx.select({ companyId: issues.companyId, missionId: issues.missionId,
    originKind: issues.originKind }).from(issues).where(eq(issues.id, input.issueId));
  if (!observedOwner || observedOwner.companyId !== companyId || observedOwner.originKind !== ownerUnblockOrigin) return;

  const context = operatorDecisionSourceContextSchema.safeParse(input.sourceContext);
  const snapshot = context.success ? context.data.targetSnapshot : null;
  if (!context.success || !context.data.missionId || !uuidPattern.test(context.data.missionId)
    || !observedOwner.missionId || context.data.missionId !== observedOwner.missionId
    || !snapshot?.issueId || snapshot.issueId !== input.issueId
    || (snapshot.workflowRunStatus != null && snapshot.workflowRunId == null)
    || (snapshot.stepRunStatus != null && snapshot.stepRunId == null)
    || !uuidPattern.test(input.sourceId) || input.requestKey !== `moi1:${input.sourceId}`) invalidScope();

  const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.id, observedOwner.missionId), eq(missions.companyId, companyId),
  )).for("update");
  if (!mission) invalidScope();

  const [owner] = await tx.select({ companyId: issues.companyId, missionId: issues.missionId,
    originKind: issues.originKind, originId: issues.originId }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, companyId),
  ));
  if (!owner || owner.missionId !== observedOwner.missionId || owner.originKind !== ownerUnblockOrigin
    || !owner.originId || !uuidPattern.test(owner.originId)) invalidScope();
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, owner.originId), eq(issues.companyId, companyId), eq(issues.missionId, owner.missionId),
  ));
  if (!source) invalidScope();

  const [event] = await tx.select({ missionId: workflowTransitionEvents.missionId,
    issueId: workflowTransitionEvents.issueId, heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    workflowRunId: workflowTransitionEvents.workflowRunId,
    workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
    eventType: workflowTransitionEvents.eventType, layer: workflowTransitionEvents.layer,
    reason: workflowTransitionEvents.reason, reasonCode: workflowTransitionEvents.reasonCode,
    decision: workflowTransitionEvents.decision, correlationId: workflowTransitionEvents.correlationId,
    payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, input.sourceId), eq(workflowTransitionEvents.companyId, companyId),
  ));
  if (!event || event.missionId !== owner.missionId || event.issueId !== input.issueId || !isPayload(event.payload)
    || !hasSupportedEventBinding(event, input.issueId, source.id)) invalidScope();
  const payload = event.payload;
  if (event.heartbeatRunId) {
    if (!uuidPattern.test(event.heartbeatRunId)) invalidScope();
    const [heartbeat] = await tx.select({ issueId: heartbeatRuns.issueId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, event.heartbeatRunId), eq(heartbeatRuns.companyId, companyId),
    ));
    if (!heartbeat || heartbeat.issueId !== input.issueId) invalidScope();
  }
  const payloadOwner = payload.ownerActionIssueId;
  const payloadSource = payload.sourceIssueId;
  if ((payloadOwner !== undefined && payloadOwner !== input.issueId)
    || (payloadSource !== undefined && payloadSource !== source.id)) invalidScope();

  const runIds = [context.data.workflowRunId, snapshot.workflowRunId, event.workflowRunId]
    .filter((id): id is string => typeof id === "string");
  if (runIds.some((id) => !uuidPattern.test(id)) || new Set(runIds).size > 1) invalidScope();
  const runId = runIds[0];
  if (runId) {
    const [run] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
      eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, owner.missionId),
    ));
    if (!run) invalidScope();
  }

  const stepId = snapshot.stepRunId ?? event.workflowStepRunId;
  if (snapshot.stepRunId && event.workflowStepRunId && snapshot.stepRunId !== event.workflowStepRunId) invalidScope();
  if (stepId) {
    if (!uuidPattern.test(stepId) || (snapshot.executionGeneration != null && snapshot.stepRunId == null)) invalidScope();
    const [step] = await tx.select({ workflowRunId: workflowStepRuns.workflowRunId,
      executionGeneration: workflowStepRuns.executionGeneration, companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(eq(workflowStepRuns.id, stepId));
    if (!step || step.companyId !== companyId || step.missionId !== owner.missionId
      || (runId !== undefined && step.workflowRunId !== runId)
      || (snapshot.executionGeneration != null && step.executionGeneration !== snapshot.executionGeneration)) invalidScope();
  } else if (snapshot.stepRunStatus != null || snapshot.executionGeneration != null) invalidScope();
}

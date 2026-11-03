import { and, eq, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { readWorkflowAttemptProof } from "../heartbeat-finalization/workflow-attempt-proof.js";
import { validateQaRemediationCompletionEvidence, qaRemediationCompletionKey } from "./control-flow/qa-remediation-completion-evidence.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation,
  qaRemediationPreparationKey } from "./control-flow/qa-remediation-preparation-contract.js";

type Issue = { id: string; companyId: string; missionId: string | null };
type Context = { workflowRunId: string | null; workflowStepRunId: string | null };
type Attempt = { executionGeneration: number; wakeupRequestId: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const reject = (): never => { throw conflict("workflow_validation_attempt_unproven"); };

/** Only a persisted E signal selects strict proof parsing; unrelated ordinary verdicts keep their prior path. */
export async function proveReservedEOfficialAttempt(input: {
  db: Pick<Db, "select">; issue: Issue; actorAgentId?: string | null; heartbeatRunId?: string | null;
}, context: Context): Promise<Attempt | null> {
  const { heartbeatRunId } = input;
  if (!heartbeatRunId) return null;
  const { companyId, missionId } = input.issue;
  const [actual] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, heartbeatRunId)));
  const linkedWakes = await input.db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), actual?.wakeupRequestId
      ? or(eq(agentWakeupRequests.id, actual.wakeupRequestId), eq(agentWakeupRequests.runId, heartbeatRunId))
      : eq(agentWakeupRequests.runId, heartbeatRunId)));
  const wakeIds = new Set([...linkedWakes.map(wake => wake.id), ...(actual?.wakeupRequestId ? [actual.wakeupRequestId] : [])]);
  const completions = missionId && context.workflowRunId && context.workflowStepRunId
    ? await input.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
      eq(workflowTransitionEvents.workflowRunId, context.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_completed")))
    : [];
  const receiptSelectsE = completions.some(row => isRecord(row.payload) && Array.isArray(row.payload.wakes)
    && row.payload.wakes.some(wake => isRecord(wake) && typeof wake.wakeupRequestId === "string"
      && wakeIds.has(wake.wakeupRequestId) && wake.issueId === input.issue.id
      && wake.stepRunId === context.workflowStepRunId));
  const wakeSelectsE = linkedWakes.some(wake => wake.requestedByActorId === "workflow:qa-remediation"
    || wake.idempotencyKey?.startsWith("qa-remediation-refire-v2:") === true
    || (isRecord(wake.payload) && Object.hasOwn(wake.payload, "qaRemediationCompletion")));
  if (!wakeSelectsE && !receiptSelectsE) return null;
  if (!missionId || !context.workflowRunId || !context.workflowStepRunId) return reject();
  if (!actual || linkedWakes.length !== 1) return reject();

  const wake = linkedWakes[0]!;
  if (actual.companyId !== companyId || actual.id !== heartbeatRunId || actual.issueId !== input.issue.id
    || (input.actorAgentId && actual.agentId !== input.actorAgentId) || !actual.startedAt
    || !actual.wakeupRequestId || actual.wakeupRequestId !== wake.id || wake.runId !== actual.id) return reject();
  const wakePayload = isRecord(wake.payload) ? wake.payload : null;
  const pointer = wakePayload?.qaRemediationCompletion;
  if (!isRecord(pointer) || !isUuid(pointer.preparationEventId) || !isUuid(pointer.sourceVerdictEventId)) return reject();

  const [preparationRow] = await input.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.id, pointer.preparationEventId)));
  if (!preparationRow) return reject();
  let preparation: ReturnType<typeof parseQaRemediationPreparation>;
  try { preparation = parseQaRemediationPreparation(preparationRow.payload); } catch { return reject(); }
  if (preparationRow.id !== preparation.preparationId || preparationRow.eventType !== QA_REMEDIATION_PREPARATION_EVENT_TYPE
    || preparationRow.layer !== "workflow_validation" || preparationRow.companyId !== preparation.companyId
    || preparationRow.missionId !== preparation.missionId || preparationRow.workflowRunId !== preparation.workflowRunId
    || preparationRow.workflowStepRunId !== preparation.producer.stepRunId || preparationRow.issueId !== preparation.producer.issueId
    || preparationRow.executionGeneration !== preparation.producer.executionGeneration
    || preparationRow.idempotencyKey !== qaRemediationPreparationKey(preparation)
    || preparation.companyId !== companyId || preparation.missionId !== missionId
    || preparation.workflowRunId !== context.workflowRunId) return reject();

  const frozen = preparation.verdicts.filter(verdict => verdict.eventId === pointer.sourceVerdictEventId
    && verdict.qa.issueId === input.issue.id && verdict.qa.stepRunId === context.workflowStepRunId);
  if (frozen.length !== 1) return reject();
  const verdict = frozen[0]!;
  const [source] = await input.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.id, verdict.eventId)));
  const sourcePayload = source?.payload;
  if (!source || source.eventType !== "workflow_validation_verdict" || source.layer !== "workflow_validation"
    || source.reason !== "workflow_api" || source.reasonCode !== "workflow_api"
    || source.verdict !== "request_changes" || source.missionId !== missionId
    || source.workflowRunId !== context.workflowRunId || source.workflowStepRunId !== verdict.qa.stepRunId
    || source.issueId !== verdict.qa.issueId || source.heartbeatRunId !== verdict.heartbeatRunId
    || !isRecord(sourcePayload) || sourcePayload.kind !== "workflow_validation_verdict"
    || sourcePayload.workflowRunId !== context.workflowRunId || sourcePayload.stepRunId !== verdict.qa.stepRunId
    || sourcePayload.issueId !== verdict.qa.issueId || sourcePayload.verdict !== "request_changes") return reject();

  const completionRows = await input.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
    eq(workflowTransitionEvents.workflowRunId, context.workflowRunId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation))));
  if (completionRows.length !== 1) return reject();
  const validated = await validateQaRemediationCompletionEvidence(input.db as Db, completionRows[0]!, preparation);
  if (!validated.ok || !validated.completion.wakes.some(receipt => receipt.wakeupRequestId === wake.id
    && receipt.sourceVerdictEventId === verdict.eventId && receipt.agentId === wake.agentId
    && receipt.issueId === verdict.qa.issueId && receipt.stepRunId === verdict.qa.stepRunId
    && receipt.executionGeneration === verdict.qa.executionGeneration)) return reject();

  const [workflow] = await input.db.select().from(workflowRuns).where(and(
    eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId),
    eq(workflowRuns.id, context.workflowRunId)));
  const [step] = await input.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, context.workflowStepRunId), eq(workflowStepRuns.workflowRunId, context.workflowRunId),
    eq(workflowStepRuns.issueId, input.issue.id)));
  if (!workflow || !step || workflow.missionId !== missionId || step.workflowRunId !== workflow.id
    || step.issueId !== input.issue.id || step.id !== verdict.qa.stepRunId || step.stepId !== verdict.qa.stepId
    || step.executionGeneration !== verdict.qa.executionGeneration || step.retryCount !== verdict.qa.retryCount
    || step.iterationIndex !== verdict.qa.iterationIndex || actual.workflowStepRunId !== step.id
    || actual.workflowExecutionGeneration !== step.executionGeneration || wake.companyId !== companyId
    || wake.agentId !== actual.agentId || wake.issueId !== input.issue.id || wake.missionId !== missionId
    || wake.workflowRunId !== workflow.id || wake.workflowStepRunId !== step.id
    || wake.workflowExecutionGeneration !== step.executionGeneration || wake.requestKind !== "workflow_resume") return reject();
  let proof: ReturnType<typeof readWorkflowAttemptProof>;
  try { proof = readWorkflowAttemptProof(wake); } catch { return reject(); }
  if (proof.parentHeartbeatRunId !== actual.retryOfRunId || proof.retryCount !== step.retryCount
    || proof.iterationIndex !== step.iterationIndex || proof.executionGeneration !== step.executionGeneration) return reject();
  return { executionGeneration: step.executionGeneration, wakeupRequestId: wake.id };
}

import { and, eq, isNull } from "drizzle-orm";
import { activityLog, approvals, missions, workflowRuns, workflowRecoveryAuthorities, workflowRunDefinitions, type Db } from "@paperclipai/db";
import type { Express } from "express";
import { replacementIntentSchema, replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { conflict, forbidden } from "../../errors.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { normalizeWorkflowRunInputs } from "./run-input-normalization.js";
import { lockReplacementScope, lockReplacementDefinition } from "./replacement-scope.js";
import { replacementDefinitionHash } from "./replacement-definition.js";
import { createWorkflowRunWithDefinition } from "./workflow-run-create.js";
import type { CreateWorkflowRunInput } from "./types.js";

export type TriggerActor = Express.Request["actor"];
export async function assertAgentReplacementRequired(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  if (actor?.type !== "agent" || !input.missionId) return;
  const [prior] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId),
    eq(workflowRuns.missionId, input.missionId), eq(workflowRuns.workflowId, input.workflowId), isNull(workflowRuns.parentRunId))).limit(1);
  if (prior && !input.replacementIntent) throw conflict("replacement_authority_required");
}

// Shared REST/plugin boundary. Caller transport/triggeredBy never changes request meaning.
export async function admitReplacement(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  const intent = replacementIntentSchema.parse(input.replacementIntent);
  if (actor?.type !== "agent" || !actor.agentId || actor.companyId !== input.companyId) throw forbidden("replacement_requester_required");
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [observed] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, intent.sourceRunId), eq(workflowRuns.companyId, input.companyId)));
    if (!observed?.missionId || observed.missionId !== input.missionId || observed.workflowId !== input.workflowId) throw conflict("replacement_scope_mismatch");
    await tx.select().from(missions).where(eq(missions.id, observed.missionId)).for("update");
    const [source] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, observed.id)).for("update");
    if (source.status === "cancelled") throw conflict("replacement_source_cancelled");
    const requestHashFor = (metadata: Record<string, unknown>) => hashStructuredValue({ intent, companyId: input.companyId,
      missionId: input.missionId, workflowId: input.workflowId, metadata, requester: actor.agentId });
    const [used] = await tx.select().from(workflowRecoveryAuthorities).where(and(eq(workflowRecoveryAuthorities.workflowRunId, source.id),
      eq(workflowRecoveryAuthorities.targetAuthorityVersion, intent.expectedSourceAuthorityVersion)));
    if (used) {
      const contract = replacementApprovalPayloadSchema.safeParse(Object.fromEntries(Object.entries(used.replacementContract ?? {}).filter(([k]) => k !== "approver")));
      const metadata = contract.success ? normalizeWorkflowRunInputs(contract.data.inputContract, input.metadata) : input.metadata ?? {};
      if (used.recoveryKind !== "replacement_from_start_v1" || used.requestHash !== requestHashFor(metadata) || !used.replacementRunId) throw conflict("replacement_authority_consumed");
      const [target] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, used.replacementRunId));
      if (!target) throw conflict("replacement_target_missing");
      return { run: target, replay: true };
    }
    const scope = await lockReplacementScope(t, input.companyId, source.id, intent.decisionEventId);
    const [approval] = await tx.select().from(approvals).where(and(eq(approvals.id, intent.approvalId), eq(approvals.companyId, input.companyId))).for("update");
    if (!approval || approval.type !== "workflow_replacement" || approval.status !== "approved" || !approval.decidedByUserId
      || approval.decidedByUserId.startsWith("agent:")) throw conflict("replacement_operator_approval_required");
    const parsed = replacementApprovalPayloadSchema.safeParse(approval.payload);
    if (!parsed.success) throw conflict("replacement_approval_invalid");
    const p = parsed.data;
    const definition = await lockReplacementDefinition(t, input.companyId, source.workflowId);
    const metadata = normalizeWorkflowRunInputs(p.inputContract, input.metadata);
    const requestHash = requestHashFor(metadata);
    if (p.sourceRunId !== source.id || p.companyId !== input.companyId || p.missionId !== input.missionId || p.workflowId !== input.workflowId
      || p.sourceAuthorityVersion !== source.dispatchAuthorityVersion || p.sourceAuthorityVersion !== intent.expectedSourceAuthorityVersion
      || p.terminalDecisionId !== scope.terminal.id || p.decisionEventId !== intent.decisionEventId || p.idempotencyKey !== intent.idempotencyKey
      || p.requesterAgentId !== actor.agentId || p.requesterAgentId !== scope.mission.ownerAgentId
      || p.stepRunId !== scope.step.id || p.requestGeneration !== scope.step.executionGeneration
      || p.inputHash !== hashStructuredValue(metadata) || p.inputHash !== hashStructuredValue(p.metadata)
      || p.definitionHash !== replacementDefinitionHash(definition, scope.mission.id, p.targetRunId)) throw conflict("replacement_approval_scope_mismatch");
    const authorityId = crypto.randomUUID();
    const run = await createWorkflowRunWithDefinition(t, { ...input, metadata: { ...p.metadata, replacementAuthorityId: authorityId } }, p.targetRunId);
    const [frozen] = await tx.select().from(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, run.id));
    if (frozen.definitionHash !== p.definitionHash) throw conflict("replacement_definition_changed");
    await tx.insert(workflowRecoveryAuthorities).values({ id: authorityId, companyId: input.companyId, workflowRunId: source.id,
      targetAuthorityVersion: source.dispatchAuthorityVersion, resultingAuthorityVersion: source.dispatchAuthorityVersion,
      targetDecisionId: scope.terminal.id, recoveryKind: "replacement_from_start_v1", requestReference: intent.idempotencyKey,
      requestedBy: actor.agentId, ownerDecisionEventId: intent.decisionEventId, operatorApprovalId: approval.id,
      replacementRunId: run.id, requestHash, replacementContract: { ...p, approver: approval.decidedByUserId }, status: "consumed", consumedAt: new Date() });
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "agent", actorId: actor.agentId,
      action: "workflow.replacement_admitted", entityType: "workflow_run", entityId: run.id,
      details: { authorityId, sourceRunId: source.id, approvalId: approval.id, requestHash, definitionHash: p.definitionHash } });
    return { run, replay: false };
  });
}

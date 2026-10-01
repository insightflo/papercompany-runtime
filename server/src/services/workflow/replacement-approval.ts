import { and, eq } from "drizzle-orm";
import { approvals, activityLog, type Db } from "@paperclipai/db";
import type { Express } from "express";
import { proposeReplacementSchema, replacementApprovalPayloadSchema, replacementDecisionSchema, resubmitReplacementSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { conflict, forbidden } from "../../errors.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { lockReplacementScope, lockReplacementDefinition } from "./replacement-scope.js";
import { replacementDefinitionHash } from "./replacement-definition.js";
import { normalizeWorkflowRunInputs } from "./run-input-normalization.js";

function board(actor: Express.Request["actor"], companyId: string) {
  if (actor.type !== "board" || (!actor.userId && actor.source !== "local_implicit")
    || (actor.source !== "local_implicit" && !actor.isInstanceAdmin && !actor.companyIds?.includes(companyId))) throw forbidden("replacement_operator_required");
  return actor.userId ?? "local-board";
}
export async function proposeReplacement(db: Db, companyId: string, actor: Express.Request["actor"], raw: unknown) {
  const userId = board(actor, companyId), input = proposeReplacementSchema.parse(raw);
  return db.transaction(async (tx) => {
    const scope = await lockReplacementScope(tx as unknown as Db, companyId, input.sourceRunId, input.decisionEventId);
    const definition = await lockReplacementDefinition(tx as unknown as Db, companyId, scope.run.workflowId);
    const targetRunId = crypto.randomUUID();
    const metadata = normalizeWorkflowRunInputs(definition.runInputs as never, input.metadata);
    if ("replacementAuthorityId" in metadata || "executionDefinitionVersion" in metadata || "replacementStart" in metadata) throw conflict("replacement_reserved_metadata");
    const payload = replacementApprovalPayloadSchema.parse({ schemaVersion: 1, companyId, missionId: scope.mission.id,
      workflowId: scope.run.workflowId, sourceRunId: scope.run.id, sourceAuthorityVersion: scope.run.dispatchAuthorityVersion,
      terminalDecisionId: scope.terminal.id, decisionEventId: scope.owner.eventId, requesterAgentId: scope.mission.ownerAgentId,
      targetRunId, requestGeneration: scope.step.executionGeneration, stepRunId: scope.step.id,
      definitionHash: await replacementDefinitionHash(tx, definition, scope.mission.id, targetRunId), inputHash: hashStructuredValue(metadata),
      inputContract: definition.runInputs ?? [],
      metadata, idempotencyKey: input.idempotencyKey, externalEffects: input.externalEffects });
    const [approval] = await tx.insert(approvals).values({ companyId, type: "workflow_replacement", status: "pending",
      requestedByAgentId: scope.mission.ownerAgentId, requestedByUserId: userId, payload }).returning();
    await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: "workflow.replacement_proposed",
      entityType: "approval", entityId: approval.id, details: { sourceRunId: scope.run.id, targetRunId, payloadHash: hashStructuredValue(payload) } });
    return approval;
  });
}
export async function approveReplacement(db: Db, companyId: string, approvalId: string, actor: Express.Request["actor"], raw: unknown = {}) {
  const userId = board(actor, companyId), input = replacementDecisionSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [observed] = await tx.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
    const parsed = replacementApprovalPayloadSchema.safeParse(observed?.payload);
    if (!observed || observed.type !== "workflow_replacement" || !parsed.success) throw conflict("replacement_approval_invalid");
    const p = parsed.data;
    const scope = await lockReplacementScope(tx as unknown as Db, companyId, p.sourceRunId, p.decisionEventId);
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    const definition = await lockReplacementDefinition(tx as unknown as Db, companyId, scope.run.workflowId);
    if (approval.status !== "pending" || hashStructuredValue(approval.payload) !== hashStructuredValue(p)
      || p.definitionHash !== await replacementDefinitionHash(tx, definition, scope.mission.id, p.targetRunId)
      || p.sourceAuthorityVersion !== scope.run.dispatchAuthorityVersion || p.requestGeneration !== scope.step.executionGeneration) throw conflict("replacement_approval_stale");
    const [updated] = await tx.update(approvals).set({ status: "approved", decidedByUserId: userId, decisionNote: input.decisionNote ?? null, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"))).returning();
    await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: "workflow.replacement_approved",
      entityType: "approval", entityId: approvalId, details: { payloadHash: hashStructuredValue(p) } });
    return updated;
  });
}

// Rejection can close stale proposals too; neither action grants execution authority.
export async function resolveReplacement(db: Db, companyId: string, approvalId: string, actor: Express.Request["actor"],
  status: "rejected" | "revision_requested", raw: unknown = {}) {
  const userId = board(actor, companyId), input = replacementDecisionSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [approval] = await tx.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId))).for("update");
    if (!approval || approval.type !== "workflow_replacement") throw conflict("replacement_approval_invalid");
    if (approval.status !== "pending" && !(status === "rejected" && approval.status === "revision_requested")) throw conflict("replacement_approval_stale");
    const [updated] = await tx.update(approvals).set({ status, decidedByUserId: userId, decisionNote: input.decisionNote ?? null,
      decidedAt: new Date(), updatedAt: new Date() }).where(and(eq(approvals.id, approvalId), eq(approvals.status, approval.status))).returning();
    if (!updated) throw conflict("replacement_approval_stale");
    await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: `workflow.replacement_${status}`,
      entityType: "approval", entityId: approvalId, details: { payloadHash: hashStructuredValue(approval.payload) } });
    return updated;
  });
}

export async function resubmitReplacement(db: Db, companyId: string, approvalId: string, actor: Express.Request["actor"], raw: unknown = {}) {
  const userId = board(actor, companyId), input = resubmitReplacementSchema.parse(raw);
  return db.transaction(async (tx) => {
    const [observed] = await tx.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.companyId, companyId)));
    const parsed = replacementApprovalPayloadSchema.safeParse(observed?.payload);
    if (!observed || observed.type !== "workflow_replacement" || !parsed.success) throw conflict("replacement_approval_invalid");
    if (observed.status !== "revision_requested") throw conflict("replacement_approval_stale");
    const p = parsed.data, t = tx as unknown as Db;
    const scope = await lockReplacementScope(t, companyId, p.sourceRunId, input.decisionEventId ?? p.decisionEventId);
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    if (approval.status !== "revision_requested" || hashStructuredValue(approval.payload) !== hashStructuredValue(p)) throw conflict("replacement_approval_stale");
    const definition = await lockReplacementDefinition(t, companyId, scope.run.workflowId);
    const metadata = normalizeWorkflowRunInputs(definition.runInputs as never, input.metadata ?? p.metadata);
    if ("replacementAuthorityId" in metadata || "executionDefinitionVersion" in metadata || "replacementStart" in metadata) throw conflict("replacement_reserved_metadata");
    const payload = replacementApprovalPayloadSchema.parse({ ...p, companyId, missionId: scope.mission.id, workflowId: scope.run.workflowId,
      sourceAuthorityVersion: scope.run.dispatchAuthorityVersion, terminalDecisionId: scope.terminal.id,
      decisionEventId: scope.owner.eventId, requesterAgentId: scope.mission.ownerAgentId,
      requestGeneration: scope.step.executionGeneration, stepRunId: scope.step.id,
      definitionHash: await replacementDefinitionHash(tx, definition, scope.mission.id, p.targetRunId), inputHash: hashStructuredValue(metadata),
      inputContract: definition.runInputs ?? [], metadata, idempotencyKey: input.idempotencyKey ?? p.idempotencyKey,
      externalEffects: input.externalEffects ?? p.externalEffects });
    const [updated] = await tx.update(approvals).set({ status: "pending", payload, requestedByUserId: userId,
      decisionNote: null, decidedByUserId: null, decidedAt: null, updatedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "revision_requested"))).returning();
    if (!updated) throw conflict("replacement_approval_stale");
    await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: userId, action: "workflow.replacement_resubmitted",
      entityType: "approval", entityId: approvalId, details: { previousPayloadHash: hashStructuredValue(p), payloadHash: hashStructuredValue(payload) } });
    return updated;
  });
}

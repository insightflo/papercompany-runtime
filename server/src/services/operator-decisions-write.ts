import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  sameOperatorDecisionResult,
  validateAndHashOperatorDecisionCreate,
  validateOperatorDecisionResult,
} from "./operator-decision-result.js";
import { operatorDecisionContinuationRetryService } from "./operator-decision-continuation-retry.js";
import { operatorDecisionReadService } from "./operator-decisions-read.js";

export type OperatorDecisionActor = { type: "agent" | "user"; id: string };

function conflictFor(id: string, status: string, message = "Operator decision conflict") {
  return conflict(message, { operatorDecisionId: id, status });
}

export function operatorDecisionWriteService(db: Db) {
  const read = operatorDecisionReadService(db);
  const retry = operatorDecisionContinuationRetryService(db);

  async function assertCreateOwnership(
    companyId: string,
    input: CreateOperatorDecisionInput,
    actor: OperatorDecisionActor,
  ) {
    if (actor.type === "agent") {
      const requester = await db.select({ companyId: agents.companyId }).from(agents)
        .where(eq(agents.id, actor.id)).then((rows) => rows[0] ?? null);
      if (!requester || requester.companyId !== companyId) throw forbidden("Agent key cannot access another company");
    }
    if (input.issueId) {
      const issue = await db.select({ companyId: issues.companyId }).from(issues)
        .where(eq(issues.id, input.issueId)).then((rows) => rows[0] ?? null);
      if (!issue || issue.companyId !== companyId) throw unprocessable("Linked issue must belong to the company");
    }
  }

  async function loadReplay(companyId: string, requestKey: string, requestHash: string) {
    const existing = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, companyId),
      eq(operatorDecisions.requestKey, requestKey),
    )).then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw conflictFor(existing.id, existing.status, "Operator decision request key conflict");
    return { decision: (await read.getRequired(existing.id)), replayed: true };
  }

  async function create(companyId: string, rawInput: unknown, actor: OperatorDecisionActor) {
    const validated = validateAndHashOperatorDecisionCreate(rawInput);
    await assertCreateOwnership(companyId, validated.input, actor);
    const replay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
    if (replay) return replay;

    let id: string;
    try {
      id = await db.transaction(async (tx) => {
        const [created] = await tx.insert(operatorDecisions).values({
          companyId,
          requestKey: validated.input.requestKey,
          requestHash: validated.requestHash,
          schemaVersion: 1,
          priority: validated.input.priority,
          interactionType: validated.input.interactionType,
          title: validated.input.title,
          description: validated.input.description,
          sourceType: validated.input.sourceType,
          sourceId: validated.input.sourceId,
          sourceContext: validated.input.sourceContext,
          issueId: validated.input.issueId,
          requestedByAgentId: actor.type === "agent" ? actor.id : null,
          requestedByUserId: actor.type === "user" ? actor.id : null,
          definition: validated.input.definition,
          continuationMode: validated.input.continuationMode,
        }).returning({ id: operatorDecisions.id });
        await tx.insert(activityLog).values({
          companyId,
          actorType: actor.type,
          actorId: actor.id,
          agentId: actor.type === "agent" ? actor.id : null,
          action: "operator_decision.created",
          entityType: "operator_decision",
          entityId: created!.id,
          details: {
            schemaVersion: 1,
            operatorDecisionId: created!.id,
            requestKey: validated.input.requestKey,
            priority: validated.input.priority,
            interactionType: validated.input.interactionType,
            sourceType: validated.input.sourceType,
            sourceId: validated.input.sourceId,
            issueId: validated.input.issueId,
            continuationMode: validated.input.continuationMode,
          },
        });
        return created!.id;
      });
    } catch (error) {
      const concurrentReplay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
      if (concurrentReplay) return concurrentReplay;
      throw error;
    }
    return { decision: await read.getRequired(id), replayed: false };
  }

  async function resolve(id: string, rawInput: unknown, resolvedByUserId: string) {
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    const result = validateOperatorDecisionResult(before.definition, rawInput);

    const applied = await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.update(operatorDecisions).set({
        status: "resolved",
        result,
        resolvedByUserId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        const current = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
          .then((rows) => rows[0] ?? null);
        if (current?.status === "resolved" && sameOperatorDecisionResult(current.result, result)) return false;
        throw conflictFor(id, current?.status ?? "missing");
      }
      let continuationId: string | null = null;
      if (updated.continuationMode === "issue_current_assignee") {
        continuationId = await tx.insert(operatorDecisionContinuations).values({
          companyId: updated.companyId,
          operatorDecisionId: id,
          issueId: updated.issueId,
          state: "pending",
          nextAttemptAt: now,
        }).returning({ id: operatorDecisionContinuations.id }).then((rows) => rows[0]!.id);
      }
      await tx.insert(activityLog).values({
        companyId: updated.companyId,
        actorType: "user",
        actorId: resolvedByUserId,
        action: "operator_decision.resolved",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          actionId: result.actionId,
          outcome: result.outcome,
          selectedOptionIds: result.selectedOptionIds,
          commentPresent: result.comment !== null,
          resolvedByUserId,
          resolvedAt: now.toISOString(),
          issueId: updated.issueId,
          continuationId,
        },
      });
      return true;
    });
    const decision = await read.getRequired(id);
    return { decision, applied, continuation: decision.continuation };
  }

  async function cancel(id: string, actor: OperatorDecisionActor) {
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    if (actor.type === "agent" && before.requestedByAgentId !== actor.id) throw forbidden("Only the requester can cancel this decision");
    if (before.status === "cancelled") return { decision: await read.getRequired(id), applied: false };
    if (before.status !== "pending") throw conflictFor(id, before.status);
    await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.update(operatorDecisions).set({ status: "cancelled", cancelledAt: now, updatedAt: now })
        .where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning({ id: operatorDecisions.id });
      if (updated.length !== 1) throw conflictFor(id, "terminal");
      await tx.insert(activityLog).values({
        companyId: before.companyId,
        actorType: actor.type,
        actorId: actor.id,
        agentId: actor.type === "agent" ? actor.id : null,
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          cancelledByActorType: actor.type,
          cancelledByActorId: actor.id,
          cancelledAt: now.toISOString(),
        },
      });
    });
    return { decision: await read.getRequired(id), applied: true };
  }

  return { create, resolve, cancel, retryContinuation: retry.retryContinuation };
}

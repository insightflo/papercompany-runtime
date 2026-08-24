import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  issueComments,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
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

// [delivery bridge] definition.options × result.selectedOptionIds 를 한국어 라벨+영어 식별자로 해석한다.
//   규칙 8: 이 표시용 해석은 권위가 아니며, 권위는 operator_decisions.result + activity log 에 있다.
function resolveSelectedOptions(
  definition: CreateOperatorDecisionInput["definition"],
  selectedOptionIds: readonly string[],
): { id: string; label: string; description: string | null }[] {
  const byId = new Map(definition.options.map((option) => [option.id, option]));
  return selectedOptionIds
    .map((optionId) => {
      const option = byId.get(optionId);
      return option
        ? { id: option.id, label: option.label, description: option.description }
        : { id: optionId, label: optionId, description: null };
    });
}

// [delivery bridge] resolve 직후 이슈에 남는 시스템 코멘트(저자 null). 이미 running인 런도 다음 실행에서
//   brief 의 recentIssueComments 로 이 결정을 본다. 삽입 실패는 resolve 를 깨지 않는다(display 계층).
async function insertOperatorDecisionResolvedComment(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    operatorDecisionId: string;
    selectedOptions: { id: string; label: string; description: string | null }[];
  },
): Promise<void> {
  const selectionLines = input.selectedOptions.map((option) =>
    `- 선택: ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const body = [
    "## 운영자 결정 반영 (operator decision resolved)",
    ...selectionLines,
    `- operatorDecisionId: ${input.operatorDecisionId}`,
    "- 다음 실행자는 이 결정을 우선 지시로 따른다.",
  ].join("\n");
  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      body,
    });
  } catch (error) {
    logger.warn({
      msg: "Failed to insert operator-decision resolved system comment",
      operatorDecisionId: input.operatorDecisionId,
      issueId: input.issueId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
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
    // [card alert] 신규 생성(비-replay)에만 발행한다 — replay 는 이미 알림을 받았으므로 멱등하게 스킵.
    publishLiveEvent({
      companyId,
      type: "operator_decision.created",
      payload: {
        operatorDecisionId: id,
        issueId: validated.input.issueId,
        missionId: validated.input.sourceContext.missionId ?? null,
        title: validated.input.title,
        priority: validated.input.priority,
      },
    });
    return { decision: await read.getRequired(id), replayed: false };
  }

  async function resolve(id: string, rawInput: unknown, resolvedByUserId: string) {
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    const result = validateOperatorDecisionResult(before.definition, rawInput);
    if (before.status === "pending" && !before.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계가 없어 결정할 수 없습니다. 요청자에게 정보 보완을 요구해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

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
    // [delivery bridge] applied(첫 적용)에만 코멘트를 남긴다 — replay 는 이미 코멘트가 존재한다.
    //   이슈가 삭제된 경우 decision.issueId 는 FK(set null) 로 비어 자연 스킵된다.
    if (applied && decision.issueId) {
      await insertOperatorDecisionResolvedComment(db, {
        companyId: decision.companyId,
        issueId: decision.issueId,
        operatorDecisionId: id,
        selectedOptions: resolveSelectedOptions(decision.definition, result.selectedOptionIds),
      });
    }
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

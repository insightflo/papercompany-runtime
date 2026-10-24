import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issues, operatorDecisions } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { publishLiveEvent } from "./live-events.js";
import { validateAndHashOperatorDecisionCreate } from "./operator-decision-result.js";
import { MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE, readTargetSnapshot } from "./operator-decision-currentness.js";
import { activePlanDecisionHash } from "./operator-decision-server-context.js";
import type { operatorDecisionReadService } from "./operator-decisions-read.js";
import { connectOwnerHumanRequestCard, isOwnerHumanLifetimeCard, lockOwnerHumanRequestCard } from "./missions/owner-human-request-card.js";

export type OperatorDecisionActor = { type: "agent" | "user"; id: string };

 type OperatorDecisionCreateDependencies = {
  read: Pick<ReturnType<typeof operatorDecisionReadService>, "getRequired">;
  conflictFor: (id: string, status: string, message?: string) => ReturnType<typeof conflict>;
};

export function operatorDecisionCreateService(db: Db, { read, conflictFor }: OperatorDecisionCreateDependencies) {
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
    const lifetimeCard = isOwnerHumanLifetimeCard(validated.input);
    // Lifetime replay must pass the same locked authority/binding checks as a new create.
    if (!lifetimeCard) {
      const replay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
      if (replay) return replay;
    }

    // [결정 가능성 게이트] 판단 정보 패킷(definition.humanReview)이 없는 카드는 UI 버튼 잠금과
    // resolve 422(human_review_packet_required)로 결정 불가능한 죽은 카드가 된다(실제 사례:
    // 2026-10-06 rebind 승인 요청 2건). 생성 단계에서 거부해 요청자가 패킷을 갖춰 다시 만들게 한다.
    // 일반/구형 replay 는 이 게이트 앞에서 반환한다. 새 수명 카드는 아래 잠금 검사를 거친다.
    if (!validated.input.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계(definition.humanReview)가 없는 결정 카드는 만들 수 없습니다. 패킷을 갖춰 다시 요청해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

    // [currentness gate] 스냅샷이 있으면 서버가 재검증할 식별자(issueId/workflowRunId/stepRunId)가
    //   최소 1개 필요하다 — 없으면 재검증 불가능한 죽은 스냅샷이 되므로 생성 단계에서 거부한다.
    const targetSnapshot = readTargetSnapshot(validated.input.sourceContext);
    if (targetSnapshot && targetSnapshot.issueId == null && targetSnapshot.workflowRunId == null && targetSnapshot.stepRunId == null) {
      throw unprocessable(
        "targetSnapshot 은 issueId, workflowRunId, stepRunId 중 최소 하나를 지정해야 합니다.",
        { code: "target_snapshot_identifier_required" },
      );
    }

    let committed: { id: string; replayed: boolean };
    try {
      committed = await db.transaction(async (tx) => {
        const ownerCard = await lockOwnerHumanRequestCard(tx, companyId, validated.input, actor);
        if (ownerCard?.card) return { id: ownerCard.card.id, replayed: true };
        let storedSourceContext: typeof operatorDecisions.$inferInsert.sourceContext = validated.input.sourceContext;
        if (validated.input.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE
          && validated.input.sourceContext.missionId) {
          storedSourceContext = { ...storedSourceContext,
            planDecisionHash: await activePlanDecisionHash(tx, companyId, validated.input.sourceContext.missionId) };
        }
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
          sourceContext: storedSourceContext,
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
        await connectOwnerHumanRequestCard(tx, ownerCard, created!.id);
        return { id: created!.id, replayed: false };
      });
    } catch (error) {
      // A transaction error/response loss is not permission to replay an obsolete lifetime.
      const currentCardId = lifetimeCard ? await db.transaction(async (tx) => {
        const current = await lockOwnerHumanRequestCard(tx, companyId, validated.input, actor);
        return current?.card?.id ?? null;
      }) : null;
      const concurrentReplay = lifetimeCard
        ? currentCardId ? { decision: await read.getRequired(currentCardId), replayed: true } : null
        : await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
      if (concurrentReplay) return concurrentReplay;
      throw error;
    }
    const { id, replayed } = committed;
    if (replayed) return { decision: await read.getRequired(id), replayed: true };
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

  return { create };
}

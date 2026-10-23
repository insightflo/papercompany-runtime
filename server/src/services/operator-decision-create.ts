import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issues, operatorDecisions } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { publishLiveEvent } from "./live-events.js";
import { validateAndHashOperatorDecisionCreate } from "./operator-decision-result.js";
import { readTargetSnapshot } from "./operator-decision-currentness.js";
import type { operatorDecisionReadService } from "./operator-decisions-read.js";

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
    const replay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
    if (replay) return replay;

    // [결정 가능성 게이트] 판단 정보 패킷(definition.humanReview)이 없는 카드는 UI 버튼 잠금과
    // resolve 422(human_review_packet_required)로 결정 불가능한 죽은 카드가 된다(실제 사례:
    // 2026-10-06 rebind 승인 요청 2건). 생성 단계에서 거부해 요청자가 패킷을 갖춰 다시 만들게 한다.
    // replay 는 멱등 유지를 위해 게이트 앞에서 반환된다(기존 행은 cancel 경로로 정리).
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

  return { create };
}

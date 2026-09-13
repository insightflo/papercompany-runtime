// server/src/routes/quality-actions.ts
//
// [purpose] T5 Quality 조치 전용 경로: scoped loader(회사별 404), 결정 카드 생성,
//   사람 결정 resolve. resolve 커밋 후에만 기존 native 전달(deliverQualityIntent)을 호출하고
//   전달은 다시 현재 정책·대상·바인딩을 확인한다(§3.3 5-6).
// [boundary] 다른 회사 행은 scoped select 에서 404 로 끝난다(기존 전역 authz 403 동작 불변).
//   hold/reject/expired 는 전달·깨우기·댓글 부작용을 만들지 않는다.

import { Router, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { operatorDecisions, qualityActions } from "@paperclipai/db";
import { uuidSchema, type QualityHumanActor } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { createQualityDecisionCard, resolveQualityDecision, resolveQualityDecisionInputSchema } from "../services/quality/decisions.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";

function humanActor(req: Request, companyId: string): QualityHumanActor {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  const { userId, source, keyId } = req.actor;
  if (!userId || !source || !["session", "board_key", "local_implicit"].includes(source)) throw forbidden("quality_human_required");
  return { userId, source: source as QualityHumanActor["source"], keyId: keyId ?? null };
}

const cardBodySchema = z.object({ supersedesDecisionId: uuidSchema.nullable().optional() }).strict();
const resolveBodySchema = resolveQualityDecisionInputSchema.omit({ actionId: true });

export function qualityActionsRoutes(db: Db): Router {
  const router = Router();

  // Quality scoped loader — 다른 회사/없는 조치는 404(표시 투영, 실행 권위 아님).
  router.get("/companies/:companyId/quality-actions/:actionId", async (req, res) => {
    const companyId = uuidSchema.parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const actionId = uuidSchema.parse(req.params.actionId);
    const [action] = await db.select({
      id: qualityActions.id, companyId: qualityActions.companyId, groupId: qualityActions.groupId,
      kind: qualityActions.kind, state: qualityActions.state, revision: qualityActions.revision,
      policyVersionId: qualityActions.policyVersionId, intentKey: qualityActions.intentKey,
      target: qualityActions.target, effect: qualityActions.effect,
      createdAt: qualityActions.createdAt, updatedAt: qualityActions.updatedAt,
      cancelRequestedAt: qualityActions.cancelRequestedAt,
    }).from(qualityActions).where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, actionId)));
    if (!action) throw notFound("quality_action_not_found");
    const [pending] = await db.select({
      operatorDecisionId: operatorDecisions.id, qualityBinding: operatorDecisions.qualityBinding,
    }).from(operatorDecisions)
      .where(and(eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.qualityActionId, actionId), eq(operatorDecisions.status, "pending")))
      .orderBy(desc(operatorDecisions.createdAt)).limit(1);
    const binding = pending?.qualityBinding as { expiresAt?: string } | null;
    res.json({
      data: {
        action,
        pendingDecision: pending ? { operatorDecisionId: pending.operatorDecisionId, expiresAt: binding?.expiresAt ?? null } : null,
      },
    });
  });

  // 결정 카드 생성(서버 전용 binding, continuationMode=none 강제).
  router.post("/companies/:companyId/quality-actions/:actionId/decision-card", async (req, res) => {
    const companyId = uuidSchema.parse(req.params.companyId);
    const actor = humanActor(req, companyId);
    const actionId = uuidSchema.parse(req.params.actionId);
    const body = cardBodySchema.parse(req.body ?? {});
    const card = await createQualityDecisionCard(db, actor, {
      companyId, actionId, supersedesDecisionId: body.supersedesDecisionId ?? null,
    });
    res.status(card.replayed ? 200 : 201).json({ data: card });
  });

  // 사람 결정 resolve — 커밋 후 승인 효과만 기존 전달 경로로(현재 대상 재확인).
  router.post("/companies/:companyId/quality-actions/:actionId/resolve", async (req, res) => {
    const companyId = uuidSchema.parse(req.params.companyId);
    const actor = humanActor(req, companyId);
    const actionId = uuidSchema.parse(req.params.actionId);
    const body = resolveBodySchema.parse(req.body);
    const resolved = await resolveQualityDecision(db, actor, { ...body, actionId });
    let delivery: { status: string; receiptId: string | null } | { status: string; receiptId: null } = { status: "skipped", receiptId: null };
    if (!resolved.replayed) {
      const [decision] = await db.select({ result: operatorDecisions.result }).from(operatorDecisions)
        .where(eq(operatorDecisions.id, body.operatorDecisionId));
      if (decision?.result?.outcome === "submit") {
        try {
          delivery = await deliverQualityIntent(db, { companyId, actionId });
        } catch {
          // 결정·허용 intent 는 이미 커밋됐다. 전달 실패는 표시하고 재조정기가 같은 intent 를 다시 읽는다.
          delivery = { status: "delivery_error", receiptId: null };
        }
      }
    }
    res.json({ data: { ...resolved, delivery } });
  });

  return router;
}

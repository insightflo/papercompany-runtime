/**
 * Strategy Playbook Routes (쇼츠 컴퍼니 Phase F)
 *
 * Endpoints:
 * - GET   /companies/:companyId/strategy-playbook  — 회사 스코프 전체 목록
 * - POST  /companies/:companyId/strategy-playbook  — 제안 생성 (status 항상 'proposed' 강제)
 * - PATCH /strategy-playbook/:id                    — status 전이만 (active/retired 전이는 보드 전용)
 *
 * 권한:
 * - 목록/제안 생성: 회사 스코프 내 board 토큰 또는 agent 키 모두 허용.
 * - 활성화(active)/은퇴(retired) 전이: board 전용. agent 키는 403.
 * - 모든 mutation 은 activity log 를 남긴다.
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  strategyPlaybookChannelSchema,
  strategyPlaybookStatusSchema,
  strategyPlaybookCreateProposalSchema,
  strategyPlaybookUpdateSchema,
} from "@paperclipai/shared";
import { strategyPlaybookStore } from "../services/strategy-playbook.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { unprocessable } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

export function strategyPlaybookRoutes(db: Db) {
  const router = Router();
  const store = strategyPlaybookStore(db);

  /**
   * GET /companies/:companyId/strategy-playbook
   * 쿼리 ?status=proposed&channel=knowledge 로 필터 가능.
   */
  router.get("/companies/:companyId/strategy-playbook", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const status = req.query.status as string | undefined;
    const channel = req.query.channel as string | undefined;
    if (status !== undefined && !strategyPlaybookStatusSchema.safeParse(status).success) {
      throw unprocessable(`Invalid status filter: ${status}`);
    }
    if (channel !== undefined && !strategyPlaybookChannelSchema.safeParse(channel).success) {
      throw unprocessable(`Invalid channel filter: ${channel}`);
    }

    const entries = await store.list(companyId, { status, channel });
    res.json({ entries });
  });

  /**
   * POST /companies/:companyId/strategy-playbook
   * 제안 생성. 요청 스키마에 status 필드가 없어서 status 를 실어 보내면
   * strict 검증으로 422 거부된다(무시하지 않는다). 생성 결과는 항상 proposed.
   */
  router.post("/companies/:companyId/strategy-playbook", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const parsed = strategyPlaybookCreateProposalSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw unprocessable("Invalid strategy playbook proposal", parsed.error.issues);
    }

    const actor = getActorInfo(req);
    // agent 키로 만든 제안만 proposedByAgentId 를 기록한다. board 생성 제안은 null.
    const proposedByAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;

    const entry = await store.create({
      companyId,
      ...parsed.data,
      proposedByAgentId,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "strategy_playbook.proposed",
      entityType: "strategy_playbook_entry",
      entityId: entry.id,
      details: {
        channel: entry.channel,
        triggerType: entry.triggerType,
        actionType: entry.actionType,
        status: entry.status,
        proposedByAgentId,
      },
    });

    res.status(201).json(entry);
  });

  /**
   * PATCH /strategy-playbook/:id
   * status 전이만 허용. active/retired 로 가는 전이는 board 전용(agent 403).
   * 전이 방향 검증(proposed→active, active→retired)은 스토어가 담당(위반 시 409).
   */
  router.patch("/strategy-playbook/:id", async (req, res) => {
    const existing = await store.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const parsed = strategyPlaybookUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw unprocessable("Invalid strategy playbook update", parsed.error.issues);
    }
    const { status } = parsed.data;

    // 유효한 전이는 모두 active/retired 로 끝나므로 PATCH 전체가 board 전용이다.
    assertBoard(req);

    const updated = await store.transition(req.params.id, status);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `strategy_playbook.${status}`,
      entityType: "strategy_playbook_entry",
      entityId: req.params.id,
      details: {
        from: existing.status,
        to: status,
        channel: updated.channel,
        triggerType: updated.triggerType,
      },
    });

    res.json(updated);
  });

  return router;
}

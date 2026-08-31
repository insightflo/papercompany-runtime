// server/src/routes/knowledge-patterns.ts
//
// [파일 목적] 사고→패턴 지식 위키 API. 보드/에이전트(회사 스코프 키) 모두 접근 —
//   미션 오너가 진단 후 구조화 제안(POST)하고 기획/진단 시 검색(GET)한다.
//   실행 에이전트 프롬프트 주입 경로는 존재하지 않는다(설계 불변식).
// [외부 연결] consumer: 미션 오너 감독 루프(진단 체크리스트 안내), 보드. db는 app.ts가 주입.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

export function knowledgePatternsRoutes(db: Db) {
  const router = Router();
  const svc = knowledgePatternsService(db);

  // GET /api/companies/:companyId/knowledge-patterns?kind=&tags=a,b&q=&includeSuperseded=&includeDrafts=
  //   draft 초안은 보드(승인 주체)에만 기본 노출. 에이전트 키는 active 카드만 본다(승인 전 무측).
  router.get("/companies/:companyId/knowledge-patterns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tags = typeof req.query.tags === "string" && req.query.tags.trim()
      ? req.query.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      : null;
    const isBoard = req.actor.type !== "agent";
    const includeDrafts = isBoard && req.query.includeDrafts !== "false";
    const patterns = await svc.search({
      companyId,
      kind: typeof req.query.kind === "string" ? req.query.kind : null,
      tags,
      q: typeof req.query.q === "string" ? req.query.q : null,
      includeSuperseded: req.query.includeSuperseded === "true",
      includeDrafts,
    });
    res.json({ patterns });
  });

  // POST /api/companies/:companyId/knowledge-patterns
  router.post("/companies/:companyId/knowledge-patterns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = req.actor;
    const sourceFromActor = actor.type === "agent" ? "mission_owner_compile" : "operator";
    const bodySource = typeof req.body?.source === "string" && req.body.source.trim() ? req.body.source.trim() : sourceFromActor;
    const supersedeId = typeof req.body?.supersedeId === "string" && req.body.supersedeId.trim() ? req.body.supersedeId.trim() : null;

    // [중복 힌트 — 비차단] supersede가 아니면 등록 전 유사카드를 계산해 응답에 실는다.
    //   근접 중복은 supersedeId로 정정 발행을 유도한다(위키 오염 방지 — EvoHarness compaction).
    const similarExisting = supersedeId ? [] : await svc.findSimilar({
      companyId,
      title: typeof req.body?.title === "string" ? req.body.title : "",
      symptoms: typeof req.body?.symptoms === "string" ? req.body.symptoms : null,
      rootCause: typeof req.body?.rootCause === "string" ? req.body.rootCause : null,
      scopeTags: Array.isArray(req.body?.scopeTags) ? req.body.scopeTags.filter((tag: unknown): tag is string => typeof tag === "string") : [],
    }).catch(() => []);

    const card = await svc.create({
      companyId,
      kind: req.body?.kind,
      title: req.body?.title,
      summary: req.body?.summary,
      evidence: req.body?.evidence,
      symptoms: req.body?.symptoms,
      rootCause: req.body?.rootCause,
      whatWorked: req.body?.whatWorked,
      scopeTags: req.body?.scopeTags,
      source: bodySource,
      createdByAgentId: actor.type === "agent" ? actor.agentId ?? null : null,
      supersedeId,
    });
    res.status(201).json({ ...card, similarExisting });
  });

  // POST /api/companies/:companyId/knowledge-patterns/:patternId/approve — 보드 전용.
  //   [P1] 자동 초안(source='auto_rework_draft', status='draft') 카드의 draft→active 승인.
  //   사람 승인이 유일한 활성화 경로(기계 초안은 스스로 active가 될 수 없다).
  router.post("/companies/:companyId/knowledge-patterns/:patternId/approve", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const card = await svc.approve({ companyId, id: req.params.patternId as string });
      res.json({ card });
    } catch (error) {
      // 서비스가 "초안 없음(이미 active/타회사)"을 일반 Error로 던진다 → 404 매핑.
      if (error instanceof Error && error.message.includes("draft not found")) {
        next(notFound("Knowledge pattern draft not found"));
        return;
      }
      next(error);
    }
  });

  return router;
}

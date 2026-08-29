// server/src/routes/knowledge-patterns.ts
//
// [파일 목적] 사고→패턴 지식 위키 API. 보드/에이전트(회사 스코프 키) 모두 접근 —
//   미션 오너가 진단 후 구조화 제안(POST)하고 기획/진단 시 검색(GET)한다.
//   실행 에이전트 프롬프트 주입 경로는 존재하지 않는다(설계 불변식).
// [외부 연결] consumer: 미션 오너 감독 루프(진단 체크리스트 안내), 보드. db는 app.ts가 주입.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { assertCompanyAccess } from "./authz.js";

export function knowledgePatternsRoutes(db: Db) {
  const router = Router();
  const svc = knowledgePatternsService(db);

  // GET /api/companies/:companyId/knowledge-patterns?kind=&tags=a,b&q=&includeSuperseded=
  router.get("/companies/:companyId/knowledge-patterns", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tags = typeof req.query.tags === "string" && req.query.tags.trim()
      ? req.query.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      : null;
    const patterns = await svc.search({
      companyId,
      kind: typeof req.query.kind === "string" ? req.query.kind : null,
      tags,
      q: typeof req.query.q === "string" ? req.query.q : null,
      includeSuperseded: req.query.includeSuperseded === "true",
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
      supersedeId: typeof req.body?.supersedeId === "string" && req.body.supersedeId.trim() ? req.body.supersedeId.trim() : null,
    });
    res.status(201).json(card);
  });

  return router;
}

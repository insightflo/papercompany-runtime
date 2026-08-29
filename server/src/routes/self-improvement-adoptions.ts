// server/src/routes/self-improvement-adoptions.ts
//
// [파일 목적] 자기개선 채택 라이브 API — 미션 오너(회사 스코프 에이전트 키)와 보드가
//   selfImprovementCandidates + 게이트 판정을 제출해 company_skills에 유계 적용한다.
//   dry-run은 읽기 전용(계획+진단), apply는 실제 패치+impact 원장+활동로그.
// [불변식]
//   - 게이트 판정은 구조화 배열로만 제출(자연어/프로즈 파싱 금지 — 규칙 8).
//     에이전트/피어 검증이 승인 기제이며 운영자를 승인 단계로 강제하지 않는다.
//   - 회사 스코프 강제(assertCompanyAccess). 다른 회사 자산 접근 불가.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { selfImprovementAdoptionService } from "../services/self-improvement-adoption.js";
import { assertCompanyAccess } from "./authz.js";

export function selfImprovementAdoptionsRoutes(db: Db) {
  const router = Router();
  const svc = selfImprovementAdoptionService(db);

  // POST /api/companies/:companyId/self-improvement-adoptions/dry-run
  router.post("/companies/:companyId/self-improvement-adoptions/dry-run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.dryRun({
      companyId,
      candidates: req.body?.candidates,
      gateVerdicts: req.body?.gateVerdicts,
    });
    res.json(result);
  });

  // POST /api/companies/:companyId/self-improvement-adoptions/apply
  router.post("/companies/:companyId/self-improvement-adoptions/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = req.actor;
    const result = await svc.apply({
      companyId,
      candidates: req.body?.candidates,
      gateVerdicts: req.body?.gateVerdicts,
      actorId: actor.type === "agent" ? actor.agentId ?? "agent-adoption" : "operator-adoption",
    });
    res.json(result);
  });

  return router;
}

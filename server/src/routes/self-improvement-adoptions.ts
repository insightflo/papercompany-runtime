// server/src/routes/self-improvement-adoptions.ts
//
// [파일 목적] 자기개선 채택 라이브 API — 미션 오너(회사 스코프 에이전트 키)와 보드가
//   selfImprovementCandidates를 company_skills에 유계 적용한다.
//   dry-run은 읽기 전용(계획+진단+후보 해시), apply는 실제 패치+impact 원장+활동로그.
//   /verdicts는 피어/검증 에이전트가 후보 해시에 묶은 게이트 판정을 내구 원장에 기록한다.
// [불변식]
//   - 게이트 판정은 구조화 레코드로만 제출(자연어/프로즈 파싱 금지 — 규칙 8).
//     에이전트 apply는 인라인 판정 거부 — 판정 원장 PASS만 인정(자기 인증 차단).
//     보드(운영자)는 기존대로 인라인 판정 허용.
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

  // POST /api/companies/:companyId/self-improvement-adoptions/verdicts
  //   피어/검증 에이전트(또는 보드)가 후보 해시에 묶은 PASS/FAIL을 기록한다.
  //   note는 표시용 — 판정 권위는 레코드 필드(gateOwner/candidateHash/verdict)뿐.
  router.post("/companies/:companyId/self-improvement-adoptions/verdicts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = req.actor;
    const verdict = await svc.recordGateVerdict({
      companyId,
      gateOwner: req.body?.gateOwner,
      candidateHash: req.body?.candidateHash,
      verdict: req.body?.verdict,
      note: req.body?.note,
      createdByAgentId: actor.type === "agent" ? actor.agentId ?? null : null,
    });
    res.status(201).json(verdict);
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
      actor: {
        type: actor.type === "agent" ? "agent" : "board",
        agentId: actor.type === "agent" ? actor.agentId ?? null : null,
      },
    });
    res.json(result);
  });

  return router;
}

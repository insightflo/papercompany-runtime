// server/src/routes/agent-wiki.ts
//
// [파일 목적] Agent self-learning wiki 조회 API. 어떤 실패 패턴이 (company, agent) 단위로
//   얼마나 축적되고 있는지(entries) + 최근 실패 발생 추이(timeseries)를 UI/운영자가 볼 수 있게
//   한다. agent_wiki_entries 테이블은 Phase 1(축적)/Phase 2(주입)로만 쓰이다 보니 조회 화면이
//   없었는데, 축적 내역과 시계열을 한 곳에서 보기 위한 read-only 엔드포인트.
// [외부 연결] consumer: UI agent-wiki 페이지 / 운영자 curl. db는 app.ts가 주입.
// [수정시 주의] 응답에 비밀(토큰 등)이 섞이지 않도록. cause/solution은 한국어 교훈 텍스트.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentWikiService, type AgentWikiEntry } from "../services/agent-wiki.js";
import { assertCompanyAccess } from "./authz.js";

export interface AgentWikiTimeseriesPoint {
  day: string;
  errorCode: string | null;
  count: number;
}

export interface AgentWikiSummary {
  totalEntries: number;
  activeEntries: number;
  resolvedEntries: number;
  totalHits: number;
}

export interface AgentWikiResponse {
  entries: AgentWikiEntry[];
  timeseries: AgentWikiTimeseriesPoint[];
  summary: AgentWikiSummary;
}

export function agentWikiRoutes(db: Db) {
  const router = Router();
  const wiki = agentWikiService(db);

  // GET /api/companies/:companyId/agent-wiki?days=14
  // entries: 해당 회사의 wiki entry 전체(updatedAt desc). timeseries: 최근 N일 실패 추이.
  router.get("/companies/:companyId/agent-wiki", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rawDays = Number(req.query.days ?? 14);
    const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 90 ? Math.floor(rawDays) : 14;

    const [entries, timeseries] = await Promise.all([
      wiki.list(companyId),
      wiki.timeseries(companyId, days),
    ]);

    const summary: AgentWikiSummary = {
      totalEntries: entries.length,
      activeEntries: entries.filter((e) => e.status === "active").length,
      resolvedEntries: entries.filter((e) => e.status === "resolved").length,
      totalHits: entries.reduce((sum, e) => sum + e.frequency, 0),
    };

    const body: AgentWikiResponse = { entries, timeseries, summary };
    res.json(body);
  });

  return router;
}

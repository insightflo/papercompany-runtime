import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import {
  PATTERN_INJECTION_LIMIT,
  formatKnowledgePatternCards,
  injectionGroupFor,
  selectCardsForInjection,
} from "../services/knowledge-pattern-injection.js";
import { knowledgePatternsRoutes } from "../routes/knowledge-patterns.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping knowledge pattern injection tests: ${support.reason ?? "unsupported"}`);
}

// [P2 — 큐레이션 카드 관련도 주입, 측정 롤아웃] 주입은 fail-closed 게이트를 통과한
//   사람 큐레이션 카드만: active + audience='agent' + 신선도 창 내 + superseded 아님.
//   기계 카운터 위키(agent_wiki_entries)와 혼용 금지 — 이 파일은 카드 층만 검증한다.
describeEP("knowledge pattern injection (audience + freshness + relevance + rollout record)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-pattern-injection-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inject Co", status: "active", issuePrefix: "INJ1" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedCard(input: {
    title: string;
    symptoms?: string;
    whatWorked?: string;
    scopeTags?: string[];
    audience?: string;
    status?: string;
    createdAtOffsetDays?: number;
    supersededById?: string;
  }) {
    const [card] = await db.insert((await import("@paperclipai/db")).companyKnowledgePatterns).values({
      companyId,
      kind: "failure_mode",
      title: input.title,
      summary: "테스트 카드 요약",
      symptoms: input.symptoms ?? null,
      whatWorked: input.whatWorked ?? null,
      scopeTags: input.scopeTags ?? [],
      source: "operator",
      audience: input.audience ?? "ops",
      status: input.status ?? "active",
      supersededById: input.supersededById ?? null,
    }).returning();
    if (input.createdAtOffsetDays) {
      await db.update((await import("@paperclipai/db")).companyKnowledgePatterns)
        .set({ createdAt: new Date(Date.now() - input.createdAtOffsetDays * 24 * 60 * 60 * 1000) })
        .where(eq((await import("@paperclipai/db")).companyKnowledgePatterns.id, card!.id));
    }
    return card!;
  }

  it("injects only active + audience='agent' + fresh cards — ops, drafts, stale, superseded stay out", async () => {
    await seedCard({ title: "ops 카드 — 주입 대상 아님", audience: "ops" });
    await seedCard({ title: "초안 카드 — 승인 전", status: "draft", audience: "agent" });
    await seedCard({ title: "오래된 카드 — 신선도 게이트 탈락", audience: "agent", createdAtOffsetDays: 120 });
    await seedCard({ title: "대체된 카드", audience: "agent", supersededById: randomUUID() });
    const fresh = await seedCard({ title: "신선한 agent 카드", audience: "agent", symptoms: "광범위 검색 차단", whatWorked: "정확한 경로만 검색" });

    const selected = await selectCardsForInjection(db, { companyId, contextTexts: ["광범위 검색 차단 사고"] });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe(fresh.id);
  });

  it("selects at most 2 cards by deterministic relevance and requires a minimum score", async () => {
    await seedCard({ title: "관련 카드 A", audience: "agent", symptoms: "세금 계산서 발행 누락", whatWorked: "홈택스 대조" });
    await seedCard({ title: "관련 카드 B", audience: "agent", symptoms: "세금 계산서 역발행 지연", whatWorked: "발행 스케줄 선회" });
    await seedCard({ title: "무관 카드 C", audience: "agent", symptoms: "완전 다른 주제 위성 이미지", whatWorked: "해상도 필터" });

    const selected = await selectCardsForInjection(db, { companyId, contextTexts: ["세금 계산서 발행 사고 재발"] });
    expect(selected.length).toBeLessThanOrEqual(PATTERN_INJECTION_LIMIT);
    expect(selected.map((card) => card.title)).toEqual(["관련 카드 A", "관련 카드 B"]);

    // 관련 점수가 전혀 없는 문맥 — 빈 배열(무주입).
    const unrelated = await selectCardsForInjection(db, { companyId, contextTexts: ["전혀 다른 문맥 퀀텀 컴퓨팅"] });
    expect(unrelated).toHaveLength(0);
  });

  it("formats a compact Korean section with hard caps and returns null for empty input", async () => {
    expect(formatKnowledgePatternCards([])).toBeNull();
    const longTitle = "아주".repeat(60);
    const section = formatKnowledgePatternCards([{
      id: randomUUID(),
      title: longTitle,
      symptoms: "증상줄",
      whatWorked: "해결줄",
    }]);
    expect(section).toContain("## 과거 사고 패턴 참고");
    expect(section).toContain("[패턴]");
    // 제목 80자 상한(말줄임 포함).
    expect(section!.split("\n")[1]!.length).toBeLessThan(200);
  });

  it("assigns groups deterministically and reaches both groups", async () => {
    const keys = Array.from({ length: 64 }, (_, i) => `co:run:${i}:step`);
    const groups = new Set(keys.map(injectionGroupFor));
    for (const key of keys) {
      expect(injectionGroupFor(key)).toBe(injectionGroupFor(key));
    }
    expect(groups.has("injection")).toBe(true);
    expect(groups.has("control")).toBe(true);
  });

  it("approve with audience='agent' curates the card for injection; default approval stays 'ops'", async () => {
    const svc = knowledgePatternsService(db);
    const [createdOps] = await db.insert((await import("@paperclipai/db")).companyKnowledgePatterns).values({
      companyId, kind: "failure_mode", title: "승인 기본 카드", summary: "ops 유지 검증",
      scopeTags: [], source: "auto_rework_draft", status: "draft", audience: "ops",
    }).returning();
    const approved = await svc.approve({ companyId, id: createdOps!.id });
    expect(approved.status).toBe("active");
    expect(approved.audience).toBe("ops");

    const [createdAgent] = await db.insert((await import("@paperclipai/db")).companyKnowledgePatterns).values({
      companyId, kind: "failure_mode", title: "주입 큐레이션 카드", summary: "agent 승인 검증",
      scopeTags: [], source: "operator", status: "draft", audience: "ops",
    }).returning();
    const curated = await svc.approve({ companyId, id: createdAgent!.id, audience: "agent" });
    expect(curated.audience).toBe("agent");
  });

  it("report route aggregates injection rollout groups (board-only)", async () => {
    const workflowId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "injection-wf", stepsJson: [{ id: "s1", name: "S1", agentId: null }] });
    const runId = randomUUID();
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "test" });

    async function seedStepRun(status: string, group: "injection" | "control", cardIds: string[] = []) {
      await db.insert(workflowStepRuns).values({
        workflowRunId: runId,
        stepId: `step-${randomUUID().slice(0, 8)}`,
        companyId,
        status,
        metadata: { knowledgePatternInjection: { group, cardIds, decidedAt: new Date().toISOString() } },
      });
    }
    await seedStepRun("completed", "injection");
    await seedStepRun("failed", "injection");
    await seedStepRun("completed", "control");
    await seedStepRun("running", "control"); // 미종료 — terminal 분모 제외

    const boardApp = express();
    boardApp.use(express.json());
    boardApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    boardApp.use("/api", knowledgePatternsRoutes(db));
    boardApp.use(errorHandler);

    const report = await request(boardApp).get(`/api/companies/${companyId}/knowledge-pattern-injection-report`);
    expect(report.status).toBe(200);
    const injection = report.body.groups.find((g: { group: string }) => g.group === "injection");
    const control = report.body.groups.find((g: { group: string }) => g.group === "control");
    expect(injection).toMatchObject({ total: 2, completed: 1, failed: 1, terminal: 2, completionRate: 0.5 });
    expect(control).toMatchObject({ total: 2, completed: 1, failed: 0, terminal: 1, completionRate: 1 });
  });
});

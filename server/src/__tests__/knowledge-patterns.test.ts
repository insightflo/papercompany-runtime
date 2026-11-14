import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, companyKnowledgePatterns, createDb, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { knowledgePatternsRoutes } from "../routes/knowledge-patterns.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping knowledge patterns tests: ${support.reason ?? "unsupported"}`);
}

// [사고→패턴 지식 위키 Phase 1] 회사 단위 큐레이션 패턴 카드 저장소.
//   생산: 미션 오너/운영자의 구조화 제출(구조화 레코드만 권위 — 규칙 8).
//   소비: 검색 전용(기획/진단/자기개선). 실행 에이전트 주입 금지(설계 불변식).
//   불변식: append-only — 수정 불가, supersede 체인으로만 대체. 실패한 지식도 남는다.
describeEP("company knowledge patterns (append-only curated incident cards)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let ownerAgentId: string;
  let evidenceWorkflowRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-patterns-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    ownerAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Knowledge Co", status: "active", issuePrefix: "KP1" },
      { id: otherCompanyId, name: "Other Co", status: "active", issuePrefix: "KP2" },
    ]);
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Mission Owner", role: "owner",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    // [근거 실재성 ⓑ] evidence 검증이 실제 행만 통과시키므로 픽스처도 실재 run을 쓴다.
    const workflowDefinitionId = randomUUID();
    evidenceWorkflowRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowDefinitionId, companyId, name: "evidence-fixture", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: evidenceWorkflowRunId, workflowId: workflowDefinitionId, companyId,
      status: "completed", triggeredBy: "test",
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function sampleCard(overrides: Record<string, unknown> = {}) {
    return {
      companyId,
      kind: "failure_mode",
      title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
      summary: "생산자가 같은 세대에서 재완료되면 구 게이트 PASS 토큰과 현 토큰이 영구 불일치해 QA 이슈가 조용히 발사되지 않는다.",
      evidence: [{ type: "workflow_run", id: evidenceWorkflowRunId, note: "PR #156으로 수정" }],
      symptoms: "런 running 유지 + 마지막 QA 스텝 pending 지속 + 로그 없음",
      rootCause: "이중완료가 completedAt을 재스탬프",
      whatWorked: "게이트 CAS 재큐 + 재검증(PR #156)",
      scopeTags: ["workflow", "structural-gate"],
      source: "mission_owner_compile",
      createdByAgentId: ownerAgentId,
      ...overrides,
    };
  }

  it("creates a pattern card and records activity", async () => {
    const svc = knowledgePatternsService(db);
    const card = await svc.create(sampleCard());
    expect(card.id).toBeTruthy();
    expect(card.kind).toBe("failure_mode");
    expect(card.supersededById).toBeNull();
    const logs = await db.select().from(activityLog);
    expect(logs.some((row) => row.action === "knowledge_pattern.created" && row.entityId === card.id)).toBe(true);
  });

  it("is append-only: supersede chains instead of editing, and search hides superseded by default", async () => {
    const svc = knowledgePatternsService(db);
    const original = await svc.create(sampleCard({ title: "구버전 판단" }));
    const replacement = await svc.create(sampleCard({ title: "정정된 판단", supersedeId: original.id }));
    expect(replacement.supersededById).toBeNull();
    const [updatedOriginal] = await db.select().from((await import("@paperclipai/db")).companyKnowledgePatterns)
      .where((await import("drizzle-orm")).eq((await import("@paperclipai/db")).companyKnowledgePatterns.id, original.id));
    expect(updatedOriginal.supersededById).toBe(replacement.id);

    const search = await svc.search({ companyId });
    expect(search.find((c) => c.id === original.id)).toBeUndefined();
    expect(search.find((c) => c.id === replacement.id)).toBeTruthy();
    const withSuperseded = await svc.search({ companyId, includeSuperseded: true });
    expect(withSuperseded.find((c) => c.id === original.id)).toBeTruthy();
  });

  it("enforces company scoping on search and rejects cross-company supersede", async () => {
    const svc = knowledgePatternsService(db);
    await svc.create(sampleCard());
    const otherSearch = await svc.search({ companyId: otherCompanyId });
    expect(otherSearch).toHaveLength(0);
    const foreign = await svc.create(sampleCard({ companyId: otherCompanyId, createdByAgentId: null }));
    await expect(svc.create(sampleCard({ supersedeId: foreign.id }))).rejects.toThrow();
  });

  it("filters search by kind, tags, and free text", async () => {
    const svc = knowledgePatternsService(db);
    await svc.create(sampleCard({ title: "n8n 거짓 성공", scopeTags: ["n8n", "http-tool"] }));
    const byKind = await svc.search({ companyId, kind: "success_recipe" });
    expect(byKind).toHaveLength(0);
    const byTag = await svc.search({ companyId, tags: ["n8n"] });
    expect(byTag).toHaveLength(1);
    const byText = await svc.search({ companyId, q: "거짓" });
    expect(byText).toHaveLength(1);
    expect(byText[0]?.title).toBe("n8n 거짓 성공");
  });

  // [T1c 구조화 결합 메타데이터] create가 엔티티 4종을 공유 Zod 계약으로 정규화해 저장한다.
  //   누락 시 빈 배열(기존 카드 호환 — DB notNull default '{}'와 동일 해석).
  it("stores normalized coupling entities (diff prefix, backslash, dupes) and empty arrays by default", async () => {
    const svc = knowledgePatternsService(db);
    const plain = await svc.create(sampleCard({ title: "엔티티 없는 신규 카드" }));
    expect(plain.files).toEqual([]);
    expect(plain.symbols).toEqual([]);
    expect(plain.coupled).toEqual([]);
    expect(plain.errorSignatures).toEqual([]);

    const card = await svc.create(sampleCard({
      title: "엔티티 정규화 카드",
      files: ["a/server/src/services/knowledge-patterns.ts", "b\\ui\\src\\App.tsx", "server/src/services/knowledge-patterns.ts"],
      symbols: ["selectRelatedKnowledgePatterns", "selectRelatedKnowledgePatterns", "KnowledgePatternGraph"],
      coupled: ["./packages/shared/src/validators/knowledge-pattern.ts"],
      errorSignatures: ["TypeError: cannot read properties of undefined (reading 'id')", "TypeError: cannot read properties of undefined (reading 'id')"],
    }));
    expect(card.files).toEqual(["server/src/services/knowledge-patterns.ts", "ui/src/App.tsx"]);
    expect(card.symbols).toEqual(["selectRelatedKnowledgePatterns", "KnowledgePatternGraph"]);
    expect(card.coupled).toEqual(["packages/shared/src/validators/knowledge-pattern.ts"]);
    expect(card.errorSignatures).toEqual(["TypeError: cannot read properties of undefined (reading 'id')"]);
  });

  it("rejects invalid entity metadata without creating a card", async () => {
    const svc = knowledgePatternsService(db);
    const before = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    await expect(svc.create(sampleCard({ title: "잘못된 엔티티 1", files: "server/src/x.ts" })))
      .rejects.toThrow(/knowledge pattern entity/);
    await expect(svc.create(sampleCard({ title: "잘못된 엔티티 2", symbols: Array.from({ length: 13 }, (_, i) => `sym-${i}`) })))
      .rejects.toThrow(/knowledge pattern entity/);
    await expect(svc.create(sampleCard({ title: "잘못된 엔티티 3", files: ["   "] })))
      .rejects.toThrow(/knowledge pattern entity/);
    const after = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    expect(after.length).toBe(before.length);
  });

  // [T1c 검색 재정렬] q·엔티티 질의 시 관련도 엔진이 서명 일치 카드를 상단으로 올린다.
  //   DB 필터를 통과한 기존 카드(빈 엔티티)는 점수와 무관하게 버리지 않는다(회귀 0).
  it("re-ranks signature-matched card to the top and keeps legacy cards (no entity fields) listed", async () => {
    const svc = knowledgePatternsService(db);
    const signature = "TypeError: cannot read properties of undefined (reading 'ownerId')";
    // 생성 순서: 서명 카드 먼저, 레거시 카드 나중 — createdAt desc 라면 레거시가 먼저 온다.
    const signed = await svc.create(sampleCard({
      title: "토큰 불일치 서명 카드",
      files: ["server/src/services/knowledge-patterns.ts"],
      errorSignatures: [signature],
    }));
    const legacy = await svc.create(sampleCard({ title: "토큰 불일치 레거시 카드" }));

    // 1) q(ILIKE 양쪽 모두 통과) + 서명 텍스트 질의 → 서명 카드(10점+)가 상단.
    const byQuery = await svc.search({ companyId, q: "토큰 불일치", symbols: [signature] });
    expect(byQuery[0]?.id).toBe(signed.id);
    expect(byQuery.some((c) => c.id === legacy.id)).toBe(true);

    // 2) files 질의만(q 없음 → ILIKE 없음) — diff 접두사가 있어도 정규화 후 파일 일치 카드가 상단.
    const byFiles = await svc.search({ companyId, files: ["a/server/src/services/knowledge-patterns.ts"] });
    expect(byFiles[0]?.id).toBe(signed.id);

    // 3) 질의 없음 → 종전대로 createdAt desc(재정렬 비활성 — 현행 호환 랭킹).
    const noQuery = await svc.search({ companyId, limit: 10 });
    expect(noQuery.findIndex((c) => c.id === legacy.id))
      .toBeLessThan(noQuery.findIndex((c) => c.id === signed.id));
  });

  // [T1c 라우트 계약] 잘못된 엔티티 메타데이터는 진입 검증에서 422로 차단된다(500 금지).
  it("routes: POST rejects malformed entity metadata with 422 instead of a 500", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    app.use("/api", knowledgePatternsRoutes(db));
    app.use(errorHandler);

    const bad = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "failure_mode",
        title: "라우트 엔티티 형식 오류 카드",
        summary: "files가 배열이 아니면 라우트 진입에서 422로 거절된다.",
        files: "server/src/x.ts",
        evidence: [],
        source: "operator",
      });
    expect(bad.status).toBe(422);
  });

  it("rejects evidence referencing a nonexistent row and creates no card [defect-b]", async () => {
    const svc = knowledgePatternsService(db);
    const before = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    await expect(svc.create(sampleCard({
      title: "위조 근거 1",
      evidence: [{ type: "mission", id: randomUUID() }],
    }))).rejects.toThrow(/knowledge pattern evidence mission .* does not exist/);
    await expect(svc.create(sampleCard({
      title: "위조 근거 2",
      evidence: [{ type: "issue", id: "not-a-uuid" }],
    }))).rejects.toThrow(/knowledge pattern evidence issue id must be a uuid/);
    const after = await db.select({ id: companyKnowledgePatterns.id }).from(companyKnowledgePatterns);
    expect(after.length).toBe(before.length);
  });

  it("routes: nonexistent evidence maps to 422, not 500 [defect-b]", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "u1", source: "session", isInstanceAdmin: false, companyIds: [companyId] }; next(); });
    app.use("/api", knowledgePatternsRoutes(db));
    app.use(errorHandler);
    const res = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({ kind: "failure_mode", title: "위조 근거 카드", summary: "존재하지 않는 미션 참조", evidence: [{ type: "mission", id: randomUUID() }] });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("does not exist");
  });

  it("concurrent supersedes of one target: exactly one winner, no orphan active card [defect-a]", async () => {
    const svc = knowledgePatternsService(db);
    const target = await svc.create(sampleCard({ title: "동시 대체 대상 카드" }));
    const results = await Promise.allSettled([
      svc.create(sampleCard({ title: "대체안 A", supersedeId: target.id })),
      svc.create(sampleCard({ title: "대체안 B", supersedeId: target.id })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    // 패자의 거절 경로는 두 가지다: 갱신 전 사전검사에서 패("already superseded") 또는
    // 가드 UPDATE 0행으로 롤백("superseded concurrently"). 어느 쪽이든 고아 카드는 없어야 한다.
    expect(String((rejected[0] as PromiseRejectedResult).reason.message)).toMatch(/already superseded|superseded concurrently/);
    // 체인 연결 확인: 대상은 승자를 가리키고, 승자 카드만 active로 존재(패배 쪽 고아 없음).
    const [row] = await db.select().from(companyKnowledgePatterns).where(eq(companyKnowledgePatterns.id, target.id));
    expect(row!.supersededById).toBe((fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    const replacementTitles = await db
      .select({ title: companyKnowledgePatterns.title })
      .from(companyKnowledgePatterns)
      .where(eq(companyKnowledgePatterns.companyId, companyId));
    expect(replacementTitles.filter((r) => r.title === "대체안 A" || r.title === "대체안 B")).toHaveLength(1);
  });

  it("rejects invalid kinds/sources and over-long titles", async () => {
    const svc = knowledgePatternsService(db);
    await expect(svc.create(sampleCard({ kind: "gossip" }))).rejects.toThrow();
    await expect(svc.create(sampleCard({ source: "anonymous" }))).rejects.toThrow();
    await expect(svc.create(sampleCard({ title: "길다".repeat(200) }))).rejects.toThrow();
  });

  it("routes: POST returns non-blocking similarExisting hints for near-duplicate cards and skips them for supersede", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    app.use("/api", knowledgePatternsRoutes(db));
    app.use(errorHandler);

    const first = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "failure_mode",
        title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
        summary: "이중완료가 게이트 토큰과 영구 불일치를 만든다.",
        evidence: [],
        scopeTags: ["workflow", "structural-gate"],
        source: "operator",
      });
    expect(first.status).toBe(201);
    // 이 파일의 선행 테스트가 같은 회사에 카드를 남기므로 힌트 내용은 단정하지 않는다(배열 형태만).
    expect(Array.isArray(first.body.similarExisting)).toBe(true);

    // 근접 중복 — 태그+토큰 중복으로 기존 카드 발견 → 비차단 힌트.
    const similar = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "failure_mode",
        title: "게이트 토큰 불일치 — workflow 재발 사고",
        summary: "같은 부류의 재발.",
        evidence: [],
        scopeTags: ["workflow"],
        source: "operator",
      });
    expect(similar.status).toBe(201);
    expect(similar.body.similarExisting.map((entry: { id: string }) => entry.id)).toContain(first.body.id);

    // supersede 제출에는 힌트를 계산하지 않는다.
    const supersede = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "failure_mode",
        title: "정정: 토큰 불일치의 근본은 completedAt 재스탬프",
        summary: "정정 카드.",
        evidence: [],
        source: "operator",
        supersedeId: first.body.id,
      });
    expect(supersede.status).toBe(201);
    expect(supersede.body.similarExisting).toEqual([]);
  });

  it("routes: board actor can create/search; cross-company agent is forbidden", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    app.use("/api", knowledgePatternsRoutes(db));
    app.use(errorHandler);

    const created = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "constraint",
        title: "하루 1회 스케줄 미션",
        summary: "스케줄 워크플로우는 하루 1 미션만 만든다.",
        evidence: [],
        scopeTags: ["scheduler"],
        source: "operator",
      });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("하루 1회 스케줄 미션");

    const listed = await request(app).get(`/api/companies/${companyId}/knowledge-patterns`);
    expect(listed.status).toBe(200);
    expect(listed.body.patterns.length).toBeGreaterThanOrEqual(1);

    const crossCompany = await request(app)
      .post(`/api/companies/${otherCompanyId}/knowledge-patterns`)
      .send({ kind: "constraint", title: "x", summary: "x", evidence: [], source: "operator" });
    expect(crossCompany.status).toBe(403);
  });

  // [PR1 입력 검증] 라우트 진입에서 형식 오류를 422로 차단한다(500 금지).
  //   감독 루프가 회복 불가 오류로 오인하지 않게 하기 위함. 서비스 throw는 직접 호출자
  //   방어용으로 유지된다.
  it("routes: POST rejects non-string symptoms with 422 instead of a 500", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    app.use("/api", knowledgePatternsRoutes(db));
    app.use(errorHandler);

    const bad = await request(app)
      .post(`/api/companies/${companyId}/knowledge-patterns`)
      .send({
        kind: "failure_mode",
        title: "형식 오류 카드",
        summary: "symptoms가 문자열이 아니면 라우트 진입에서 422로 거절된다.",
        symptoms: { list: ["런 running 유지"] },
        evidence: [],
        source: "operator",
      });
    expect(bad.status).toBe(422);
  });

  // [P1] 자동 초안 라우팅: 에이전트 키는 draft 미노출, 승인은 보드 전용(403/404 매핑 포함).
  it("routes: drafts visible to board only; approve is board-only and maps missing drafts to 404", async () => {
    const svc = knowledgePatternsService(db);
    const { card } = await svc.createAutoReworkDraft({
      companyId,
      signature: `route-sig-${randomUUID()}`,
      title: "라우트 초안 카드",
      summary: "승인 라우팅 검증용 자동 초안.",
    });
    expect(card).not.toBeNull();

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "agent", companyId, agentId: ownerAgentId, runId: null,
      };
      next();
    });
    agentApp.use("/api", knowledgePatternsRoutes(db));
    agentApp.use(errorHandler);

    const agentList = await request(agentApp).get(`/api/companies/${companyId}/knowledge-patterns`);
    expect(agentList.status).toBe(200);
    expect(agentList.body.patterns.some((c: { id: string }) => c.id === card!.id)).toBe(false);

    const agentApprove = await request(agentApp).post(`/api/companies/${companyId}/knowledge-patterns/${card!.id}/approve`);
    expect(agentApprove.status).toBe(403);

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

    const boardList = await request(boardApp).get(`/api/companies/${companyId}/knowledge-patterns`);
    expect(boardList.status).toBe(200);
    expect(boardList.body.patterns.some((c: { id: string; status: string }) => c.id === card!.id && c.status === "draft")).toBe(true);

    const approve = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${card!.id}/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.card.status).toBe("active");

    const reApprove = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${card!.id}/approve`);
    expect(reApprove.status).toBe(404);
  });

  // [P2] 주입 큐레이션 토글: 보드만 가능, active/draft 모두 가능, 잘못된 값은 400.
  it("routes: board-only audience curation on active and draft cards; invalid value maps to 400", async () => {
    const svc = knowledgePatternsService(db);
    const created = await svc.create({
      companyId, kind: "failure_mode", title: "주입 토글 대상 카드", summary: "active 카드 큐레이션 검증",
      evidence: [], scopeTags: [], source: "operator",
    });

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

    const allow = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${created.id}/audience`).send({ audience: "agent" });
    expect(allow.status).toBe(200);
    expect(allow.body.card.audience).toBe("agent");

    const revoke = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${created.id}/audience`).send({ audience: "ops" });
    expect(revoke.status).toBe(200);
    expect(revoke.body.card.audience).toBe("ops");

    const invalid = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${created.id}/audience`).send({ audience: "everyone" });
    expect(invalid.status).toBe(400);

    const missing = await request(boardApp).post(`/api/companies/${companyId}/knowledge-patterns/${randomUUID()}/audience`).send({ audience: "agent" });
    expect(missing.status).toBe(404);

    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = { type: "agent", companyId, agentId: ownerAgentId, runId: null };
      next();
    });
    agentApp.use("/api", knowledgePatternsRoutes(db));
    agentApp.use(errorHandler);
    const agentCurate = await request(agentApp).post(`/api/companies/${companyId}/knowledge-patterns/${created.id}/audience`).send({ audience: "agent" });
    expect(agentCurate.status).toBe(403);
  });
});

// [Phase 2 — 자기개선 연결] 순수 변환 헬퍼(EP 불필요): 검색 결과 카드 → planner 레지스트리.
describe("knowledgePatternAdoptionRegistryEntries (pure)", () => {
  it("maps pattern cards to knowledge_pattern registry entries keyed by card id", async () => {
    const { knowledgePatternAdoptionRegistryEntries } = await import("../services/knowledge-patterns.js");
    expect(knowledgePatternAdoptionRegistryEntries([{ id: "card-1" }, { id: "card-2" }])).toEqual([
      { assetType: "knowledge_pattern", assetRef: "card-1", resolvedRef: "card-1" },
      { assetType: "knowledge_pattern", assetRef: "card-2", resolvedRef: "card-2" },
    ]);
    expect(knowledgePatternAdoptionRegistryEntries([])).toEqual([]);
  });
});

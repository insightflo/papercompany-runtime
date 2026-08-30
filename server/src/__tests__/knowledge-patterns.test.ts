import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
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
      evidence: [{ type: "workflow_run", id: "38fb7ef5", note: "PR #156으로 수정" }],
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

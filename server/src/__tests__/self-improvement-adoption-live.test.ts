import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { activityLog, companies, companySkills, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selfImprovementAdoptionService } from "../services/self-improvement-adoption.js";
import { findRelatedKnowledgePatterns } from "../services/missions/mission-owner-related-patterns.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { selfImprovementAdoptionsRoutes } from "../routes/self-improvement-adoptions.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping self-improvement adoption live tests: ${support.reason ?? "unsupported"}`);
}

// [자기개선 채택 라이브 배선] 후보 + 게이트 판정 → 실제 company_skills 마크다운 유계 패치 →
//   impact 원장 + 활동로그. 드라이런은 무변경. 검증 실패/미해석은 실패 닫힘.
describeEP("self-improvement adoption live wiring (planner→executor→ledger)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let skillKey: string;
  let patternId: string;

  const baseMarkdown = [
    "---",
    "name: Gazua Report",
    "description: 가즈아 리포트 스킬",
    "---",
    "",
    "# Gazua Report",
    "",
    "## Validation checklist",
    "- Check contrast.",
    "",
    "## Pitfalls",
    "- Do not overclaim.",
    "",
  ].join("\n");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("adoption-live-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Adoption Co", status: "active", issuePrefix: "AD1" },
      { id: otherCompanyId, name: "Other Adoption Co", status: "active", issuePrefix: "AD2" },
    ]);

    const [skill] = await db
      .insert(companySkills)
      .values({
        companyId,
        key: "catalog/gazua-report",
        slug: "gazua-report",
        name: "Gazua Report",
        markdown: baseMarkdown,
        sourceType: "catalog",
      })
      .returning();
    skillKey = skill!.key;

    const card = await knowledgePatternsService(db).create({
      companyId,
      kind: "failure_mode",
      title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
      summary: "이중완료가 게이트 토큰과 영구 불일치를 만든다.",
      evidence: [{ type: "workflow_run", id: "38fb7ef5" }],
      scopeTags: ["workflow"],
      source: "operator",
    });
    patternId = card.id;
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      assetType: "skill",
      assetRef: skillKey,
      evidenceSource: [{ type: "knowledge_pattern", id: patternId }],
      pattern: "같은 부류 재발 방지",
      proposedEdit: {
        operation: "add",
        section: "Validation checklist",
        content: "- 게이트 토큰 불일치 재검",
      },
      validationPlan: "재발 시나리오 리플레이",
      gateOwner: "peer:validator",
      autoAdoptionResult: "accepted",
      ...overrides,
    };
  }

  const passVerdicts = [{ gateOwner: "peer:validator", verdict: "PASS" }];

  async function currentMarkdown() {
    const [row] = await db.select().from(companySkills).where(eq(companySkills.key, skillKey));
    return row!.markdown;
  }

  it("dry-run resolves real company assets without mutating anything", async () => {
    const svc = selfImprovementAdoptionService(db);
    const result = await svc.dryRun({
      companyId,
      candidates: [candidate(), candidate({ assetRef: "catalog/missing-skill" })],
      gateVerdicts: passVerdicts,
    });

    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]?.evidencePatternIds).toEqual([patternId]);
    expect(result.plan[0]?.asset.resolvedRef).toBe(skillKey);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["unresolved_asset"]);
    expect(await currentMarkdown()).toBe(baseMarkdown);
  });

  it("applies a bounded patch to the real skill markdown and records the impact ledger", async () => {
    const svc = selfImprovementAdoptionService(db);
    const result = await svc.apply({
      companyId,
      candidates: [candidate()],
      gateVerdicts: passVerdicts,
      actor: { type: "board" },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      assetRef: skillKey,
      resolvedRef: skillKey,
      operation: "add",
      section: "Validation checklist",
      adoptedFromPatternIds: [patternId],
    });

    const markdown = await currentMarkdown();
    expect(markdown).toContain("- 게이트 토큰 불일치 재검");
    expect(markdown).toContain("- Check contrast.");
    expect(markdown.indexOf("- Check contrast.")).toBeLessThan(markdown.indexOf("- 게이트 토큰 불일치 재검"));

    const [row] = await db.select().from(companySkills).where(eq(companySkills.key, skillKey));
    const impact = (row!.metadata as Record<string, unknown>).impact as Array<Record<string, unknown>>;
    expect(impact).toHaveLength(1);
    expect(impact[0]).toMatchObject({
      adoptedFrom: patternId,
      validation: { verdict: "PASS", gateOwner: "peer:validator", operation: "add", section: "Validation checklist" },
    });

    const logs = await db.select().from(activityLog);
    expect(logs.some((entry) => entry.action === "company_skill.adoption_applied" && entry.details?.adoptedFromPatternIds)).toBe(true);
    expect(logs.some((entry) => entry.action === "company_skill.impact_recorded")).toBe(true);
  });

  it("fails closed on unbounded patches without writing the skill", async () => {
    const svc = selfImprovementAdoptionService(db);
    const before = await currentMarkdown();
    const result = await svc.apply({
      companyId,
      candidates: [candidate({ proposedEdit: { operation: "add", section: "Validation checklist", content: `- ${"x".repeat(9_000)}` } })],
      gateVerdicts: passVerdicts,
      actor: { type: "board" },
    });

    expect(result.applied).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["validation_failed"]);
    expect(await currentMarkdown()).toBe(before);
  });

  it("rejects malformed input contracts with 422 semantics", async () => {
    const svc = selfImprovementAdoptionService(db);
    await expect(svc.dryRun({ companyId, candidates: [], gateVerdicts: passVerdicts })).rejects.toThrow(/candidates/);
    await expect(svc.dryRun({ companyId, candidates: [candidate()], gateVerdicts: [{ gateOwner: "peer:validator", verdict: "MAYBE" }] })).rejects.toThrow(/gateVerdicts/);
  });

  it("routes: board apply patches the skill; cross-company agent is forbidden; slug refs resolve", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "board", source: "board_key", companyId, companyIds: [companyId], isInstanceAdmin: false,
        actorId: "board-user", agentId: null,
      };
      next();
    });
    app.use("/api", selfImprovementAdoptionsRoutes(db));
    app.use(errorHandler);

    // slug 참조도 레지스트리에서 key로 해석된다.
    const applied = await request(app)
      .post(`/api/companies/${companyId}/self-improvement-adoptions/apply`)
      .send({
        candidates: [candidate({ assetRef: "gazua-report", proposedEdit: { operation: "add", section: "Validation checklist", content: "- slug 경로 적용" } })],
        gateVerdicts: passVerdicts,
      });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toHaveLength(1);
    expect(await currentMarkdown()).toContain("- slug 경로 적용");

    const dryRun = await request(app)
      .post(`/api/companies/${companyId}/self-improvement-adoptions/dry-run`)
      .send({ candidates: [candidate()], gateVerdicts: passVerdicts });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.plan).toHaveLength(1);

    const invalid = await request(app)
      .post(`/api/companies/${companyId}/self-improvement-adoptions/apply`)
      .send({ candidates: [], gateVerdicts: passVerdicts });
    expect(invalid.status).toBe(422);

    // 타 회사 에이전트 키는 회사 스코프로 차단된다.
    const foreignApp = express();
    foreignApp.use(express.json());
    foreignApp.use((req, _res, next) => {
      (req as typeof req & { actor: unknown }).actor = {
        type: "agent", companyId: otherCompanyId, agentId: randomUUID(),
      };
      next();
    });
    foreignApp.use("/api", selfImprovementAdoptionsRoutes(db));
    foreignApp.use(errorHandler);
    const forbidden = await request(foreignApp)
      .post(`/api/companies/${companyId}/self-improvement-adoptions/apply`)
      .send({ candidates: [candidate()], gateVerdicts: passVerdicts });
    expect(forbidden.status).toBe(403);
  });

  it("materializes peer gate verdicts: hash-scoped, anti-self-certification, agent inline rejection", async () => {
    const svc = selfImprovementAdoptionService(db);
    const { agents: agentsTable } = await import("@paperclipai/db");
    const peerAgentId = randomUUID();
    const ownerAgentId2 = randomUUID();
    await db.insert(agentsTable).values([
      { id: peerAgentId, companyId, name: "Peer Validator", role: "reviewer", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: ownerAgentId2, companyId, name: "Adoption Submitter", role: "owner", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const dry = await svc.dryRun({ companyId, candidates: [candidate()] });
    expect(dry.candidateHashes).toHaveLength(1);
    const hash = dry.candidateHashes[0]!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // 에이전트 인라인 판정 거부.
    await expect(svc.apply({
      companyId,
      candidates: [candidate()],
      gateVerdicts: passVerdicts,
      actor: { type: "agent", agentId: ownerAgentId2 },
    })).rejects.toThrow(/must not inline gate verdicts/);

    // 판정 없는 에이전트 apply → gate_not_passed.
    const noVerdict = await svc.apply({
      companyId,
      candidates: [candidate()],
      actor: { type: "agent", agentId: ownerAgentId2 },
    });
    expect(noVerdict.applied).toHaveLength(0);
    expect(noVerdict.diagnostics.map((d) => d.code)).toContain("gate_not_passed");

    // 자기 인증 — 제출자 본인이 남긴 PASS는 무효.
    await svc.recordGateVerdict({ companyId, gateOwner: "peer:validator", candidateHash: hash, verdict: "PASS", createdByAgentId: ownerAgentId2 });
    const selfCert = await svc.apply({
      companyId,
      candidates: [candidate()],
      actor: { type: "agent", agentId: ownerAgentId2 },
    });
    expect(selfCert.applied).toHaveLength(0);
    expect(selfCert.diagnostics.map((d) => d.code)).toContain("gate_not_passed");

    // 피어(다른 에이전트) 판정 → 통과 + 실제 패치.
    await svc.recordGateVerdict({ companyId, gateOwner: "peer:validator", candidateHash: hash, verdict: "PASS", createdByAgentId: peerAgentId });
    const approved = await svc.apply({
      companyId,
      candidates: [candidate()],
      actor: { type: "agent", agentId: ownerAgentId2 },
    });
    expect(approved.applied).toHaveLength(1);
    expect(await currentMarkdown()).toContain("- 게이트 토큰 불일치 재검");

    // 해시 스코프 — 내용이 달라진 후보(해시 불일치)에는 같은 판정이 적용되지 않는다.
    const changed = await svc.apply({
      companyId,
      candidates: [candidate({ proposedEdit: { operation: "add", section: "Validation checklist", content: "- 다른 패치" } })],
      actor: { type: "agent", agentId: ownerAgentId2 },
    });
    expect(changed.applied).toHaveLength(0);
    expect(changed.diagnostics.map((d) => d.code)).toContain("gate_not_passed");

    // 형식 검증.
    await expect(svc.recordGateVerdict({ companyId, gateOwner: "x", candidateHash: "nothash", verdict: "PASS", createdByAgentId: peerAgentId })).rejects.toThrow(/candidateHash/);
    await expect(svc.recordGateVerdict({ companyId, gateOwner: "x", candidateHash: hash, verdict: "MAYBE", createdByAgentId: peerAgentId })).rejects.toThrow(/PASS or FAIL/);
  });

  // [자동수선 리뷰 3점] 적용 성공 → 활동로그 before/after 해시 + producerAgentId,
  //   원천 이슈(같은 회사)에 시스템 코멘트 통지(본문에 해시 포함, 저자 필드 없음).
  it("records before/after content hashes and notifies the source issue with a system comment", async () => {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "후보 원천 이슈", status: "todo" });
    const producerAgentId = randomUUID();
    const before = await currentMarkdown();

    const svc = selfImprovementAdoptionService(db);
    const result = await svc.apply({
      companyId,
      candidates: [candidate({
        producerAgentId,
        sourceIssueId: issueId,
        proposedEdit: { operation: "add", section: "Validation checklist", content: "- 생산자 통지 해시 증명" },
      })],
      gateVerdicts: passVerdicts,
      actor: { type: "board" },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toHaveLength(1);
    const expectedBefore = createHash("sha256").update(before).digest("hex");
    const expectedAfter = createHash("sha256").update(await currentMarkdown()).digest("hex");
    expect(result.applied[0]?.contentHashBefore).toBe(expectedBefore);
    expect(result.applied[0]?.contentHashAfter).toBe(expectedAfter);

    const [log] = await db.select().from(activityLog).where(eq(activityLog.action, "company_skill.adoption_applied"));
    expect(log?.details?.contentHashBefore).toBe(expectedBefore);
    expect(log?.details?.contentHashAfter).toBe(expectedAfter);
    expect(log?.details?.producerAgentId).toBe(producerAgentId);

    const [comment] = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comment?.companyId).toBe(companyId);
    expect(comment?.authorAgentId).toBeNull();
    expect(comment?.authorUserId).toBeNull();
    expect(comment?.body).toContain(expectedBefore);
    expect(comment?.body).toContain(expectedAfter);
    expect(comment?.body).toContain(result.candidateHashes[0]!);
    expect(comment?.body).toContain(producerAgentId);
  });

  // [같은 주체 상관오류] 패치를 생산한 에이전트가 남긴 판정은 그 후보에 자격이 없다.
  it("disqualifies verdicts recorded by the candidate producer (same-entity re-review)", async () => {
    const svc = selfImprovementAdoptionService(db);
    const { agents: agentsTable } = await import("@paperclipai/db");
    const producerAgentId = randomUUID();
    const submitterAgentId = randomUUID();
    await db.insert(agentsTable).values([
      { id: producerAgentId, companyId, name: "Patch Producer", role: "worker", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: submitterAgentId, companyId, name: "Adoption Submitter 2", role: "owner", status: "active", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    // 이 테스트 전용 패치 내용으로 해시를 분리한다(이전 테스트의 판정 원장 오염 방지).
    const producerCandidate = candidate({
      producerAgentId,
      proposedEdit: { operation: "add", section: "Validation checklist", content: "- 같은 주체 재검수 차단 증명" },
    });
    const dry = await svc.dryRun({ companyId, candidates: [producerCandidate] });
    const hash = dry.candidateHashes[0]!;

    await svc.recordGateVerdict({ companyId, gateOwner: "peer:validator", candidateHash: hash, verdict: "PASS", createdByAgentId: producerAgentId });
    const before = await currentMarkdown();
    const rejected = await svc.apply({
      companyId,
      candidates: [producerCandidate],
      actor: { type: "agent", agentId: submitterAgentId },
    });

    expect(rejected.applied).toHaveLength(0);
    expect(rejected.diagnostics).toEqual([
      {
        code: "same_entity_verdict_rejected",
        candidateIndex: 0,
        message: expect.stringContaining("selfImprovementCandidates[0]"),
      },
    ]);
    expect(await currentMarkdown()).toBe(before);
  });

  // [생산자 통지 실패] 타 회사/존재하지 않는 원천 이슈 — 패치는 적용, 진단만 노출, 코멘트 없음.
  it("keeps the patch applied but reports producer_notify_failed for foreign or missing source issues", async () => {
    const foreignIssueId = randomUUID();
    await db.insert(issues).values({ id: foreignIssueId, companyId: otherCompanyId, title: "타 회사 이슈", status: "todo" });
    const missingIssueId = randomUUID();

    const svc = selfImprovementAdoptionService(db);
    const result = await svc.apply({
      companyId,
      candidates: [
        candidate({
          sourceIssueId: foreignIssueId,
          proposedEdit: { operation: "add", section: "Validation checklist", content: "- 타 회사 원천 통지 실패" },
        }),
        candidate({
          sourceIssueId: missingIssueId,
          proposedEdit: { operation: "add", section: "Validation checklist", content: "- 존재하지 않는 원천 통지 실패" },
        }),
      ],
      gateVerdicts: passVerdicts,
      actor: { type: "board" },
    });

    expect(result.applied).toHaveLength(2);
    expect(result.diagnostics.map((d) => ({ code: d.code, candidateIndex: d.candidateIndex }))).toEqual([
      { code: "producer_notify_failed", candidateIndex: 0 },
      { code: "producer_notify_failed", candidateIndex: 1 },
    ]);
    const markdown = await currentMarkdown();
    expect(markdown).toContain("- 타 회사 원천 통지 실패");
    expect(markdown).toContain("- 존재하지 않는 원천 통지 실패");
    const comments = await db.select().from(issueComments).where(inArray(issueComments.issueId, [foreignIssueId, missingIssueId]));
    expect(comments).toEqual([]);
  });

  it("finds related knowledge patterns for the owner unblock trigger (company-scoped)", async () => {
    const related = await findRelatedKnowledgePatterns(db, companyId, [
      "저녁 미션 QA 스텝 무발사 — workflow run 실패",
    ]);
    expect(related.map((entry) => entry.id)).toEqual([patternId]);

    const foreign = await findRelatedKnowledgePatterns(db, otherCompanyId, [
      "저녁 미션 QA 스텝 무발사 — workflow run 실패",
    ]);
    expect(foreign).toEqual([]);
  });
});

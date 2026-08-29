import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selfImprovementAdoptionService } from "../services/self-improvement-adoption.js";
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
      actorId: "operator-adoption",
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
      actorId: "operator-adoption",
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
});

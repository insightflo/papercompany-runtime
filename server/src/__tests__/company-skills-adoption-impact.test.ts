import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";
import { buildSelfImprovementAdoptionPlan } from "../services/self-improvement-adoption-planner.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping skill adoption impact tests: ${support.reason ?? "unsupported"}`);
}

// [Phase 2 — 지식 위키 → 자기개선 연결] 패턴 카드가 evidenceSource로 참조될 때
//   company_skills.metadata.impact 원장에 채택 이력이 남는지, 그리고 검색→레지스트리→
//   플래너 해석 경로가 회사 스코프에서 닫히는지 검증한다.
describeEP("company skill adoption impact ledger (knowledge pattern provenance)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let skillId: string;
  let patternId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("skill-impact-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Impact Co", status: "active", issuePrefix: "IM1" },
      { id: otherCompanyId, name: "Other Impact Co", status: "active", issuePrefix: "IM2" },
    ]);

    const [skill] = await db
      .insert(companySkills)
      .values({
        companyId,
        key: "catalog/gazua-report",
        slug: "gazua-report",
        name: "Gazua Report",
        markdown: "# Gazua Report\n\n## Validation checklist\n- Check contrast.\n",
        sourceType: "catalog",
      })
      .returning();
    skillId = skill!.id;

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

  function readSkillMetadata() {
    return db
      .select({ metadata: companySkills.metadata })
      .from(companySkills)
      .where(eq(companySkills.id, skillId))
      .then((rows) => (rows[0]?.metadata ?? {}) as Record<string, unknown>);
  }

  it("rejects cross-company refs and invalid adoptedFrom values without touching the ledger", async () => {
    const svc = companySkillService(db);
    await expect(svc.recordAdoptionImpact(otherCompanyId, "catalog/gazua-report", { adoptedFrom: patternId })).resolves.toBeNull();
    await expect(svc.recordAdoptionImpact(companyId, "catalog/gazua-report", { adoptedFrom: "  " })).rejects.toThrow(/adoptedFrom/);
    await expect(svc.recordAdoptionImpact(companyId, "missing-skill", { adoptedFrom: patternId })).resolves.toBeNull();

    expect(await readSkillMetadata()).toEqual({});
  });

  it("appends an impact entry on the skill metadata ledger with an activity log record", async () => {
    const svc = companySkillService(db);
    const updated = await svc.recordAdoptionImpact(companyId, "catalog/gazua-report", {
      adoptedFrom: patternId,
      validation: { verdict: "PASS", gateOwner: "peer:validator" },
    });

    expect(updated?.metadata?.impact).toEqual([
      {
        adoptedFrom: patternId,
        adoptedAt: expect.any(String),
        validation: { verdict: "PASS", gateOwner: "peer:validator" },
      },
    ]);

    const logs = await db.select().from(activityLog);
    expect(logs.some((entry) => entry.action === "company_skill.impact_recorded" && entry.entityId === skillId)).toBe(true);
  });

  it("accumulates ledger entries across adoptions (by key and by id) instead of overwriting", async () => {
    const svc = companySkillService(db);
    await svc.recordAdoptionImpact(companyId, skillId, { adoptedFrom: patternId, validation: {} });
    const updated = await svc.recordAdoptionImpact(companyId, "catalog/gazua-report", {
      adoptedFrom: "00000000-0000-0000-0000-000000000009",
      validation: { verdict: "PASS" },
    });

    expect((updated?.metadata?.impact as unknown[]).length).toBe(3);
  });

  it("resolves pattern evidence only for cards present in the company registry", async () => {
    const cards = await knowledgePatternsService(db).search({ companyId, q: "게이트" });
    const registry = [
      ...cards.map((card) => ({ assetType: "knowledge_pattern", assetRef: card.id, resolvedRef: card.id })),
      { assetType: "skill", assetRef: "catalog/gazua-report", resolvedRef: `company_skill:${skillId}` },
    ];

    const resolved = buildSelfImprovementAdoptionPlan({
      candidates: [
        {
          assetType: "skill",
          assetRef: "catalog/gazua-report",
          evidenceSource: [{ type: "knowledge_pattern", id: patternId }],
          pattern: "같은 부류 재발 방지",
          proposedEdit: { operation: "add", section: "Validation checklist", content: "- 게이트 토큰 불일치 재검" },
          validationPlan: "재발 시나리오 리플레이",
          gateOwner: "peer:validator",
          autoAdoptionResult: "accepted",
        },
        {
          assetType: "skill",
          assetRef: "catalog/gazua-report",
          evidenceSource: [`knowledge_pattern:${randomUUID()}`],
          pattern: "레지스트리에 없는 카드 참조",
          proposedEdit: { operation: "add", section: "Validation checklist", content: "- 외부 카드" },
          validationPlan: "없음",
          gateOwner: "peer:validator",
          autoAdoptionResult: "accepted",
        },
      ],
      assetRegistry: registry,
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });

    expect(resolved.plan.map((entry) => entry.evidencePatternIds)).toEqual([[patternId]]);
    expect(resolved.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["unresolved_evidence_pattern"]);
  });
});

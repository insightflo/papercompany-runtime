// [TEST] T7 PLAN-QA 고정 명세: 전체 입력·추가 검사 버전을 검토 시작 전에 고정(pin)하고
// StorageService 원본 bytes 로 읽는다. 실제 격리 PG + 실제 local_disk storage 만 사용한다.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issues, missionPlanArtifacts,
  missionPlanTemplates, missions, qualityPolicyVersions, type Db,
} from "@paperclipai/db";
import type { AddendumCheck, ArtifactRef, PlanQaScope } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { attachEvidence, readVerifiedArtifact, uploadEvidence } from "../services/quality/evidence-store.js";
import { getStorageService } from "../storage/index.js";
import {
  blockedPlanQaTemplates,
  pinPlanQaManifest,
  readPlanQaManifestDocument,
  readPinnedPlanQaManifest,
} from "../services/missions/plan-qa-addendum-manifest.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const DECISION_HASH = "7".repeat(64);

type World = {
  companyId: string; otherCompanyId: string; missionId: string; planArtifactId: string;
  planQaIssueId: string; runId: string; templates: { a: string; b: string; c: string };
};
function check(checkId: string, templateIds: string[] | "always"): AddendumCheck {
  return {
    checkId,
    requirementRefs: [{ attachmentId: randomUUID(), sha256: "10".repeat(32) }],
    applicability: templateIds === "always"
      ? { op: "always" as const }
      : { op: "selected_templates_all" as const, templateIds },
    expectedEvidenceKinds: ["evaluation_receipt"],
    instructions: `추가 검사 ${checkId}`,
  };
}

function policyDefinition(companyId: string, targets: Array<{ templateId: string; baseHash: string; required: AddendumCheck[] }>) {
  const now = new Date();
  return {
    targets: targets.map((target) => ({ companyId, ...target })),
    authorAgentIds: [randomUUID()], verifierAgentIds: [randomUUID()], allowedToolIds: [],
    reviewerUserIds: ["quality-reviewer-1"], rollbackUserIds: ["quality-rollback-1"],
    requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "11".repeat(32) }],
    caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "12".repeat(32) }],
    nativeOwnership: "native-active-plugin-disabled" as const,
    maxActions: 5, maxCandidatesPerAction: 2, maxEvaluationsPerCandidate: 2, maxOuterCycles: 2,
    maxEvidenceResubmissions: 1, maxExecutionAttempts: 4, maxCostCentsPerGroup: 100, maxCostCentsPerPeriod: 1000,
    maxElapsedSeconds: 3600, decisionTtlSeconds: 900, observationSeconds: 86_400, reconcileBatchSize: 10,
    periodStart: now.toISOString(), periodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}

/** 원문을 변형한 명세를 같은 PLAN-QA 이슈 첨부로 다시 저장한다(문서 계약 검증용). */
async function repinManifest(db: Db, w: World, bytes: Buffer): Promise<ArtifactRef> {
  const uploaded = await uploadEvidence(getStorageService(), { companyId: w.companyId, body: bytes, contentType: "application/json", originalFilename: null });
  return db.transaction((tx) => attachEvidence(tx, { companyId: w.companyId, issueId: w.planQaIssueId, uploaded }));
}

describeQualityDb("PLAN-QA addendum manifest pinning", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;
  let world: World;

  async function seed(options?: {
    selectedTemplateIds?: string[];
    templateABody?: string;
    policyTargets?: (templates: { a: string; b: string; c: string }) => Array<{ templateId: string; baseHash: string; required: AddendumCheck[] }>;
  }): Promise<World> {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Manifest Co", issuePrefix: `MF${companyId.slice(0, 4)}` },
      { id: otherCompanyId, name: "Manifest Other", issuePrefix: `MO${companyId.slice(0, 4)}` },
    ]);
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Reviewer", role: "qa", status: "active" });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: reviewerAgentId, title: "Manifest mission", status: "active" });
    const templates = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
    const bodyA = options?.templateABody ?? "Template A body";
    await db.insert(missionPlanTemplates).values([
      { id: templates.a, companyId, key: "tpl-a", name: "A", selectionDescription: "A", instructions: bodyA, origin: "company_custom", enabled: true },
      { id: templates.b, companyId, key: "tpl-b", name: "B", selectionDescription: "B", instructions: "Template B body", origin: "company_custom", enabled: true },
      { id: templates.c, companyId, key: "tpl-c", name: "C", selectionDescription: "C", instructions: "Template C body", origin: "company_custom", enabled: true },
    ]);
    const selected = options?.selectedTemplateIds ?? [templates.a, templates.b];
    const planQaIssueId = randomUUID();
    await db.insert(issues).values({
      id: planQaIssueId, companyId, missionId, title: "[PLAN-QA] Manifest mission",
      originKind: "mission_plan_qa", originId: `plan-qa:${missionId}:${DECISION_HASH}`,
      status: "todo", assigneeAgentId: reviewerAgentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerAgentId, issueId: planQaIssueId, executionEpoch: 1 }).returning({ id: heartbeatRuns.id });
    const [plan] = await db.insert(missionPlanArtifacts).values({
      companyId, missionId, ownerAgentId: reviewerAgentId, revision: 1, missionGoal: "Goal",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{ id: "unit-1", title: "Draft", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: selected.map((id) => ({ id, key: id.slice(0, 8), contentHash: "0".repeat(64) })) },
        ownerPlanDecision: { decisionHash: DECISION_HASH },
        planQa: { issueId: planQaIssueId, status: "pending", decisionHash: DECISION_HASH },
      },
      requiredInputs: [{ label: "Input" }], successCriteria: [{ label: "Criterion" }],
      steps: [{ id: "step-1", title: "Draft" }],
    }).returning({ id: missionPlanArtifacts.id });
    if (options?.policyTargets) {
      const approvedAt = new Date();
      await db.insert(qualityPolicyVersions).values({
        companyId, version: 1, definition: policyDefinition(companyId, options.policyTargets(templates)),
        approvedByUserId: "quality-reviewer-1", approvedAt, enabledAt: approvedAt,
      });
    }
    return { companyId, otherCompanyId, missionId, planArtifactId: plan!.id, planQaIssueId, runId: run!.id, templates };
  }

  function scope(w: World, manifestRef: ArtifactRef, generation = 1, companyId = w.companyId): PlanQaScope {
    return {
      kind: "plan_qa", companyId, missionId: w.missionId, planArtifactId: w.planArtifactId,
      issueId: w.planQaIssueId, decisionHash: DECISION_HASH, reviewGeneration: generation,
      manifestRef, heartbeatRunId: w.runId, executionEpoch: 1,
      workflow: { kind: "not_applicable", reason: "mission_plan_qa_issue" },
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t7-manifest-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("pins the full selected set, bodies, policy, and per-template status", async () => {
    world = await seed({ policyTargets: (t) => [
      { templateId: t.a, baseHash: sha("Template A body"), required: [check("check-a", "always")] },
      { templateId: t.c, baseHash: sha("Template C body"), required: [check("check-c", [t.c])] },
    ] });

    const ref = await pinPlanQaManifest(db, { companyId: world.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);

    const read = await readPinnedPlanQaManifest(db, scope(world, ref));
    expect(read.selectedTemplateIds.sort()).toEqual([world.templates.a, world.templates.b].sort());
    expect(read.checks.map((entry) => entry.checkId)).toEqual(["check-a"]);
    expect(read.inputRef).toEqual(ref);

    const document = await readPlanQaManifestDocument(db, world.companyId, ref);
    expect(document.decisionHash).toBe(DECISION_HASH);
    expect(document.reviewGeneration).toBe(1);
    expect(document.policy?.policyVersionId).toBeTruthy();
    expect(document.input.decisionHash).toBe(DECISION_HASH);
    expect(document.input.refs.selectedExecutionUnits).toEqual([{ id: "unit-1", title: "Draft", selectionState: "selected" }]);
    const byId = new Map(document.templates.map((template) => [template.templateId, template]));
    expect(byId.get(world.templates.a)).toMatchObject({ status: "applied", bodyHash: sha("Template A body"), notAppliedReason: null });
    expect(byId.get(world.templates.b)).toMatchObject({ status: "no_active_addendum", notAppliedReason: "no_active_addendum" });
    expect(byId.get(world.templates.c)).toMatchObject({ status: "not_targeted", notAppliedReason: "template_not_selected", bodyHash: sha("Template C body") });
    expect(byId.get(world.templates.a)!.checks.map((entry) => entry.checkId)).toEqual(["check-a"]);
    // 원본 bytes 는 실제 storage 첨부다.
    const bytes = await readVerifiedArtifact(db, { companyId: world.companyId, ref, maxBytes: 2_097_152 });
    expect(JSON.parse(bytes.toString("utf8")).kind).toBe("plan_qa_manifest");
  });

  it("keeps the pinned manifest unchanged when templates change mid-review", async () => {
    world = await seed({ policyTargets: (t) => [
      { templateId: t.a, baseHash: sha("Template A body"), required: [check("check-a", "always")] },
    ] });
    const ref = await pinPlanQaManifest(db, { companyId: world.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    await db.update(missionPlanTemplates).set({ instructions: "Template A body EDITED mid-review" }).where(eq(missionPlanTemplates.id, world.templates.a));
    const again = await readPinnedPlanQaManifest(db, scope(world, ref));
    expect(again.inputRef).toEqual(ref);
    const document = await readPlanQaManifestDocument(db, world.companyId, ref);
    expect(document.templates.find((template) => template.templateId === world.templates.a)!.bodyHash).toBe(sha("Template A body"));
    expect(blockedPlanQaTemplates(document)).toEqual([]);
  });

  it("rejects a selected template that is missing from the company set", async () => {
    const foreignId = randomUUID();
    await db.insert(missionPlanTemplates).values({ id: foreignId, companyId: world.otherCompanyId, key: `foreign-${foreignId.slice(0, 8)}`, name: "F", selectionDescription: "F", instructions: "Other company body", origin: "company_custom", enabled: true });
    const w = await seed({ selectedTemplateIds: [foreignId] });
    await expect(pinPlanQaManifest(db, { companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 }))
      .rejects.toThrow("quality_plan_qa_template_unavailable");
  });

  it("records base_changed for a drifted required target and blocks new runs", async () => {
    const w = await seed({
      templateABody: "Template A NEW body",
      policyTargets: (t) => [{ templateId: t.a, baseHash: sha("Template A body"), required: [check("check-a", "always")] }],
    });
    const ref = await pinPlanQaManifest(db, { companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    const document = await readPlanQaManifestDocument(db, w.companyId, ref);
    const template = document.templates.find((entry) => entry.templateId === w.templates.a)!;
    expect(template.status).toBe("base_changed");
    expect(template.policyBaseHash).toBe(sha("Template A body"));
    expect(template.bodyHash).toBe(sha("Template A NEW body"));
    expect(blockedPlanQaTemplates(document)).toEqual([w.templates.a]);
    const read = await readPinnedPlanQaManifest(db, scope(w, ref));
    expect(read.checks).toEqual([]);
  });

  it("fails the pin when an applicability references an out-of-set template", async () => {
    const unknown = randomUUID();
    const w = await seed({ policyTargets: (t) => [{ templateId: t.a, baseHash: sha("Template A body"), required: [check("check-x", [unknown])] }] });
    await expect(pinPlanQaManifest(db, { companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 }))
      .rejects.toThrow("quality_plan_qa_applicability_out_of_set");
  });

  it("rejects cross-company and wrong-generation reads", async () => {
    const w = await seed();
    const ref = await pinPlanQaManifest(db, { companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    await expect(readPinnedPlanQaManifest(db, scope(w, ref, 1, w.otherCompanyId))).rejects.toThrow(/quality_/);
    await expect(readPinnedPlanQaManifest(db, scope(w, ref, 2))).rejects.toThrow("quality_plan_qa_binding_mismatch");
    await expect(readPlanQaManifestDocument(db, w.otherCompanyId, ref)).rejects.toThrow(/quality_/);
  });

  it("returns only checks whose applicability is satisfied by the pinned selection", async () => {
    const w = await seed({
      selectedTemplateIds: undefined,
      policyTargets: (t) => [{
        templateId: t.a, baseHash: sha("Template A body"),
        required: [check("check-always", "always"), check("check-conditional", [t.a, t.b])],
      }],
    });
    // 선택 집합을 A 로 좁힌다(조건 검사는 B 때문에 미충족).
    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    await db.update(missionPlanArtifacts).set({
      refs: { ...(plan!.refs as Record<string, unknown>), planTemplates: { selectionSource: "explicit", items: [{ id: w.templates.a, key: "tpl-a", contentHash: "0".repeat(64) }] } },
    }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    const ref = await pinPlanQaManifest(db, { companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    const read = await readPinnedPlanQaManifest(db, scope(w, ref));
    expect(read.checks.map((entry) => entry.checkId)).toEqual(["check-always"]);
  });

  it("rejects unknown keys inside pinned template objects (strict machine contract)", async () => {
    world = await seed({ policyTargets: (t) => [
      { templateId: t.a, baseHash: sha("Template A body"), required: [check("check-a", "always")] },
    ] });
    const ref = await pinPlanQaManifest(db, { companyId: world.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    const document = await readPlanQaManifestDocument(db, world.companyId, ref);
    const tampered = { ...document, templates: document.templates.map((template, index) => (
      index === 0 ? { ...template, reviewerHint: "사람이 덧붙인 힌트" } : template
    )) };
    const tamperedRef = await repinManifest(db, world, Buffer.from(JSON.stringify(tampered)));
    await expect(readPlanQaManifestDocument(db, world.companyId, tamperedRef))
      .rejects.toThrow("quality_plan_qa_invalid_manifest");
  });

  it("still parses old pinned manifests that lack the T9 addendum binding fields", async () => {
    world = await seed({ policyTargets: (t) => [
      { templateId: t.a, baseHash: sha("Template A body"), required: [check("check-a", "always")] },
    ] });
    const ref = await pinPlanQaManifest(db, { companyId: world.companyId, missionId: world.missionId, planArtifactId: world.planArtifactId, decisionHash: DECISION_HASH, reviewGeneration: 1 });
    const document = await readPlanQaManifestDocument(db, world.companyId, ref);
    const legacy = {
      ...document,
      templates: document.templates.map(({ addendumVersionId: _versionId, addendumBodySha256: _bodySha, ...rest }) => rest),
    };
    const legacyRef = await repinManifest(db, world, Buffer.from(JSON.stringify(legacy)));
    const parsed = await readPlanQaManifestDocument(db, world.companyId, legacyRef);
    expect(parsed.templates[0]).toMatchObject({ status: "applied", templateId: world.templates.a, bodyHash: sha("Template A body") });
    expect(parsed.templates[0]?.addendumVersionId).toBeUndefined();
  });
});

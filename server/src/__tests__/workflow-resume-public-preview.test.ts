import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, workflowStepRuns, type Db } from "@paperclipai/db";
import {
  resetReviewedPolicies, seedResumeApplyScenario, TEST_REVIEWED_POLICIES,
  startExecutionDefinitionFixture, type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-apply-fixture.js";
import {
  canonicalPreviewDomain, expectDomainUnchanged, seedPreviewGraph, seedCompanyWithMission,
  seedWorkflowDefinition, seedWorkflowRun, seedPreviewIssue, seedPreviewWorkProduct,
} from "./helpers/workflow-resume-preview-fixture.js";
import { publicPreviewSchema, publicResumeApp, publicResumePath, renderPublicPreview } from "./helpers/workflow-resume-public-fixture.js";
import { verifySnapshot } from "../services/workflow/resume/snapshot.js";

// Only reviewed TEST policy is substituted. GET, signer, DB, snapshot and UI are real.
vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});
const KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const KEY = "ab".repeat(32);
const originalKey = process.env[KEY_ENV];

describe("public preview: mounted HTTP → real UI", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("public-preview-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started; db = fixture.db;
    process.env[KEY_ENV] = KEY;
  }, 60_000);
  beforeEach(() => resetReviewedPolicies());
  afterAll(async () => {
    if (originalKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = originalKey;
    await fixture?.cleanup();
  });

  async function get(scope: { companyId: string; missionId: string; runId: string }, startStepId = "gate") {
    const before = await canonicalPreviewDomain(db);
    const response = await expectDomainUnchanged(db, before, async () => await request(publicResumeApp(db))
      .get(publicResumePath(scope, "preview")).query({ workflowRunId: scope.runId, startStepId }));
    expect(response.status).toBe(200);
    // Deliberately render the unmodified real response before parsing: catches the original crash.
    const html = renderPublicPreview(response.body);
    const preview = publicPreviewSchema.parse(response.body);
    expect(preview).toMatchObject({ companyId: scope.companyId, missionId: scope.missionId,
      workflowRunId: scope.runId, startStepId });
    return { preview, html };
  }
  async function seed() {
    return seedResumeApplyScenario(db, fixture.sql, `pp-${randomUUID().slice(0, 8)}`);
  }

  it("eligible exact public keys, frozen labels/actions, real signed state and readonly GET", async () => {
    const scenario = await seed();
    await fixture.sql`UPDATE workflow_definitions SET steps_json = ${JSON.stringify([
      { id: "gate", name: "MUTABLE SECRET LABEL", agentId: "", dependencies: [] },
    ])} WHERE id = ${scenario.workflowId}`;
    const { preview, html } = await get(scenario);
    expect(preview).toMatchObject({ eligible: true, blockers: [], evidence: [], approvals: [],
      generation: "none", budget: "verified", preserved: [{ stepId: "side", name: "Side branch" }] });
    expect(preview.affected).toEqual([
      { stepId: "done", name: "Done", action: "reevaluate" },
      { stepId: "gate", name: "Gate", action: "reevaluate" },
      { stepId: "redo", name: "Redo", action: "execute" },
    ]);
    const state = verifySnapshot(preview.snapshotToken!, Buffer.from(KEY, "hex"), new Date());
    expect(state.scope.startStepId).toBe("gate");
    expect(state.definitionHash).toBe(scenario.definitionHash);
    expect(state.evidence).toEqual(preview.evidence);
    expect(Date.parse(preview.expiresAt!)).toBeGreaterThan(Date.now());
    for (const text of ["Gate", "Redo", "Done", "Side branch", "재평가", "실행", "예산 확인 완료",
      "재실행 범위에서 새 생성 없음", "필수 승인: 없음"]) expect(html).toContain(text);
    expect(html).not.toContain("MUTABLE SECRET LABEL");
  });

  it("missing policy stays blocked, unknown approvals and possible generation render honestly", async () => {
    const scenario = await seed(); resetReviewedPolicies();
    const { preview, html } = await get(scenario);
    expect(preview).toMatchObject({ eligible: false, snapshotToken: null, expiresAt: null,
      evidence: [], approvals: [], generation: "possible", budget: "verified" });
    expect(preview.blockers.map((b) => b.code)).toContain("external_effect_unknown");
    expect(preview.affected.find((s) => s.stepId === "gate")?.name).toBe("Gate");
    expect(html).toContain("필수 승인: 확정할 수 없음");
    expect(html).toContain("재실행 범위에서 생성이 발생할 수 있습니다");
    expect(html).toContain("예산 확인 완료");
  });

  it("affected required gates/publication approvals and generation come from frozen state", async () => {
    const scenario = await seed();
    TEST_REVIEWED_POLICIES[0]!.requiredGateStepIds = ["gate"];
    TEST_REVIEWED_POLICIES[0]!.publicationStepIds = ["done", "gate"];
    TEST_REVIEWED_POLICIES[0]!.generationStepIds = ["redo"];
    const { preview, html } = await get(scenario);
    expect(preview.approvals).toEqual([{ stepId: "done", required: true }, { stepId: "gate", required: true }]);
    expect(preview.generation).toBe("possible");
    expect(html).toContain("필수 승인: 2개 단계에 필요");
    const state = verifySnapshot(preview.snapshotToken!, Buffer.from(KEY, "hex"), new Date());
    expect(state.approvals.map((a) => a.stepId)).toEqual(preview.approvals.map((a) => a.stepId));
  });

  it.each([
    { spent: -1, code: "budget_unknown", budget: "unknown", label: "예산 상태 미확인" },
    { spent: 100, code: "budget_exceeded", budget: "verified", label: "예산 확인 완료" },
  ])("$code blocks without changing known/unknown budget semantics", async ({ spent, code, budget, label }) => {
    const scenario = await seed();
    await db.update(companies).set({ budgetMonthlyCents: 100, spentMonthlyCents: spent }).where(eq(companies.id, scenario.companyId));
    const { preview, html } = await get(scenario);
    expect(preview).toMatchObject({ eligible: false, snapshotToken: null, expiresAt: null, evidence: [], budget });
    expect(preview.blockers.map((b) => b.code)).toEqual([code]);
    expect(html).toContain(label);
    expect(html).toContain("필수 승인: 없음");
  });

  it("historical unproven yields no invented graph/evidence/approvals and unknown budget", async () => {
    const base = await seedCompanyWithMission(fixture.sql, `ph-${randomUUID().slice(0, 8)}`);
    const workflowId = await seedWorkflowDefinition(fixture.sql, { companyId: base.companyId,
      stepsJson: [{ id: "gate", name: "Unproven live name", agentId: "" }] });
    const runId = await seedWorkflowRun(fixture.sql, { ...base, workflowId });
    const { preview, html } = await get({ ...base, runId });
    expect(preview).toMatchObject({ eligible: false, affected: [], preserved: [], evidence: [], approvals: [],
      generation: "possible", budget: "unknown", snapshotToken: null, expiresAt: null });
    expect(preview.blockers.map((b) => b.code)).toEqual(["historical_definition_unproven"]);
    expect(html).toContain("필수 승인: 확정할 수 없음");
    expect(html).toContain("예산 상태 미확인");
    expect(html).not.toContain("Unproven live name");
  });

  it.each(["backedge", "dynamic"])("unsupported %s graph yields empty, unsigned unknown projection", async (kind) => {
    const graph = await seedPreviewGraph(fixture.sql, db, { executionMode: kind === "dynamic" ? "dynamic_owner_plan" : null,
      stepsJson: [
        { id: "gate", name: "Gate", agentId: "", dependencies: [] },
        { id: "child", name: "Child", agentId: "", dependencies: ["gate"],
          conditionalDependencies: kind === "backedge" ? [{ stepId: "gate", when: "failure", isBackEdge: true, maxIterations: 3 }] : [] },
      ] });
    const { preview, html } = await get(graph);
    expect(preview).toMatchObject({ eligible: false, affected: [], preserved: [], evidence: [], approvals: [],
      generation: "possible", budget: "unknown", snapshotToken: null, expiresAt: null });
    expect(preview.blockers.map((b) => b.code)).toEqual(["unsupported_graph"]);
    expect(html).toContain("필수 승인: 확정할 수 없음");
    expect(html).toContain("재실행 범위에서 생성이 발생할 수 있습니다");
  });

  it("unsupported step type is display-only execute and remains ineligible", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: [
      { id: "gate", name: "Unsupported frozen step", agentId: "", type: "unsupported-future-type", dependencies: [] },
    ] });
    const { preview, html } = await get(graph);
    expect(preview).toMatchObject({ eligible: false, snapshotToken: null,
      affected: [{ stepId: "gate", name: "Unsupported frozen step", action: "execute" }] });
    expect(preview.blockers).toContainEqual({ code: "unsupported_graph", stepId: "gate", message: expect.any(String) });
    expect(html).toContain("필수 승인: 확정할 수 없음");
  });

  it("outside claimed evidence is not public proof; blocker retains only its step identity", async () => {
    const scenario = await seed();
    const issueId = await seedPreviewIssue(db, { companyId: scenario.companyId, missionId: scenario.missionId });
    await db.update(workflowStepRuns).set({ status: "completed", issueId }).where(eq(workflowStepRuns.id, scenario.stepRunIds.gate!));
    await seedPreviewWorkProduct(db, { companyId: scenario.companyId, issueId,
      metadata: { sha256: "9".repeat(64), secret: "PRIVATE EVIDENCE CLAIM" } });
    const { preview, html } = await get(scenario, "redo");
    expect(preview).toMatchObject({ eligible: false, snapshotToken: null, evidence: [],
      preserved: [{ stepId: "gate", name: "Gate" }, { stepId: "side", name: "Side branch" }] });
    expect(preview.blockers).toEqual([{ code: "missing_evidence", stepId: "gate", message: expect.any(String) }]);
    expect(html).not.toContain("PRIVATE EVIDENCE CLAIM");
  });
});

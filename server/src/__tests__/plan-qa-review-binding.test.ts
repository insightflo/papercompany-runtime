// [TEST] T7 PLAN-QA 검토 binding: issue 생성·서버 표식·명세 연결을 같은 tx 로 확정한 뒤에만
// 실행 요청(wake) 한다. 같은 세대 재사용은 저장 명세를 읽고, plan/실행 단위 변경은 새 세대로
// 이전 판정을 무효화한다. 완료된 검토에는 binding 을 덧붙이지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agents, companies, createDb, issueAttachments, issueComments, issues, missionPlanArtifacts,
  missionPlanTemplates, missionPlanQaVerdicts, missions, qualityPolicyVersions, type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { ensurePlanQaReviewIssue } from "../services/missions/plan-qa-reviewer-assignment.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";
import { planQaReviewBindingMarkerSchema } from "../services/missions/plan-qa-review-binding.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const DECISION_HASH = "b".repeat(64);

type World = {
  companyId: string; missionId: string; planArtifactId: string; planningIssueId: string;
  reviewerAgentId: string; templateId: string;
  wakeups: Array<{ issueId: string; markerSeen: unknown }>;
  enqueue: (input: { issueId: string }) => Promise<void>;
};

describeQualityDb("PLAN-QA review binding", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;

  async function seed(options?: { templateBody?: string; policyBaseHash?: string }): Promise<World> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding Co", issuePrefix: `BD${companyId.slice(0, 4)}` });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Binding Reviewer", role: "qa", status: "active" });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: reviewerAgentId, title: "Binding mission", description: "desc", status: "active" });
    const planningIssueId = randomUUID();
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Planning", originKind: "mission_main_executor_plan", status: "todo" });
    const templateId = randomUUID();
    const body = options?.templateBody ?? "Binding template body";
    await db.insert(missionPlanTemplates).values({ id: templateId, companyId, key: "tpl-bind", name: "Bind", selectionDescription: "Bind", instructions: body, origin: "company_custom", enabled: true });
    if (options?.policyBaseHash) {
      const now = new Date();
      await db.insert(qualityPolicyVersions).values({
        companyId, version: 1,
        definition: {
          targets: [{ companyId, templateId, baseHash: options.policyBaseHash, required: [{
            checkId: "check-bind", requirementRefs: [{ attachmentId: randomUUID(), sha256: "10".repeat(32) }],
            applicability: { op: "always" }, expectedEvidenceKinds: ["evaluation_receipt"], instructions: "추가 검사",
          }] }],
          authorAgentIds: [randomUUID()], verifierAgentIds: [randomUUID()], allowedToolIds: [],
          reviewerUserIds: ["quality-reviewer-1"], rollbackUserIds: ["quality-rollback-1"],
          requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "11".repeat(32) }],
          caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "12".repeat(32) }],
          nativeOwnership: "native-active-plugin-disabled",
          maxActions: 5, maxCandidatesPerAction: 2, maxEvaluationsPerCandidate: 2, maxOuterCycles: 2,
          maxEvidenceResubmissions: 1, maxExecutionAttempts: 4, maxCostCentsPerGroup: 100, maxCostCentsPerPeriod: 1000,
          maxElapsedSeconds: 3600, decisionTtlSeconds: 900, observationSeconds: 86_400, reconcileBatchSize: 10,
          periodStart: now.toISOString(), periodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
        },
        approvedByUserId: "quality-reviewer-1", approvedAt: now, enabledAt: now,
      });
    }
    const [plan] = await db.insert(missionPlanArtifacts).values({
      companyId, missionId, ownerAgentId: reviewerAgentId, revision: 1, missionGoal: "Binding goal",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{ id: "unit-1", title: "Draft", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: [{ id: templateId, key: "tpl-bind", contentHash: sha(body) }] },
        ownerPlanDecision: { decisionHash: DECISION_HASH },
      },
      requiredInputs: [{ label: "Input" }], successCriteria: [{ label: "Criterion" }],
      steps: [{ id: "step-1", title: "Draft" }],
    }).returning({ id: missionPlanArtifacts.id });
    const wakeups: World["wakeups"] = [];
    const enqueue = async (input: { issueId: string }) => {
      const [row] = await db.select({ marker: issues.qualityPlanQaBinding }).from(issues).where(eq(issues.id, input.issueId));
      wakeups.push({ issueId: input.issueId, markerSeen: row?.marker ?? null });
    };
    return { companyId, missionId, planArtifactId: plan!.id, planningIssueId, reviewerAgentId, templateId, wakeups, enqueue };
  }

  async function ensure(w: World) {
    return ensurePlanQaReviewIssue({
      db, companyId: w.companyId, missionId: w.missionId, missionTitle: "Binding mission", missionDescription: "desc",
      planningIssueId: w.planningIssueId, decisionHash: DECISION_HASH, missionGoal: "Binding goal",
      preferredReviewerAgentId: w.reviewerAgentId, enqueuePlanQaWakeup: w.enqueue, planArtifactId: w.planArtifactId,
    });
  }

  async function markerOf(issueId: string) {
    const [row] = await db.select({ marker: issues.qualityPlanQaBinding, status: issues.status, hiddenAt: issues.hiddenAt }).from(issues).where(eq(issues.id, issueId));
    return row ?? null;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t7-binding-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("commits issue, marker, and manifest together before the wake", async () => {
    const w = await seed();
    const created = await ensure(w);
    expect(created.reviewGeneration).toBe(1);
    expect(created.manifestRef).toBeTruthy();
    expect(created.blockedTemplateIds).toEqual([]);

    const row = await markerOf(created.id);
    const marker = planQaReviewBindingMarkerSchema.parse(row?.marker);
    expect(marker.reviewGeneration).toBe(1);
    expect(marker.manifestRef).toEqual(created.manifestRef);
    expect(marker.decisionHash).toBe(DECISION_HASH);

    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, created.id));
    expect(attachments).toHaveLength(1);

    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    const planQa = (plan!.refs as Record<string, unknown>).planQa as Record<string, unknown>;
    expect(planQa.issueId).toBe(created.id);
    expect(planQa.reviewGeneration).toBe(1);
    expect(planQa.manifestRef).toEqual(created.manifestRef);

    expect(w.wakeups).toHaveLength(1);
    expect(planQaReviewBindingMarkerSchema.safeParse(w.wakeups[0]!.markerSeen).success).toBe(true);

    const [issue] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(issue!.assigneeAgentId).toBe(w.reviewerAgentId);
    expect(issue!.description).toContain("generation 1");
    expect(issue!.description).toContain("mission-plan-qa/verdict");
    expect(issue!.description).not.toContain("Fallback/parser compatibility");
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, w.companyId), eq(activityLog.action, "mission.plan_qa.binding_created")));
    expect(activity).toBeTruthy();
  });

  it("reuses the stored same-generation manifest even when templates change", async () => {
    const w = await seed();
    const first = await ensure(w);
    await db.update(missionPlanTemplates).set({ instructions: "EDITED body" }).where(eq(missionPlanTemplates.id, w.templateId));
    const second = await ensure(w);
    expect(second.id).toBe(first.id);
    expect(second.reviewGeneration).toBe(1);
    expect(second.manifestRef).toEqual(first.manifestRef);
    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, first.id));
    expect(attachments).toHaveLength(1);
  });

  it("does not bump the generation for a plain comment", async () => {
    const w = await seed();
    const first = await ensure(w);
    await db.insert(issueComments).values({ companyId: w.companyId, issueId: first.id, body: "QA comment", authorAgentId: w.reviewerAgentId });
    const second = await ensure(w);
    expect(second.reviewGeneration).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it("opens a new generation when execution units change and invalidates prior verdicts", async () => {
    const w = await seed();
    const first = await ensure(w);
    await db.insert(missionPlanQaVerdicts).values({
      companyId: w.companyId, missionId: w.missionId, planQaIssueId: first.id,
      decisionHash: DECISION_HASH, verdict: "pass", diagnostics: [],
    });
    await db.update(missionPlanArtifacts).set({
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{ id: "unit-2", title: "Recovered", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: [{ id: w.templateId, key: "tpl-bind", contentHash: sha("Binding template body") }] },
        ownerPlanDecision: { decisionHash: DECISION_HASH },
      },
    }).where(eq(missionPlanArtifacts.id, w.planArtifactId));

    const second = await ensure(w);
    expect(second.id).not.toBe(first.id);
    expect(second.reviewGeneration).toBe(2);

    const old = await markerOf(first.id);
    expect(old?.status).toBe("cancelled");
    expect(old?.hiddenAt).toBeTruthy();
    const oldMarker = planQaReviewBindingMarkerSchema.parse(old?.marker);
    expect(oldMarker.supersededAt).toBeTruthy();

    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    const planQa = (plan!.refs as Record<string, unknown>).planQa as Record<string, unknown>;
    expect(planQa.issueId).toBe(second.id);
    expect(planQa.reviewGeneration).toBe(2);

    const [preserved] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, first.id));
    expect(preserved?.verdict).toBe("pass");

    await expect(submitMissionPlanQaVerdict({
      db, issue: { id: first.id, companyId: w.companyId, missionId: w.missionId, originKind: "mission_plan_qa" },
      actor: { actorType: "agent", actorId: w.reviewerAgentId, agentId: w.reviewerAgentId, runId: null },
      data: { verdict: "pass", diagnostics: [] },
    // 대체(superseded)된 binding 은 활성 이슈 확인 전에 gate 가 fail-closed 로 먼저 거부한다
    // (planQaGateMode: supersededAt → fail_closed → quality_plan_qa_binding_invalid).
    })).rejects.toThrow(/quality_plan_qa_binding_invalid/);
  });

  it("never binds a completed review", async () => {
    const w = await seed();
    const first = await ensure(w);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.id));
    const second = await ensure(w);
    expect(second.id).toBe(first.id);
    expect(second.reviewGeneration).toBeNull();
    expect(second.manifestRef).toBeNull();
    const row = await markerOf(first.id);
    expect(planQaReviewBindingMarkerSchema.parse(row?.marker).reviewGeneration).toBe(1);
  });

  it("binds a legacy pending issue without a marker at its next execution start", async () => {
    const w = await seed();
    const legacyIssueId = randomUUID();
    await db.insert(issues).values({
      id: legacyIssueId, companyId: w.companyId, missionId: w.missionId, title: "[PLAN-QA] Binding mission",
      originKind: "mission_plan_qa", originId: `plan-qa:${w.missionId}:${DECISION_HASH}`,
      status: "todo", assigneeAgentId: w.reviewerAgentId,
    });
    const result = await ensure(w);
    expect(result.id).toBe(legacyIssueId);
    expect(result.reviewGeneration).toBe(1);
    const row = await markerOf(legacyIssueId);
    expect(planQaReviewBindingMarkerSchema.safeParse(row?.marker).success).toBe(true);
  });

  it("blocks the review execution when a required target base changed", async () => {
    const w = await seed({ templateBody: "NEW body", policyBaseHash: sha("OLD body") });
    const created = await ensure(w);
    expect(created.blockedTemplateIds).toEqual([w.templateId]);
    const row = await markerOf(created.id);
    expect(planQaReviewBindingMarkerSchema.safeParse(row?.marker).success).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(issue!.assigneeAgentId).toBeNull();
    expect(issue!.description).toContain("quality_plan_qa_base_changed_required");
    expect(w.wakeups).toHaveLength(0);
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, w.companyId), eq(activityLog.action, "mission.plan_qa.binding_blocked")));
    expect(activity).toBeTruthy();
  });
});

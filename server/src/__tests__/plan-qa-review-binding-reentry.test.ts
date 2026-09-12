// [TEST] T7 fix round 1: PLAN-QA binding 재진입 코너 3종.
//   1) base_changed(required) 차단 상태의 같은 decisionHash 재진입은 배정/기상(wake)하지 않는다.
//   2) 재사용 결정 이슈(originId 불일치)의 실행 단위 변경 rebound 은 existingIssueId 로 정상 supersede.
//   3) existingIssueId 없이 같은 상태에 재진입하면 refs 인덱스 guard 미통과가 충돌로 제출된다(조용한 no-op 제거).
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  agents, companies, createDb, issues, missionPlanArtifacts, missionPlanTemplates, missions,
  qualityPolicyVersions, type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { ensurePlanQaReviewIssue, ensurePlanQaWakeupForIssue } from "../services/missions/plan-qa-reviewer-assignment.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";
import { planQaReviewBindingMarkerSchema } from "../services/missions/plan-qa-review-binding.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const DECISION_HASH = "b".repeat(64);
const TEMPLATE_BODY = "Binding template body";

type World = {
  companyId: string; missionId: string; planArtifactId: string; planningIssueId: string;
  reviewerAgentId: string; templateId: string;
  wakeups: Array<{ issueId: string }>;
  enqueue: (input: { issueId: string }) => Promise<void>;
};

describeQualityDb("PLAN-QA review binding re-entry corners", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;

  async function seed(options?: { blocked?: boolean }): Promise<World> {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reentry Co", issuePrefix: `RE${companyId.slice(0, 4)}` });
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Reentry Reviewer", role: "qa", status: "active" });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: reviewerAgentId, title: "Reentry mission", description: "desc", status: "active" });
    const planningIssueId = randomUUID();
    await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Planning", originKind: "mission_main_executor_plan", status: "todo" });
    const templateId = randomUUID();
    await db.insert(missionPlanTemplates).values({ id: templateId, companyId, key: "tpl-re", name: "Re", selectionDescription: "Re", instructions: TEMPLATE_BODY, origin: "company_custom", enabled: true });
    if (options?.blocked) {
      const now = new Date();
      await db.insert(qualityPolicyVersions).values({
        companyId, version: 1,
        definition: {
          targets: [{ companyId, templateId, baseHash: sha("OLD body"), required: [{
            checkId: "check-re", requirementRefs: [{ attachmentId: randomUUID(), sha256: "10".repeat(32) }],
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
      companyId, missionId, ownerAgentId: reviewerAgentId, revision: 1, missionGoal: "Reentry goal",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{ id: "unit-1", title: "Draft", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: [{ id: templateId, key: "tpl-re", contentHash: sha(TEMPLATE_BODY) }] },
        ownerPlanDecision: { decisionHash: DECISION_HASH },
      },
      requiredInputs: [{ label: "Input" }], successCriteria: [{ label: "Criterion" }],
      steps: [{ id: "step-1", title: "Draft" }],
    }).returning({ id: missionPlanArtifacts.id });
    const wakeups: World["wakeups"] = [];
    const enqueue = async (input: { issueId: string }) => { wakeups.push({ issueId: input.issueId }); };
    return { companyId, missionId, planArtifactId: plan!.id, planningIssueId, reviewerAgentId, templateId, wakeups, enqueue };
  }

  async function ensure(w: World, opts?: { existingIssueId?: string }) {
    return ensurePlanQaReviewIssue({
      db, companyId: w.companyId, missionId: w.missionId, missionTitle: "Reentry mission", missionDescription: "desc",
      planningIssueId: w.planningIssueId, decisionHash: DECISION_HASH, missionGoal: "Reentry goal",
      preferredReviewerAgentId: w.reviewerAgentId, enqueuePlanQaWakeup: w.enqueue, planArtifactId: w.planArtifactId,
      ...(opts?.existingIssueId ? { existingIssueId: opts.existingIssueId } : {}),
    });
  }

  /** 검토 중 실행 단위만 바꾼다(planQa 인덱스는 보존 — 실재 rebound 상태). */
  async function changeExecutionUnits(w: World) {
    const [current] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    await db.update(missionPlanArtifacts).set({
      refs: {
        ...(current!.refs as Record<string, unknown>),
        selectedExecutionUnits: [{ id: "unit-2", title: "Recovered", selectionState: "selected" }],
      },
    }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
  }

  /** 재사용 결정 이슈: 의사결정이 mission_plan_qa 이슈에서 왔을 때 그 이슈는 이전 decisionHash 의 originId 를 담는다. */
  async function insertReusedDecisionIssue(w: World): Promise<string> {
    const reusedIssueId = randomUUID();
    await db.insert(issues).values({
      id: reusedIssueId, companyId: w.companyId, missionId: w.missionId, title: "[PLAN-QA] Reentry mission",
      originKind: "mission_plan_qa", originId: `plan-qa:${w.missionId}:${"a".repeat(64)}`,
      status: "todo",
    });
    return reusedIssueId;
  }

  async function livePlanQaIssues(companyId: string) {
    return db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"), isNull(issues.hiddenAt)));
  }

  async function planQaRefOf(planArtifactId: string) {
    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, planArtifactId));
    return (plan!.refs as Record<string, unknown>).planQa as Record<string, unknown>;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t7-reentry-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("keeps a blocked review unassigned and unwoken on same-decisionHash re-entry", async () => {
    const w = await seed({ blocked: true });
    const first = await ensure(w);
    expect(first.blockedTemplateIds).toEqual([w.templateId]);

    // 같은 decisionHash 재진입(branch (b) pending 경로)은 차단 상태를 우회해 배정/기상하지 않는다.
    await ensurePlanQaWakeupForIssue({
      db, enqueuePlanQaWakeup: w.enqueue, companyId: w.companyId, planQaIssueId: first.id,
      missionId: w.missionId, planningIssueId: w.planningIssueId, preferredReviewerAgentId: w.reviewerAgentId,
    });
    expect(w.wakeups).toHaveLength(0);
    const [afterWakeAttempt] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, first.id));
    expect(afterWakeAttempt!.assigneeAgentId).toBeNull();

    // 전체 재진입(ensurePlanQaReviewIssue)도 차단 상태를 유지한다.
    const second = await ensure(w);
    expect(second.id).toBe(first.id);
    expect(second.blockedTemplateIds).toEqual([w.templateId]);
    expect(w.wakeups).toHaveLength(0);
    const [afterReentry] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, first.id));
    expect(afterReentry!.assigneeAgentId).toBeNull();
  });

  it("supersedes the reused decision issue (foreign originId) instead of duplicating when rebound with existingIssueId", async () => {
    const w = await seed();
    const reusedIssueId = await insertReusedDecisionIssue(w);
    const first = await ensure(w, { existingIssueId: reusedIssueId });
    expect(first.id).toBe(reusedIssueId);
    expect(first.reviewGeneration).toBe(1);

    await changeExecutionUnits(w);
    const second = await ensure(w, { existingIssueId: reusedIssueId });
    expect(second.id).not.toBe(reusedIssueId);
    expect(second.reviewGeneration).toBe(2);

    const [old] = await db.select({ status: issues.status, hiddenAt: issues.hiddenAt, marker: issues.qualityPlanQaBinding })
      .from(issues).where(eq(issues.id, reusedIssueId));
    expect(old!.status).toBe("cancelled");
    expect(old!.hiddenAt).toBeTruthy();
    expect(planQaReviewBindingMarkerSchema.parse(old!.marker).supersededAt).toBeTruthy();

    const live = await livePlanQaIssues(w.companyId);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(second.id);

    const planQa = await planQaRefOf(w.planArtifactId);
    expect(planQa.issueId).toBe(second.id);
    expect(planQa.reviewGeneration).toBe(2);

    await expect(submitMissionPlanQaVerdict({
      db, issue: { id: reusedIssueId, companyId: w.companyId, missionId: w.missionId, originKind: "mission_plan_qa" },
      actor: { actorType: "agent", actorId: w.reviewerAgentId, agentId: w.reviewerAgentId, runId: null },
      data: { verdict: "pass", diagnostics: [] },
    // 대체(superseded)된 binding 은 활성 이슈 확인 전에 gate 가 fail-closed 로 먼저 거부한다
    // (planQaGateMode: supersededAt → fail_closed → quality_plan_qa_binding_invalid).
    })).rejects.toThrow(/quality_plan_qa_binding_invalid/);
  });

  it("rejects a duplicate binding attempt on a reused issue (foreign originId) found without existingIssueId", async () => {
    const w = await seed();
    const reusedIssueId = await insertReusedDecisionIssue(w);
    const first = await ensure(w, { existingIssueId: reusedIssueId });
    expect(first.id).toBe(reusedIssueId);

    await changeExecutionUnits(w);
    // existingIssueId 없이 originId 조회로 재진입하면 중복 이슈 생성 후 refs 인덱스가 조용히
    // no-op 되던 경로. 이제 guard 미통과가 충돌로 제출되고 tx 는 전부 롤백된다.
    await expect(ensure(w)).rejects.toThrow(/quality_plan_qa_binding_conflict/);

    const live = await livePlanQaIssues(w.companyId);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(reusedIssueId);

    const planQa = await planQaRefOf(w.planArtifactId);
    expect(planQa.issueId).toBe(reusedIssueId);
    const [reused] = await db.select({ status: issues.status, hiddenAt: issues.hiddenAt }).from(issues).where(eq(issues.id, reusedIssueId));
    expect(reused!.status).toBe("todo");
    expect(reused!.hiddenAt).toBeNull();
  });
});

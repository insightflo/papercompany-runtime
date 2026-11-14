import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  instanceSettings,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  applySigner,
  boardActor,
  resetReviewedPolicies,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
  type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { previewResume } from "../services/workflow/resume/preview.js";
import { applyResume } from "../services/workflow/resume/apply.js";
import { resumeApplyBody } from "./helpers/workflow-resume-apply-fixture.js";
import { seedPreviewGraph, previewScope } from "./helpers/workflow-resume-preview-fixture.js";

/**
 * [목적] review-relief v1 검증 — ①플래그 OFF 동작 불변 ②사람 승인(해소+accepted) 시 오탐 보수 차단
 *   경고화·재개 성립 ③external 미확인은 사람 승인 없이(stuck 만으로) 완화 금지 ④활성 실행·미션
 *   상태 차단 유지 ⑤apply 경로 일관(완료 스텝 보존·실패 스텝부터). 실제 임베디드 PostgreSQL.
 */

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const NOW = new Date("2026-09-08T01:00:00.000Z");
const RUN_COMPLETED_AT = new Date("2026-09-07T09:40:00.000Z");

const describeEP = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;

async function setReliefFlag(db: Db, experimental: Record<string, unknown>) {
  await db.insert(instanceSettings).values({ singletonKey: "default", experimental })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental } });
}

/** 미션 이슈 + resolved 결정 + accepted continuation(= #721 구조화 사람 승인 판정). */
async function seedHumanApproval(db: Db, scenario: ResumeApplyScenario, acceptedAt: Date) {
  const [issue] = await db.insert(issues).values({ companyId: scenario.companyId,
    missionId: scenario.missionId, title: "Resume approval", status: "blocked",
    assigneeAgentId: scenario.agentId }).returning();
  const decisionId = randomUUID(), continuationWakeId = randomUUID();
  await db.insert(operatorDecisions).values({
    id: decisionId, companyId: scenario.companyId, requestKey: `relief:${randomUUID()}`,
    requestHash: "rh", interactionType: "single_select", priority: "high",
    title: "approve resume direction", sourceType: "mission_owner_human_input",
    sourceId: randomUUID(), sourceContext: { missionId: scenario.missionId },
    issueId: issue!.id, status: "resolved", continuationMode: "issue_current_assignee",
    definition: { options: [], actions: [], selection: null,
      comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
      approvedScope: [], forbiddenScope: [] },
    result: { actionId: "approve", outcome: "approved", selectedOptionIds: ["approve"],
      comment: null, resolvedAt: acceptedAt.toISOString() },
    resolvedByUserId: "board", resolvedAt: acceptedAt,
  });
  // accepted continuation 은 실제 전달 웨이크업을 참조해야 한다(accepted_check 제약).
  //   전달 후 처리까지 끝난 상태(completed = 종말)로 시드한다 — live wakeup 은 활성 실행
  //   차단(contract ②)이 그대로 잡아야 하므로 종말 상태만이 사람 승인 판정의 정당한 동반 상태다.
  await db.insert(agentWakeupRequests).values({
    id: continuationWakeId, companyId: scenario.companyId, agentId: scenario.agentId,
    source: "system", triggerDetail: "system", reason: "operator_decision_continuation",
    payload: { issueId: issue!.id }, status: "completed", requestedAt: acceptedAt,
  });
  await db.insert(operatorDecisionContinuations).values({ companyId: scenario.companyId,
    operatorDecisionId: decisionId, issueId: issue!.id, state: "accepted",
    targetAgentId: scenario.agentId, wakeupRequestId: continuationWakeId,
    idempotencyKey: `rc:${randomUUID()}`, acceptedAt });
  return issue!.id;
}

/** 실패(redo) 스텝에 종말 owner 참조 잔재를 만든다(라이브 3169cbc6/6583e8a0 형상). */
async function seedTerminalOwnerResidue(db: Db, scenario: ResumeApplyScenario) {
  const [wakeup] = await db.insert(agentWakeupRequests).values({
    companyId: scenario.companyId, agentId: scenario.agentId, source: "workflow.dispatch",
    status: "failed", workflowStepRunId: scenario.stepRunIds.redo,
  }).returning();
  const [hb] = await db.insert(heartbeatRuns).values({
    companyId: scenario.companyId, agentId: scenario.agentId, status: "failed",
    startedAt: new Date(NOW.getTime() - 3_600_000), finishedAt: new Date(NOW.getTime() - 3_000_000),
    error: "stream stall", workflowStepRunId: scenario.stepRunIds.redo,
  }).returning();
  await db.update(workflowStepRuns).set({
    dispatchOwnerWakeupRequestId: wakeup!.id, dispatchOwnerHeartbeatRunId: hb!.id,
  }).where(eq(workflowStepRuns.id, scenario.stepRunIds.redo));
  return { wakeupId: wakeup!.id, heartbeatId: hb!.id };
}

describeEP("resume review-relief v1", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-relief-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  afterAll(async () => { if (fixture?.supported) await fixture.cleanup(); });
  afterEach(async () => {
    resetReviewedPolicies();
    await db.delete(instanceSettings);
  });

  function scopeOf(s: ResumeApplyScenario) {
    return { companyId: s.companyId, missionId: s.missionId, workflowRunId: s.runId, startStepId: "gate" };
  }

  async function reliefScenario(prefix: string) {
    const scenario = await seedResumeApplyScenario(db, sql, prefix, {
      missionStatus: "active", runStatus: "failed",
    });
    resetReviewedPolicies(); // policy-missing 형상(라이브 7런과 동일)
    await seedTerminalOwnerResidue(db, scenario);
    return scenario;
  }

  it("flag OFF — blockers/warnings/relief identical to legacy fail-closed behavior", async () => {
    const scenario = await reliefScenario("off-");
    const result = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.relief).toEqual({ active: false, bases: [] });
    expect(result.preview.warnings).toEqual([]);
    const codes = result.preview.blockers.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining([
      "external_effect_unknown", "control_tool_effects_unverified", "active_work",
    ]));
  });

  it("flag ON + human approval — conservative blockers become warnings; resume opens", async () => {
    const scenario = await reliefScenario("on-");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenario, new Date("2026-09-07T10:00:00.000Z"));
    const result = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.token).toBeTruthy();
    expect(result.preview.relief).toEqual({ active: true, bases: ["human_approval"] });
    const warnCodes = result.preview.warnings!.map((w) => w.code);
    expect(warnCodes).toEqual(expect.arrayContaining([
      "external_effect_unknown", "control_tool_effects_unverified", "active_work",
    ]));
    expect(result.preview.blockers).toEqual([]);
    expect(result.preview.preservedStepIds).toEqual(["side"]);
    expect(result.preview.affectedStepIds.sort()).toEqual(["done", "gate", "redo"]);
  });

  it("approval accepted before run failure is not a verdict for this failure", async () => {
    const scenario = await reliefScenario("old-");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenario, new Date("2026-09-01T00:00:00.000Z"));
    const result = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.relief).toEqual({ active: false, bases: [] });
    expect(result.preview.warnings).toEqual([]);
  });

  it("stuck basis alone does NOT relieve effect-unknown steps (contract 1)", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "stuckonly-", { missionStatus: "active", runStatus: "running" });
    resetReviewedPolicies();
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    const [wakeup] = await db.insert(agentWakeupRequests).values({
      companyId: scenario.companyId, agentId: scenario.agentId, source: "workflow.dispatch",
      status: "failed", workflowStepRunId: scenario.stepRunIds.redo,
    }).returning();
    const [hb] = await db.insert(heartbeatRuns).values({
      companyId: scenario.companyId, agentId: scenario.agentId, status: "failed",
      startedAt: new Date(NOW.getTime() - 3_600_000), finishedAt: new Date(NOW.getTime() - 3_000_000),
      workflowStepRunId: scenario.stepRunIds.redo,
    }).returning();
    await db.update(workflowStepRuns).set({
      status: "running", startedAt: new Date(NOW.getTime() - 3_600_000),
      dispatchOwnerWakeupRequestId: wakeup!.id, dispatchOwnerHeartbeatRunId: hb!.id,
    }).where(eq(workflowStepRuns.id, scenario.stepRunIds.redo));
    const result = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.relief).toEqual({ active: true, bases: ["stuck"] });
    // 전역 매니페스트 미등록은 경고로 내려가도 스텝 effect-unknown 은 남는다(사람 승인 없음).
    expect(result.preview.warnings!.map((w) => w.code)).toContain("external_effect_unknown");
    const hardStepUnknown = result.preview.blockers.filter((b) =>
      (b.code === "external_effect_unknown" || b.code === "control_tool_effects_unverified") && b.detail?.stepId);
    expect(hardStepUnknown.length).toBeGreaterThan(0);
  });

  it("live owner refs keep active_work hard even with human approval (contract 2)", async () => {
    const scenario = await reliefScenario("live-");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenario, new Date("2026-09-07T10:00:00.000Z"));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.status, "failed"));
    const result = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.blockers.some((b) => b.code === "active_work")).toBe(true);
  });

  it("apply path accepts the relieved preview — completed side step preserved, affected reset", async () => {
    const scenario = await reliefScenario("apply-");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenario, new Date("2026-09-07T10:00:00.000Z"));
    const preview = await previewResume(db, scopeOf(scenario), applySigner(NOW));
    expect(preview.preview.eligible).toBe(true);
    const view = await applyResume(db, boardActor(scenario.companyId),
      resumeApplyBody(scenario, { token: preview.preview.token! }), applySigner(NOW));
    expect(view).toMatchObject({ workflowRunId: scenario.runId, state: "pending_delivery" });
    const [sideRow] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, scenario.stepRunIds.side));
    expect(sideRow!.status).toBe("completed"); // 완료 스텝 재사용 — 보존
  });
});

describeEP("review-relief — live failed-run shapes (2026-11 7-run census)", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-shape-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  afterAll(async () => { if (fixture?.supported) await fixture.cleanup(); });
  afterEach(async () => {
    resetReviewedPolicies();
    await db.delete(instanceSettings);
  });

  const SHAPE_STEPS = [
    { id: "pred", name: "Completed predecessor", agentId: "", dependencies: [] },
    { id: "s1", name: "Failed step", agentId: "agent-1", dependencies: ["pred"] },
    { id: "s2", name: "Skipped downstream", agentId: "agent-1", dependencies: ["s1"] },
  ];

  function scenarioLike(g: { companyId: string; agentId: string; missionId: string; runId: string }) {
    return { companyId: g.companyId, agentId: g.agentId, missionId: g.missionId,
      stepRunIds: {}, runId: g.runId, workflowId: "", definitionHash: "" } as unknown as ResumeApplyScenario;
  }

  async function setStepStatus(runId: string, stepId: string, status: string) {
    await db.update(workflowStepRuns).set({ status,
      ...(status === "completed" ? { startedAt: RUN_COMPLETED_AT, completedAt: RUN_COMPLETED_AT } : {}),
    }).where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
  }

  /** 완료 선행 + 실패 스텝 + skipped 하류(라이브 73af4266/91a7881d/87b60e20/f08ed7ec 형상). */
  async function seedShape(missionStatus: string) {
    const graph = await seedPreviewGraph(sql, db, { stepsJson: SHAPE_STEPS, runStatus: "failed" });
    await setStepStatus(graph.runId, "pred", "completed");
    await setStepStatus(graph.runId, "s1", "failed");
    if (missionStatus !== "active") {
      await db.update(missions).set({ status: missionStatus }).where(eq(missions.id, graph.missionId));
    }
    return graph;
  }

  it("prefix-completed failed run: missing_evidence relieved → eligible with approval", async () => {
    const graph = await seedShape("active");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenarioLike(graph), new Date("2026-09-07T10:00:00.000Z"));
    // 수정 전 동작(플래그 OFF = 바이트 동등): 전역/스텝 effect-unknown + missing_evidence 로 거부.
    await setReliefFlag(db, {});
    const legacy = await previewResume(db, previewScope(graph, "s1"), applySigner(NOW));
    expect(legacy.preview.eligible).toBe(false);
    expect(legacy.preview.blockers.map((b) => b.code)).toEqual(expect.arrayContaining([
      "external_effect_unknown", "missing_evidence",
    ]));
    // 수정 후(플래그 ON + 사람 승인): 완료 선행 재사용 + 실패 스텝부터 재개.
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    const relieved = await previewResume(db, previewScope(graph, "s1"), applySigner(NOW));
    expect(relieved.preview.eligible).toBe(true);
    expect(relieved.preview.warnings!.map((w) => w.code)).toEqual(expect.arrayContaining([
      "external_effect_unknown", "missing_evidence",
    ]));
    expect(relieved.preview.preservedStepIds).toEqual(["pred"]);
    expect(relieved.preview.affectedStepIds.sort()).toEqual(["s1", "s2"]);
  });

  it("non-reviewable mission status stays blocked even with approval (ee6007ed shape)", async () => {
    const graph = await seedShape("cancelled");
    await setReliefFlag(db, { enableResumeReviewReliefV1: true });
    await seedHumanApproval(db, scenarioLike(graph), new Date("2026-09-07T10:00:00.000Z"));
    const result = await previewResume(db, previewScope(graph, "s1"), applySigner(NOW));
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.blockers.some((b) => b.code === "unsupported_status")).toBe(true);
  });
});

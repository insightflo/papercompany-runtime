// [5207d3bf Stage 1] PLAN-QA PASS 원장이 구 [PLAN] 이슈에 바인딩된 제출과 함께 존재할 때
// 최신 [PLAN] 이슈만 보는 소비자가 no_authorized_decision 으로 스톨되는 문제의 회귀 테스트.
// 1) 게이트 해시 고정 폴백: refs.planQa(pending, hash) 가 가리키는 제출을 구 [PLAN] 이슈에서 소비.
// 2) sweepStalledPlanQaPassRecords: PASS 원장만 남고 noop 으로 멈춘 미션의 자동 회복 + 멱등 + paused 스킵.
// 3) 안전 불변식: refs.planQa 가 없거나 decisionHash 가 불일치하면 여전히 no_authorized_decision.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  assets,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missionDelegations,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missions,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  findLatestAuthorizedMissionOwnerPlanDecision,
  hashOwnerPlanDecision,
  recordLatestAuthorizedMissionOwnerPlanDecision,
  sweepStalledPlanQaPassRecords,
} from "../services/mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PLAN-QA stale planning issue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// recordLatest 가 PLAN-QA manifest 를 StorageService 에 기록하므로 임시 디렉터리로 격리한다.
let planQaStorageRoot: string | null = null;
beforeAll(async () => {
  planQaStorageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-planqa-stale-storage-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", planQaStorageRoot);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (planQaStorageRoot) await rm(planQaStorageRoot, { recursive: true, force: true });
});

function decisionFor(missionId: string, sourceWorkflowId: string, variant: 1 | 2 = 1) {
  return {
    missionId,
    missionGoal: "Ship controlled rollout",
    selectedExecutionUnits: [{
      id: `unit-${variant}`,
      kind: "workflow_definition_step",
      title: variant === 1 ? "Run smoke" : "Run smoke v2",
      reason: "source evidence",
      selectionState: "selected",
      sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" },
    }],
    ruleRefs: ["rule:security"],
    kbRefs: ["kb:rollout"],
    requiredInputs: ["stagingUrl"],
    successCriteria: ["smoke passes"],
    steps: [{ id: "step-1", title: "Verify staging" }],
  };
}

describeEmbeddedPostgres("PLAN-QA pass bound to a stale planning issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planqa-stale-plan-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missionDelegations);
    await db.delete(missionPlanArtifacts);
    await db.delete(missionPlanDecisionSubmissions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(plugins);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(assets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQaFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PlanQA Stale Company", issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
      { id: qaAgentId, companyId, name: "Report Validator", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    ]);
    await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, name: "Plan QA Source Workflow", companyId, stepsJson: [{ id: "scout", name: "Scout", dependencies: [] }] });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plan QA stale planning mission",
      description: "Select an executable plan for the original business request.",
      status: "active",
    });
    // 구 [PLAN] 이슈: createdAt 을 과거로 명시해 최신 이슈와의 순서를 확정한다.
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      title: "Mission owner planning (old)",
      originKind: "mission_main_executor_plan",
      status: "todo",
      createdAt: new Date(Date.now() - 120_000),
    });
    await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId, refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
    return { companyId, ownerAgentId, qaAgentId, missionId, planningIssueId, sourceWorkflowId };
  }

  async function submitDecisionOnPlanningIssue(opts: {
    companyId: string;
    missionId: string;
    planningIssueId: string;
    authorAgentId: string;
    sourceWorkflowId: string;
    variant?: 1 | 2;
    status?: "submitted" | "plan_qa_pending" | "recorded";
  }) {
    const decision = decisionFor(opts.missionId, opts.sourceWorkflowId, opts.variant ?? 1);
    await upsertMissionPlanDecisionSubmission({
      db,
      companyId: opts.companyId,
      missionId: opts.missionId,
      planningIssueId: opts.planningIssueId,
      decision,
      decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      authorAgentId: opts.authorAgentId,
      status: opts.status ?? "submitted",
    });
    return decision;
  }

  async function createNewerPlanningIssue(opts: { companyId: string; missionId: string }) {
    const newerIssueId = randomUUID();
    await db.insert(issues).values({
      id: newerIssueId,
      companyId: opts.companyId,
      missionId: opts.missionId,
      title: "Mission owner planning (newer)",
      originKind: "mission_main_executor_plan",
      status: "todo",
      createdAt: new Date(),
    });
    return newerIssueId;
  }

  async function readActivePlanQa(companyId: string, missionId: string) {
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    const refs = (plan?.refs ?? {}) as Record<string, unknown>;
    return {
      plan,
      planQa: refs.planQa as { issueId?: string; decisionHash?: string; status?: string } | undefined,
      paqoWorkflow: refs.paqoWorkflow as { workflowRunId?: string } | undefined,
    };
  }

  async function recordPassVerdict(companyId: string, missionId: string, qaAgentId: string) {
    const { planQa } = await readActivePlanQa(companyId, missionId);
    if (!planQa?.issueId || !planQa.decisionHash) throw new Error("no active PLAN-QA gate to verdict");
    await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: planQa.issueId,
      decisionHash: planQa.decisionHash,
      verdict: "pass",
      diagnostics: [],
      reviewedBy: { actorType: "agent", actorId: qaAgentId },
    });
  }

  async function countMissionWorkflowRuns(missionId: string) {
    const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    return rows.length;
  }

  async function readLedgerStatus(companyId: string, missionId: string) {
    const [row] = await db
      .select({ status: missionPlanDecisionSubmissions.status })
      .from(missionPlanDecisionSubmissions)
      .where(and(eq(missionPlanDecisionSubmissions.companyId, companyId), eq(missionPlanDecisionSubmissions.missionId, missionId)))
      .orderBy(missionPlanDecisionSubmissions.createdAt);
    return row?.status ?? null;
  }

  // 공통 스톨 시나리오: 구 [PLAN] 이슈에 제출 → 게이트 오픈(pending, hash 고정) → 더 최신 [PLAN] 이슈 등장.
  async function seedStalledThroughGateOpen() {
    const fixture = await seedQaFixture();
    await submitDecisionOnPlanningIssue({
      companyId: fixture.companyId,
      missionId: fixture.missionId,
      planningIssueId: fixture.planningIssueId,
      authorAgentId: fixture.ownerAgentId,
      sourceWorkflowId: fixture.sourceWorkflowId,
      status: "submitted",
    });
    const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(first.status).toBe("plan_qa_pending");
    const { planQa } = await readActivePlanQa(fixture.companyId, fixture.missionId);
    expect(planQa?.status).toBe("pending");
    expect(planQa?.decisionHash).toBeTruthy();
    const newerIssueId = await createNewerPlanningIssue({ companyId: fixture.companyId, missionId: fixture.missionId });
    return { ...fixture, newerIssueId };
  }

  it("consumes the pinned-hash submission on the older [PLAN] issue after PLAN-QA pass", async () => {
    const fixture = await seedStalledThroughGateOpen();
    // 최신 [PLAN] 이슈에는 제출이 없다: 폴백이 구 이슈 바인딩 제출을 그 이슈 ID 로 반환해야 한다.
    const found = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.planningIssueId).toBe(fixture.planningIssueId);
      expect(found.decisionIssueId).toBe(fixture.planningIssueId);
    }

    await recordPassVerdict(fixture.companyId, fixture.missionId, fixture.qaAgentId);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId });
    expect(result.status).toBe("recorded");

    // 제출 원장은 'recorded' 로 전환되고 워크플로 런이 실체화된다.
    expect(await readLedgerStatus(fixture.companyId, fixture.missionId)).toBe("recorded");
    const { planQa, paqoWorkflow } = await readActivePlanQa(fixture.companyId, fixture.missionId);
    expect(planQa?.status).toBe("pass");
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
    expect(await countMissionWorkflowRuns(fixture.missionId)).toBeGreaterThan(0);
    setWorkflowToolStepExecutor(null);
  });

  it("sweepStalledPlanQaPassRecords recovers a stalled PASS once and stays idempotent; paused missions are skipped", async () => {
    const stalled = await seedStalledThroughGateOpen();
    await recordPassVerdict(stalled.companyId, stalled.missionId, stalled.qaAgentId);
    // 과거 소비자가 noop 으로 끝난 상태: PASS 원장만 있고 소비는 일어나지 않았다.
    expect(await countMissionWorkflowRuns(stalled.missionId)).toBe(0);

    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const firstSweep = await sweepStalledPlanQaPassRecords(db);
    expect(firstSweep.stalled).toBe(1);
    expect(firstSweep.recovered).toBe(1);
    expect(firstSweep.failures).toEqual([]);

    const { planQa, paqoWorkflow } = await readActivePlanQa(stalled.companyId, stalled.missionId);
    expect(planQa?.status).toBe("pass");
    expect(paqoWorkflow?.workflowRunId).toBeTruthy();
    expect(await readLedgerStatus(stalled.companyId, stalled.missionId)).toBe("recorded");
    const runsAfterFirst = await countMissionWorkflowRuns(stalled.missionId);
    expect(runsAfterFirst).toBeGreaterThan(0);

    // 2회차 실행은 멱등해야 한다: 새 스톨 없음, 중복 런 미생성.
    const secondSweep = await sweepStalledPlanQaPassRecords(db);
    expect(secondSweep.stalled).toBe(0);
    expect(secondSweep.recovered).toBe(0);
    expect(await countMissionWorkflowRuns(stalled.missionId)).toBe(runsAfterFirst);

    // paused 미션은 실행 차단 상태이므로 스킵된다.
    const paused = await seedStalledThroughGateOpen();
    await recordPassVerdict(paused.companyId, paused.missionId, paused.qaAgentId);
    await db.update(missions).set({ status: "paused" }).where(eq(missions.id, paused.missionId));
    const pausedSweep = await sweepStalledPlanQaPassRecords(db);
    expect(pausedSweep.stalled).toBe(0);
    expect(pausedSweep.recovered).toBe(0);
    const pausedState = await readActivePlanQa(paused.companyId, paused.missionId);
    expect(pausedState.planQa?.status).toBe("pending");
    expect(pausedState.paqoWorkflow?.workflowRunId).toBeUndefined();
    expect(await countMissionWorkflowRuns(paused.missionId)).toBe(0);
    setWorkflowToolStepExecutor(null);
  });

  it("still returns no_authorized_decision without a pending refs.planQa pin or on decisionHash mismatch", async () => {
    // (i) refs.planQa 가 없는 상태: 게이트가 열린 적 없으면 구 [PLAN] 제출은 재생되지 않는다.
    const unpinned = await seedQaFixture();
    await submitDecisionOnPlanningIssue({
      companyId: unpinned.companyId,
      missionId: unpinned.missionId,
      planningIssueId: unpinned.planningIssueId,
      authorAgentId: unpinned.ownerAgentId,
      sourceWorkflowId: unpinned.sourceWorkflowId,
      status: "submitted",
    });
    await createNewerPlanningIssue({ companyId: unpinned.companyId, missionId: unpinned.missionId });
    const unpinnedResult = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: unpinned.companyId, missionId: unpinned.missionId });
    expect(unpinnedResult.status).toBe("noop");
    if (unpinnedResult.status === "noop") expect(unpinnedResult.reason).toBe("no_authorized_decision");

    // (ii) decisionHash 불일치: 고정된 게이트 해시와 다른 제출만 남아 있으면 폴백도 선택하지 않는다.
    const mismatched = await seedStalledThroughGateOpen();
    const { planQa } = await readActivePlanQa(mismatched.companyId, mismatched.missionId);
    expect(planQa?.decisionHash).toBeTruthy();
    // 고정 해시 원본 제출을 원장에서 제거하고, 다른 해시의 제출만 남긴다.
    await db
      .delete(missionPlanDecisionSubmissions)
      .where(and(eq(missionPlanDecisionSubmissions.companyId, mismatched.companyId), eq(missionPlanDecisionSubmissions.missionId, mismatched.missionId)));
    await submitDecisionOnPlanningIssue({
      companyId: mismatched.companyId,
      missionId: mismatched.missionId,
      planningIssueId: mismatched.planningIssueId,
      authorAgentId: mismatched.ownerAgentId,
      sourceWorkflowId: mismatched.sourceWorkflowId,
      variant: 2,
      status: "submitted",
    });
    const found = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: mismatched.companyId, missionId: mismatched.missionId });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe("no_authorized_decision");
    const mismatchedResult = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: mismatched.companyId, missionId: mismatched.missionId });
    expect(mismatchedResult.status).toBe("noop");
    if (mismatchedResult.status === "noop") expect(mismatchedResult.reason).toBe("no_authorized_decision");
    // 낡은 결정 재생 금지: 게이트는 여전히 pending 이고 워크플로 런은 만들어지지 않는다.
    const afterMismatch = await readActivePlanQa(mismatched.companyId, mismatched.missionId);
    expect(afterMismatch.planQa?.status).toBe("pending");
    expect(afterMismatch.paqoWorkflow?.workflowRunId).toBeUndefined();
    expect(await countMissionWorkflowRuns(mismatched.missionId)).toBe(0);
  });
});

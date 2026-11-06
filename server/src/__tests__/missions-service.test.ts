import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  assets,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missions,
  pluginEntities,
  plugins,
  qualityReviewItems,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionPluginManifest } from "./helpers/mission-service-fixtures.js";
import { cleanMissionServiceFixture } from "./helpers/mission-service-cleanup-fixture.js";
import { registerMissionOwnerCreationCase } from "./helpers/mission-owner-creation-case.js";
import { registerMissionDelegationCases } from "./helpers/mission-service-delegation-cases.js";
import { registerMissionPlanningCases } from "./helpers/mission-service-planning-cases.js";
import { registerMissionSourceCases } from "./helpers/mission-service-source-cases.js";
import { registerMissionUnblockCases } from "./helpers/mission-service-unblock-cases.js";
import { registerMissionListingCases } from "./helpers/mission-service-listing-cases.js";
import { registerMissionIssueTreeCases } from "./helpers/mission-service-issue-tree-cases.js";
import { registerMissionWorkflowRunCases } from "./helpers/mission-service-workflow-run-cases.js";
import { registerMissionOversightCompletionCases } from "./helpers/mission-service-oversight-completion-cases.js";
import { registerMissionReopenCases } from "./helpers/mission-service-mission-reopen-cases.js";
import { registerMissionLegacyPluginCases } from "./helpers/mission-service-legacy-plugin-cases.js";
import { registerMissionLegacyPlanningCases } from "./helpers/mission-service-legacy-planning-cases.js";
import { registerMissionCancelledMissionCases } from "./helpers/mission-service-cancelled-mission-cases.js";
import { registerMissionDecisionGuardCases } from "./helpers/mission-service-decision-guard-cases.js";
import { registerMissionRetryApplyCases } from "./helpers/mission-service-retry-apply-cases.js";
import { registerMissionRetryDispatchCases } from "./helpers/mission-service-retry-dispatch-cases.js";
import { registerMissionRetryContextCases } from "./helpers/mission-service-retry-context-cases.js";
import { registerMissionPluginSubstrateCases } from "./helpers/mission-service-plugin-substrate-cases.js";
import { registerMissionStalePluginEscalationCases } from "./helpers/mission-service-stale-plugin-escalation-cases.js";
import { registerMissionToolRecoveryCases } from "./helpers/mission-service-tool-recovery-cases.js";
import { registerMissionToolRecoveryClassificationCases } from "./helpers/mission-service-tool-recovery-classification-cases.js";
import { createMissionOwnerDecisionFixture } from "./helpers/mission-owner-decision-fixture.js";
import { extractMissionOwnerDecisionFromText, missionService } from "../services/missions.js";
import { buildQaReworkCapDescription } from "../services/missions/qa-rework-cap-oversight.js";
import { loadConsecutiveQaRejectTrend } from "../services/missions/qa-rework-cap-oversight-detection.js";
import { issueService } from "../services/issues.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { hashOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// [T7 격리] supervision materialize 경로의 recordLatest 가 PLAN-QA manifest 를 StorageService 에
// 기록하므로 기본 인스턴스 storage(~/.paperclip) 대신 suite 전용 임시 디렉터리로 돌린다.
let planQaStorageRoot: string | null = null;
beforeAll(async () => {
  planQaStorageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-msvc-storage-"));
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", planQaStorageRoot);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (planQaStorageRoot) await rm(planQaStorageRoot, { recursive: true, force: true });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("mission owner decision parser", () => {
  it("extracts the latest valid mission owner decision block", () => {
    expect(extractMissionOwnerDecisionFromText([
      "### Mission owner decision",
      "Decision: request_input",
      "Source issue: old-source",
      "Reason: old reason",
      "",
      "### Mission owner decision",
      "Decision: retry_source_issue",
      "Source issue: BM123-1",
      "Reason: Source executor confirmed the transient failure is gone.",
      "Next action: Re-dispatch source issue after approval.",
      "Evidence: Owner reviewed the blocked issue comment.",
    ].join("\n"))).toEqual({
      decision: "retry_source_issue",
      sourceIssueRef: "BM123-1",
      reason: "Source executor confirmed the transient failure is gone.",
      nextAction: "Re-dispatch source issue after approval.",
      evidence: "Owner reviewed the blocked issue comment.",
    });
  });

  it("returns a conservative invalid decision signal for unknown decisions", () => {
    expect(extractMissionOwnerDecisionFromText([
      "### Mission owner decision",
      "Decision: auto_fix_everything",
      "Source issue: BM123-1",
      "Reason: Too broad.",
    ].join("\n"))).toEqual({
      decision: null,
      invalidDecision: "auto_fix_everything",
      sourceIssueRef: "BM123-1",
      reason: "Too broad.",
      nextAction: undefined,
      evidence: undefined,
    });
  });

});

describeEmbeddedPostgres("mission service mission-linked subresources", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-missions-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await cleanMissionServiceFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const recordOwnerDecision = createMissionOwnerDecisionFixture(() => db);

  registerMissionOwnerCreationCase(() => db);

  registerMissionDelegationCases(() => db);
  registerMissionPlanningCases(() => db);
  registerMissionSourceCases(() => db);
  registerMissionUnblockCases(() => db);

  registerMissionDecisionGuardCases(() => db);
  registerMissionRetryApplyCases(() => db);
  registerMissionRetryDispatchCases(() => db);
  registerMissionRetryContextCases(() => db);

  it("active supervision escalates a stale todo mission source when no issue is actually running", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "No Active Todo Escalation Company", issuePrefix: `NA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "No active todo escalation mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "No Active Todo Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source with no running execution" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_todo_no_active_execution"),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({ missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }));
    expect(ownerActions[0]?.description).toContain("no queued/running heartbeat run is active");
    expect(ownerActions[0]?.description).toContain("retry_source_issue");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("active supervision materializes an unrecorded PLAN decision into a PAQO workflow", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Plan Materialization Recovery Company", issuePrefix: `PM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "running", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan materialization recovery mission", status: "active" });
    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Plan Materialization Recovery Workflow" } });
    const [planningIssue] = await db.insert(issues).values({
      companyId,
      assigneeAgentId: ownerAgentId,
      missionId,
      originKind: "mission_main_executor_plan",
      status: "done",
      title: "[PLAN] Plan materialization recovery mission",
    }).returning();
    // Structured authority only: seed the dedicated submission ledger without materializing.
    // Natural-language plan-decision comments are display-only and are never execution authority.
    const decision = {
      missionId,
      missionGoal: "Recover missing PAQO materialization",
      selectedExecutionUnits: [{
        id: "unit-recover",
        kind: "mission_plan_unit",
        title: "[ACTION] Recover execution",
        assigneeAgentId: workerAgentId,
        selectionState: "selected",
        sourceRef: { type: "mission_plan_unit", id: "unit-recover" },
        dependsOn: [],
      }],
      requiredInputs: [],
      successCriteria: ["workflow materialized"],
      steps: [],
    };
    await upsertMissionPlanDecisionSubmission({
      db,
      companyId,
      missionId,
      planningIssueId: planningIssue!.id,
      authorAgentId: ownerAgentId,
      sourceCommentId: null,
      decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      decision,
      status: "submitted",
    });

    const result = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:10:00.000Z"),
      applySafeActions: true,
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_decision_not_materialized"),
    ]));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "materialize_plan_decision", missionId, resultStatus: "plan_qa_pending" }),
    ]));
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId))).toHaveLength(0);

    const [activePlan] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .then((plans) => plans.filter((plan) => plan.status === "active"));
    const planQa = (activePlan?.refs as Record<string, unknown> | undefined)?.planQa as { issueId?: string; status?: string; decisionHash?: string } | undefined;
    expect(planQa).toMatchObject({ issueId: expect.any(String), status: "pending" });
    // Structured PLAN-QA PASS (comment PASS text is not authority).
    await recordMissionPlanQaVerdict({
      db,
      companyId,
      missionId,
      planQaIssueId: planQa!.issueId!,
      decisionHash: planQa!.decisionHash ?? hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
      verdict: "pass",
      reviewedBy: { actorType: "user", actorId: "board-user-test" },
    });

    const approved = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:12:00.000Z"),
      applySafeActions: true,
    });
    expect(approved.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "materialize_plan_decision", missionId, resultStatus: "recorded" }),
    ]));
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(runs).toEqual([expect.objectContaining({ status: "running" })]);

    const followUp = await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(followUp.findings.join("\n")).not.toContain("plan_gate_not_ready");
    expect(followUp.findings.join("\n")).not.toContain("plan_outdated");
  });

  it("active supervision reopens a completed PLAN issue when the planning run succeeded without a structured submission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Planning Submission Missing Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning submission missing mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "PS-PLAN",
        title: "[PLAN] Planning submission missing mission",
        status: "done",
        completedAt: new Date("2026-06-28T03:11:09.147Z"),
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "PS-OVERSIGHT",
        title: "[OVERSIGHT] Planning submission missing mission",
        status: "todo",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-06-28T03:06:44.526Z"),
      finishedAt: new Date("2026-06-28T03:11:09.108Z"),
      createdAt: new Date("2026-06-28T03:06:44.502Z"),
    });
    await db.update(issues).set({
      checkoutRunId: succeededRunId,
      executionRunId: succeededRunId,
      executionAgentNameKey: "mission-owner",
      executionLockedAt: new Date("2026-06-28T03:06:44.526Z"),
    }).where(eq(issues.id, planIssueId));

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("plan_submission_missing"),
    ]));

    // Phase 5 connection: the oversight stall must auto-create a company-scoped quality review item.
    const oversightQualityItems = await db
      .select()
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.missionId, missionId));
    expect(oversightQualityItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        missionId,
        triggerSource: "oversight_stall",
        targetType: "mission_output",
        failureType: "plan_submission_missing",
      }),
    ]));
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_missing", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_missing",
        planIssueId,
        succeededRunId,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const [storedPlanIssue] = await db.select().from(issues).where(eq(issues.id, planIssueId));
    expect(storedPlanIssue).toEqual(expect.objectContaining({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
    }));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission required"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: `mission-owner-plan-submission-missing:${missionId}:${planIssueId}:${succeededRunId}`,
      wakeCommentId: expect.any(String),
    }));

    await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });
    expect(onPlanSubmissionMissing).toHaveBeenCalledTimes(1);
  });

  it("active supervision reopens PLAN with rejected submission reason instead of missing-submission wording", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const planQaIssueId = randomUUID();
    const oversightIssueId = randomUUID();
    const succeededRunId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const decisionHash = "rejected-decision-hash";
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Rejected Submission Company",
      issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Rejected submission mission",
      status: "planning",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        identifier: "RS-PLAN",
        title: "[PLAN] Rejected submission mission",
        status: "done",
        completedAt: new Date("2026-07-04T03:11:09.147Z"),
      },
      {
        id: planQaIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_plan_qa",
        identifier: "RS-QA",
        title: "[QA] Rejected submission mission plan",
        status: "done",
      },
      {
        id: oversightIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        identifier: "RS-OVERSIGHT",
        title: "[OVERSIGHT] Rejected submission mission",
        status: "todo",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: planIssueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-07-04T03:06:44.526Z"),
      finishedAt: new Date("2026-07-04T03:11:09.108Z"),
      createdAt: new Date("2026-07-04T03:06:44.502Z"),
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "rejected-submission-workflow",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-07-04T03:12:00.000Z"),
    });
    await db.insert(missionPlanDecisionSubmissions).values({
      companyId,
      missionId,
      planningIssueId: planIssueId,
      authorAgentId: ownerAgentId,
      sourceRunId: succeededRunId,
      decisionHash,
      decision: { selectedExecutionUnits: [] },
      status: "rejected",
      rejectionReason: "invalid_selected_execution_unit_source_ref",
      diagnostics: [{ code: "workflow_definition_not_found", message: "Workflow definition missing" }],
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-04T03:14:00.000Z"),
      applySafeActions: true,
    });

    expect(result.missionIds).toContain(missionId);
    const missionResult = result.missions.find((entry) => entry.missionId === missionId);
    expect(missionResult?.findings.join("\n")).toContain("plan_submission_rejected");
    expect(missionResult?.findings.join("\n")).not.toContain("plan_submission_missing");
    expect(missionResult?.findings.join("\n")).toContain("workflow_definition_not_found");
    expect(missionResult?.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan_submission_rejected", issueId: planIssueId, safeToAutoApply: true }),
    ]));
    expect(missionResult?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "plan_submission_rejected",
        planIssueId,
        decisionHash,
        resultStatus: "wakeup_requested",
      }),
    ]));

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planIssueId));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Mission owner plan submission rejected"),
      }),
    ]));
    expect(comments.some((comment) => comment.body.includes(`mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-`))).toBe(true);
    expect(onPlanSubmissionMissing).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      planIssueId,
      targetAgentId: ownerAgentId,
      idempotencyKey: expect.stringMatching(new RegExp(`^mission-owner-plan-submission-rejected:${missionId}:${planIssueId}:prompt-v2:roster-[a-f0-9]{12}$`)),
      wakeCommentId: expect.any(String),
    }));
  });

  it("does not treat a reusable workflow mission without a PLAN issue as missing plan submission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onPlanSubmissionMissing = vi.fn();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Mission Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Reusable workflow mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Reusable Workflow",
      stepsJson: [{ id: "run", name: "Run", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "manual",
      status: "completed",
      completedAt: new Date("2026-06-28T03:10:00.000Z"),
    });

    const result = await missionService(db, { onPlanSubmissionMissing }).runActiveMissionOwnerSupervision({
      companyId,
      missionIds: [missionId],
      staleAfterMinutes: 1,
      now: new Date("2026-06-28T03:15:00.000Z"),
      applySafeActions: true,
    });

    // [settlement contract] 실행이 완료된 재사용 워크플로 미션은 이제 정리(settle) 대상이다:
    //   선택되어 mission 이 completed 로 수렴하지만, plan 이슈 생성/누락 취급은 여전히 하지 않는다.
    expect(result.missionIds).toContain(missionId);
    expect(onPlanSubmissionMissing).not.toHaveBeenCalled();
    const planIssues = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_plan"));
    expect(planIssues).toHaveLength(0);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settleActions = result.missions[0]?.appliedActions.filter((action) => action.type === "mission_settled_from_workflow_runs") ?? [];
    expect(settleActions).toHaveLength(1);
  });

  it("re-wakes an existing stale owner-action issue with no heartbeat instead of duplicating it", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action No Run Company", issuePrefix: `ON${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action no-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action No Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action with no heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_no_execution"),
      expect.stringContaining(ownerAction.identifier ?? ownerAction.id),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "blocked" }),
    }));
  });

  it("re-wakes an existing stale owner-action issue after a failed heartbeat run", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action Failed Run Company", issuePrefix: `OF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action failed-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action Failed Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action after failed heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: ownerAction.id,
      status: "failed",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      error: "Process lost",
      errorCode: "process_lost",
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_after_failed_run"),
      expect.stringContaining(failedRunId),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("keeps unblock owner actions flat when the source issue is already nested", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Nested Source Unblock Company", issuePrefix: `NS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Nested source unblock mission", status: "active" });

    const parentIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Parent source" });
    const nestedSource = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, parentId: parentIssue.id, originKind: "manual", status: "blocked", title: "Nested source" });

    const ownerAction = await missionService(db).ensureMainExecutorUnblockIssue(
      (await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]!)),
      nestedSource,
    );

    expect(ownerAction).toEqual(expect.objectContaining({
      originKind: "mission_main_executor_unblock",
      originId: nestedSource.id,
      parentId: null,
    }));
  });

  it("does not classify a zero exit code heartbeat as failed stale queue evidence", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Zero Exit Queue Company", issuePrefix: `ZE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Zero exit stale queue mission", status: "active" });
    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Zero Exit Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source after clean exit" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "succeeded",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      exitCode: 0,
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    expect(findings).not.toContain("stale_todo_after_failed_run");
    expect(findings).toContain("stale_todo_no_active_execution");
  });

  it("active supervision escalates a stale todo source after timed_out execution", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Timed Out Todo Escalation Company", issuePrefix: `TT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Timed out todo escalation mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Timed out todo source" });
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_todo_after_failed_run"),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({ missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }));
    expect(ownerActions[0]?.description).toContain("timed_out");
    expect(ownerActions[0]?.description).toContain(timedOutRunId);
    expect(ownerActions[0]?.description).toContain("retry_source_issue");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("treats a todo source with a pending queued execution-request as waiting, not stale (Phase 1.5)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Queue Wait Company", issuePrefix: `QW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Queue wait mission", status: "active" });
    const svc = missionService(db);
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source with pending queue request" });
    // 옛날 createdAt → ageMs 가 staleAfter(1min) 를 넘게(10min).
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    // pending execution-request (wakeup queue): status=queued, runId=null, payload.issueId=source.
    // requestedAt 를 now 기준 2min 전으로 → TTL(staleAfter*4=4min) 이내 → 대기 상태.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: workerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: sourceIssue.id },
      status: "queued",
      runId: null,
      requestedAt: new Date("2026-06-02T00:08:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    // [AREA: wakeup queue / Phase 1.5] pending queue request 가 있으므로 대기로 해석, stale 오판 방지.
    expect(findings).toContain("queued_waiting_for_execution");
    expect(findings).not.toContain("stale_todo_no_active_execution");
  });

  it("does not directly wake a stale in_progress source after terminal heartbeat execution without diagnosis", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-in-progress", runId: "run-in-progress" });

    await db.insert(companies).values({ id: companyId, name: "Stale In Progress Wake Company", issuePrefix: `IP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stale in-progress wake mission", status: "active" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "in_progress", title: "In-progress source after timed out run" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
      errorCode: "timeout",
    });

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:45:00.000Z"),
      dispatchStaleSourceIssueWakeups: true,
    });
    const idempotencyKey = `mission-stale-source-wakeup:${missionId}:${sourceIssue.id}:${timedOutRunId}`;

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_after_failed_run"),
      expect.stringContaining(timedOutRunId),
      expect.stringContaining("diagnosed_only"),
      expect.stringContaining("stale_source_wakeup_requires_diagnosis"),
    ]));
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
    expect(result.missions[0]?.appliedActions).toEqual([]);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).not.toContain("### Mission supervision stale source wakeup dispatched");
    expect(sourceBody).not.toContain(idempotencyKey);
  });

  it("dispatches explicit retry_source_issue wakeup for a stale todo source after failed execution", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-todo", runId: "run-todo" });

    await db.insert(companies).values({ id: companyId, name: "Wake Todo Retry Company", issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake stale todo retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Stale todo wake source" });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-05-31T00:00:00.000Z"),
      finishedAt: new Date("2026-05-31T00:15:00.000Z"),
      errorCode: "timeout",
    });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry stale todo source" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry stale todo after failed execution"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry stale todo after failed execution",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, ownerAction.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, assigneeAgentId: workerAgentId, status: "todo" }),
      targetAgentId: workerAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, resultStatus: "todo", wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("dispatches a workProduct-reuse wake when a blocked producer has no workProduct, a stalled recovery, and the artifact file exists", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse", runId: "run-reuse" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Company", issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });

    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer (no workProduct)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });

    // recovery (unblock) issue for the source whose heartbeat run timed out (RES-350 scenario)
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });

    // expected artifact file already exists under the step output dir (registration is the only gap)
    const stepOutputDir = path.join(workProductRoot, "missions", missionId, "runs", workflowRunId, "steps", stepId);
    const artifactPath = path.join(stepOutputDir, "index.html");
    mkdirSync(stepOutputDir, { recursive: true });
    writeFileSync(artifactPath, "<html>report</html>");
    // (no issueWorkProducts inserted for the source -> listForIssue is empty)

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });
    const idempotencyKey = `mission-workproduct-reuse-wakeup:${missionId}:${sourceIssue.id}:${artifactPath}`;

    expect(result.missionIds).toContain(missionId);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: producerAgentId,
      artifactPath,
      stalledRecoveryIssueId: recoveryIssue.id,
      idempotencyKey,
    }));
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workproduct_reuse_wakeup", sourceIssueId: sourceIssue.id, artifactPath, idempotencyKey }),
    ]));
    const sourceCommentRows = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceCommentRows.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("workProduct-reuse wakeup dispatched");
    expect(sourceBody).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(sourceBody).toContain("This is the only registration authority.");
    expect(sourceBody).toContain(artifactPath);
    expect(sourceBody).toContain("or an `[ARTIFACT]` marker to register");
    expect(sourceBody).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(sourceBody).not.toContain(`[ARTIFACT]: ${artifactPath}`);
    expect(sourceBody).toContain(idempotencyKey);
    const reuseEvents = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.idempotencyKey, idempotencyKey));
    expect(reuseEvents).toHaveLength(1);

    // idempotent: a second sweep must NOT dispatch another reuse wake
    await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:05:00.000Z") });
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);

    rmSync(workProductRoot, { recursive: true, force: true });
  });

  it("does not dispatch a workProduct-reuse wake when the artifact file is absent (no fake success)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse-2", runId: "run-reuse-2" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-noop-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Noop Company", issuePrefix: `WN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse noop mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow Noop", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer noop (no workProduct, no file)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer noop" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });
    // intentionally DO NOT create the artifact file -> wake must not fire

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });

    expect(onWorkProductReuseWakeRequested).not.toHaveBeenCalled();
    expect((result.missions[0]?.appliedActions ?? []).filter((action) => action.type === "workproduct_reuse_wakeup")).toEqual([]);

    rmSync(workProductRoot, { recursive: true, force: true });
  });

  it("dispatches a retry_source_issue wakeup when an earlier apply marker exists without a dispatch marker", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-late" });
    await db.insert(companies).values({ id: companyId, name: "Late Wake Dispatch Company", issuePrefix: `LW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Late wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Previously applied source" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry applied without dispatch" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry once then dispatch later"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry once then dispatch later",
      },
    });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false });
    expect(first.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "not_requested" }),
    ]));
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T02:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, ownerAction.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: workerAgentId, idempotencyKey }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });

  it("re-wakes a half-applied validator retry after a completed child correction and carries repair evidence into the wake comment", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();
    const correctedPngPath = "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260602-techcrunch-ai-knowledge-comic.png";
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-validator" });
    await db.insert(companies).values({ id: companyId, name: "Validator Child Correction Company", issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: validatorAgentId, companyId, name: "Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Validator retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: validatorAgentId, createdByUserId: "test-operator", missionId, originKind: "workflow_execution", status: "todo", title: "RES-132 validator retry source" });
    await db.insert(heartbeatRuns).values({ id: succeededRunId, companyId, agentId: validatorAgentId, issueId: sourceIssue.id, status: "succeeded", startedAt: new Date("2026-06-02T08:00:00.000Z"), finishedAt: new Date("2026-06-02T08:10:00.000Z"), exitCode: 0 });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry validator after corrected PNG" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: corrected child PNG is ready; run validator again"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "corrected child PNG is ready; run validator again",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_apply",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:apply`,
      payload: { sourceIssueId: sourceIssue.id },
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceIssue.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner retry applied",
        `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: sourceIssue.id, decision: "retry_source_issue" })} -->`,
        "Action: earlier supervision applied the owner retry but did not dispatch a wakeup.",
      ].join("\n"),
    });
    const childCorrection = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, parentId: sourceIssue.id, originKind: "mission_repair_child", status: "done", title: "RES-152 corrected PNG ready" });
    await db.insert(issueComments).values({ companyId, issueId: childCorrection.id, authorAgentId: ownerAgentId, body: [
      "### Corrected validation artifact",
      `Corrected PNG path: ${correctedPngPath}`,
      "RES-148 repair spec: Recheck the original repair spec before deciding PASS.",
      "Existing REQUEST_CHANGES objection panel 3: verify the panel 3 objection is resolved.",
      "Existing REQUEST_CHANGES objection panel 5: verify the panel 5 objection is resolved.",
      "Gate: return only PASS or REQUEST_CHANGES; do not edit the artifact.",
      "Telegram/send is forbidden before PASS.",
    ].join("\n") });

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-06-02T08:40:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: validatorAgentId,
      idempotencyKey,
      decisionCommentId: expect.any(String),
    }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("### Validator retry evidence");
    expect(sourceBody).toContain(correctedPngPath);
    expect(sourceBody).toContain("RES-148 repair spec");
    expect(sourceBody).toContain("panel 3");
    expect(sourceBody).toContain("panel 5");
    expect(sourceBody).toContain("PASS or REQUEST_CHANGES");
    expect(sourceBody).toContain("Telegram/send is forbidden before PASS");
    expect(sourceBody).not.toContain("Direct modification");
  });

  it("does not apply or dispatch the same retry_source_issue owner decision twice", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1" });
    await db.insert(companies).values({ id: companyId, name: "Retry Idempotent Company", issuePrefix: `RI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Idempotent retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry once"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry once",
      },
    });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.appliedActions).toHaveLength(1);
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });

  it("reuses the canonical owner anchor when an already-applied producer retry leaves the gate blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Retry Unresolved Company", issuePrefix: `RU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry unresolved mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "retry-unresolved-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });

    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: ownerAction.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner decision",
          "Decision: retry_source_issue",
          `Source issue: ${qaIssue.identifier}`,
          `Rework target: ${producerIssue.identifier}`,
          "Reason: producer must provide signal-analysis evidence before QA can complete.",
        ].join("\n"),
      },
      {
        companyId,
        issueId: producerIssue.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner retry applied",
          `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: producerIssue.id, decision: "retry_source_issue" })} -->`,
          "Action: retry_source_issue already reopened this producer once.",
        ].join("\n"),
      },
    ]);
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: qaIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: qaIssue.identifier ?? qaIssue.id,
        reworkTargetRef: producerIssue.identifier ?? producerIssue.id,
        reason: "producer must provide signal-analysis evidence before QA can complete.",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_wakeup",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`,
      toStatus: "dispatched",
      payload: { sourceIssueId: producerIssue.id },
    });

    const svc = missionService(db, { onOwnerActionCreated });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(result.findings.join("\n")).toContain("owner_action_retry_unresolved_escalated");
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: qaIssue.id, safeToAutoApply: false }),
      expect.objectContaining({ type: "escalate_blocked", issueId: ownerAction.id, safeToAutoApply: false }),
    ]));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_unresolved",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        blockedIssueId: qaIssue.id,
        resultStatus: "todo",
        wakeupDispatchStatus: "not_requested",
      }),
    ]));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    const successor = onOwnerActionCreated.mock.calls[0]![0].issue;
    expect(successor.id).not.toBe(ownerAction.id);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: qaIssue.id }), reason: "mission_unblock_action_created",
    }));
    await expect(db.select().from(issues).where(eq(issues.id, ownerAction.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done", completedAt: new Date("2026-07-06T07:36:00.000Z") }));
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(db.select().from(issues).where(eq(issues.id, qaIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked" }));
    const ownerActionBody = await db.select().from(issueComments).where(eq(issueComments.issueId, successor.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(ownerActionBody).toContain("mission-owner-retry-unresolved");
    expect(ownerActionBody).toContain("Required next decision");
    expect(await db.select().from(issues).where(and(eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, qaIssue.id), eq(issues.status, "todo")))).toEqual([expect.objectContaining({ id: successor.id })]);
    onOwnerActionCreated.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:01:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).toContain("owner_action_retry_unresolved_already_escalated");
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
    const ownerActionBodies = await db.select().from(issueComments).where(eq(issueComments.issueId, successor.id));
    expect(ownerActionBodies.filter((row) => row.body.includes("mission-owner-retry-unresolved"))).toHaveLength(1);
  });

  it("settles an orphaned active mission whose run completed and only the oversight issue remains open", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");

    await db.insert(companies).values({ id: companyId, name: "Settlement Orphan Company", issuePrefix: `SO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settlement orphan mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "settle-orphan",
      stepsJson: [
        { id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    const oversightIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settle-orphan" });

    const svc = missionService(db, {});
    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-08-15T14:50:00.000Z"),
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    // 선택: 실행은 완료됐지만 oversight 만 열려 있으면 settlement 후보로 감독 스윕에 들어와야 한다.
    expect(result.missionIds).toContain(missionId);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settledOversight = await db.select().from(issues).where(eq(issues.id, oversightIssue.id)).then((rows) => rows[0]);
    expect(settledOversight?.status).toBe("done");
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mission_settled_from_workflow_runs", missionId, resultStatus: "completed" }),
    ]));
  });

  it("requests mission closeout once when a terminal workflow run leaves the mission active (closeout bridge)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");
    const onMissionTerminalRunCloseoutWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Closeout Bridge Company", issuePrefix: `CB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Closeout bridge mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "closeout-bridge",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] closeout-bridge" });
    // 열린 비-oversight 이슈 → settlement 차단(종결 브리지가 대신 발동해야 하는 상황).
    await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "todo", title: "Residual open work" });
    // plan 은 아직 running → rule_mismatch + terminal run → closeout bridge.
    await db.insert(missionPlanArtifacts).values({
      companyId, missionId, revision: 1, status: "active", ownerAgentId,
      missionGoal: "Closeout bridge plan", refs: { executionUnits: [{ sourceRef: { type: "native_workflow_run", id: workflowRunId }, status: "running" }] },
      assumptions: [], requiredInputs: [], successCriteria: [], risks: [], steps: [],
    });

    const svc = missionService(db, { onMissionTerminalRunCloseoutWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:50:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain(`rule_mismatch: plan unit=native_workflow_run:${workflowRunId} status=running runtime_status=completed`);
    expect(first.findings.join("\n")).toContain(`workflow_run_terminal_closeout_wake_requested: run=${workflowRunId} status=completed`);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: workflowRunId, status: "completed" },
      planUnitKey: `native_workflow_run:${workflowRunId}`,
    }));
    // mission 은 여전히 active(열린 owner work) — 종결은 오너 몫.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "active" }));

    // 멱등: 두 번째 스윕에는 재발사하지 않는다(마커 클레임).
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:55:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("workflow_run_terminal_closeout_wake_requested");
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
  });

  it("re-wakes the owner once when a recorded retry decision keeps failing to dispatch (dispatch-stall escalation)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    // 재발사가 계속 not_requested 로 실패하는 상황(원 사고: 6시간 무응답).
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "not_requested", reason: "cap_override_no_marker" });
    const onOwnerDecisionDispatchStalledWakeRequested = vi.fn().mockResolvedValue(undefined);

    await db.insert(companies).values({ id: companyId, name: "Stalled Escalation Company", issuePrefix: `SE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stalled escalation mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "stalled-escalation-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values({
      companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${qaIssue.identifier}`, `Rework target: ${producerIssue.identifier}`, "Reason: producer must fix the artifact."].join("\n"),
    });
    await recordOwnerDecision({
      companyId, missionId, ownerActionIssueId: ownerAction.id, ownerAgentId, sourceIssueId: qaIssue.id,
      submission: { decision: "retry_source_issue", sourceIssueRef: qaIssue.identifier ?? qaIssue.id, reworkTargetRef: producerIssue.identifier ?? producerIssue.id, reason: "producer must fix the artifact." },
    });
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    await db.insert(workflowTransitionEvents).values([
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_apply", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: `${wakeupKey}:apply`, toStatus: "done", payload: { sourceIssueId: producerIssue.id } },
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_wakeup", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: wakeupKey, toStatus: "not_requested", payload: { sourceIssueId: producerIssue.id } },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied, onOwnerDecisionDispatchStalledWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain("owner_action_retry_wakeup_stalled");
    expect(first.findings.join("\n")).toContain("owner_decision_dispatch_stalled_wake_requested");
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id }),
      sourceIssue: expect.objectContaining({ id: producerIssue.id }),
      dispatchStatus: "not_requested",
    }));

    // 두 번째 스윕: 재발사는 계속 시도하되(기존 동작), 오너 재깨움은 1회로 멱등.
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(2);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(second.findings.join("\n")).not.toContain("owner_decision_dispatch_stalled_wake_requested");
  });

  it("counts consecutive QA rejects for the repeated-defect trend and enriches the cap description", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    const at = (h: number) => new Date(`2026-08-17T0${h}:00:00.000Z`);

    await db.insert(companies).values({ id: companyId, name: "Reject Trend Company", issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "[QA] Inspect", status: "done", originKind: "workflow_execution" });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId, status: "succeeded", startedAt: at(1), finishedAt: at(1) });
    const verdict = (verdictValue: string, hour: number, reason: string | null) => ({
      companyId, issueId, heartbeatRunId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: verdictValue, decision: verdictValue, reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: at(hour), payload: { kind: "workflow_validation_verdict", verdict: verdictValue, ...(reason ? { reason } : {}) },
    });
    await db.insert(workflowTransitionEvents).values([
      verdict("pass", 1, "earlier pass"),
      verdict("request_changes", 2, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 3, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 4, "contrast 4.47:1 below 4.5:1"),
    ]);

    const trend = await loadConsecutiveQaRejectTrend(db, companyId, issueId);
    expect(trend.count).toBe(3);
    expect(trend.latestReason).toContain("4.47");

    // 최신이 pass 면 연속 0.
    await db.insert(workflowTransitionEvents).values(verdict("pass", 5, "fixed"));
    expect((await loadConsecutiveQaRejectTrend(db, companyId, issueId)).count).toBe(0);

    // 설명 강화: 연속 ≥2면 추세 경고, 1이면 없음.
    const exhaustion = {
      workflowRunId: "run-1", producerStepId: "materialize", qaStepId: "inspection", qaStepRunId: "step-run-1",
      producerIteration: 6, maxIterations: 2, producerCompletedAt: at(4), producerIssueId: "prod-1", qaIssueId: issueId,
    } as never;
    const enriched = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:1", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 4, latestReason: "contrast 4.02:1 below 4.5:1" } });
    expect(enriched).toContain("Consecutive QA rejects on this gate: 4");
    expect(enriched).toContain("원천(생성기/템플릿/스킬)");
    expect(enriched).toContain("Latest QA defect: contrast 4.02:1 below 4.5:1");
    const plain = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:2", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 1, latestReason: null } });
    expect(plain).not.toContain("Consecutive QA rejects");
  });

  it("wakes the owner for periodic mission review while work is in flight (bucket-idempotent)", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Periodic Review Company", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Periodic review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "periodic-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "in_progress", title: "Produce report" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] periodic-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    // 같은 30분 버킷 안의 두 스윕 → 1회만 깨움.
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      inFlightUnitLabels: expect.arrayContaining([`native_workflow_run:${workflowRunId}:running`]),
    }));

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:12:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);

    // 다음 버킷 → 다시 1회.
    const third = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:38:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(third.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(2);
  });

  it("does not wake for periodic review when execution is fully settled", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-18T11:00:00.000Z");
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Settled Review Company", issuePrefix: `SR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settled review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "settled-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settled-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T11:10:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();
    // settlement 가 미션을 종결했고 리뷰 대상이 없다.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("half-applied owner retry (wakeup marker not_requested) re-dispatches instead of stalling forever", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "dispatched", runId: "run-1" });

    await db.insert(companies).values({ id: companyId, name: "Half Applied Company", issuePrefix: `HA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Half applied retry mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "half-applied-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });

    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: retry_source_issue",
        `Source issue: ${qaIssue.identifier}`,
        `Rework target: ${producerIssue.identifier}`,
        "Reason: producer must provide signal-analysis evidence before QA can complete.",
      ].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: qaIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: qaIssue.identifier ?? qaIssue.id,
        reworkTargetRef: producerIssue.identifier ?? producerIssue.id,
        reason: "producer must provide signal-analysis evidence before QA can complete.",
      },
    });
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    // [half-applied] apply marker recorded + wakeup marker recorded with not_requested
    //   (2026-08-15 GAZ ef12d027 stall: native resume could not prove a link, so nothing was dispatched).
    await db.insert(workflowTransitionEvents).values([
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_apply",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: `${wakeupKey}:apply`,
        toStatus: "done",
        payload: { sourceIssueId: producerIssue.id },
      },
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_wakeup",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: wakeupKey,
        toStatus: "not_requested",
        payload: { sourceIssueId: producerIssue.id },
      },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    // 핵심: not_requested 마커는 '이미 적용됨'이 아니다 — 재발사가 일어나야 한다.
    expect(result.findings.join("\n")).not.toContain("owner_action_decision_already_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: producerAgentId,
      idempotencyKey: wakeupKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_source_issue",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        wakeupDispatchStatus: "dispatched",
      }),
    ]));
    // dispatch-only: 반쪽 적용 상태에선 apply(reopen/재코멘트)를 반복하지 않는다.
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) =>rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));

    // 수렴: 발사 마커가 dispatched 로 기록된 뒤엔 재발사하지 않는다.
    onOwnerDecisionRetrySourceIssueApplied.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(second.appliedActions.filter((action) => action.type === "owner_decision_retry_source_issue")).toEqual([]);
  });

  it("applies retry_source_issue with no source assignee but skips explicit wakeup dispatch", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry No Assignee Company", issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "No assignee retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { missionId, originKind: "workflow_execution", status: "blocked", title: "Unassigned blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] 이 테스트는 source assignee 없는 케이스 자체가 목적이므로 guard를 우회해 fixture done 처리.
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, unblockIssue.id));
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry unassigned source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry unassigned source",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(result.findings.join("\n")).toContain("source issue has no assignee; wakeup dispatch skipped");
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, resultStatus: "blocked", wakeupDispatchStatus: "skipped_no_assignee" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: null }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).not.toContain("mission-owner-decision-applied");
    expect(sourceBody).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("does not mutate or dispatch missing, cross-mission, terminal, or hidden retry_source_issue sources", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const otherMissionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn(), onOwnerActionCreated = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry Safety Company", issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values([{ id: missionId, companyId, ownerAgentId, title: "Retry safety mission", status: "active" }, { id: otherMissionId, companyId, ownerAgentId, title: "Other mission", status: "active" }]);
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied, onOwnerActionCreated });
    const terminalIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "done", title: "Terminal source" });
    const crossMissionIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId: otherMissionId, originKind: "workflow_execution", status: "blocked", title: "Cross mission source" });
    const hiddenIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Hidden source" });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssue.id));
    for (const [sourceIssue, title] of [[terminalIssue, "Terminal owner action"], [crossMissionIssue, "Cross mission owner action"], [hiddenIssue, "Hidden owner action"]] as const) {
      const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title });
      await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: should not mutate"].join("\n") });
      await recordOwnerDecision({
        companyId,
        missionId,
        ownerActionIssueId: ownerAction.id,
        ownerAgentId,
        sourceIssueId: sourceIssue.id,
        submission: {
          decision: "retry_source_issue",
          sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
          reason: "should not mutate",
        },
      });
    }
    const missingSourceId = randomUUID(); const missingOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: missingSourceId, status: "done", title: "Missing owner action" });
    await db.insert(issueComments).values({ companyId, issueId: missingOwnerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${missingSourceId}`, "Reason: should not mutate missing source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: missingOwnerAction.id,
      ownerAgentId,
      sourceIssueId: missingSourceId,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: missingSourceId,
        reason: "should not mutate missing source",
      },
    });
    const readSourcesAndAnchors = () => db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(issues.id).then((rows) => rows.filter((row) => row.originKind !== "mission_main_executor_oversight")); const before = await readSourcesAndAnchors();
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(result.findings.join("\n")).toContain("owner_action_decision_not_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled(); expect(onOwnerActionCreated).not.toHaveBeenCalled();
    expect(await readSourcesAndAnchors()).toEqual(before);
    await expect(db.select().from(issues).where(eq(issues.id, terminalIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, crossMissionIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, hiddenIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("keeps non-replan owner decisions read-only even with explicit owner-decision apply and wakeup dispatch enabled", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Non Retry Company", issuePrefix: `NR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Non retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Input owner action" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: request_input", `Source issue: ${blockedIssue.identifier}`, "Reason: operator input is required"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "request_input",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "operator input is required",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("explains decision-required owner actions without leaking unrelated text", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Required Company", issuePrefix: `ER${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source", description: "DO_NOT_LEAK_SOURCE_DESCRIPTION" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_required",
        ownerActionIssue: expect.objectContaining({ title: expect.stringContaining("[Unblock]") }),
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        latestDecision: null,
        retryApplied: false,
        explanation: expect.stringContaining("Owner decision required"),
      }),
    ]));
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("DO_NOT_LEAK_SOURCE_DESCRIPTION");
  });

  it("explains read-only retry decisions before explicit apply", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Read Only Company", issuePrefix: `EO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Read-only explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry when explicitly applied", "Next action: wait for apply", "Evidence: OWNER_DECISION_EVIDENCE_ONLY"].join("\n") });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: "UNRELATED_OWNER_COMMENT_NOT_FOR_STATUS_SUMMARY" });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_recorded_read_only",
        ownerActionIssue: expect.objectContaining({ id: unblockIssue.id }),
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
        retryApplied: false,
        explanation: expect.stringContaining("recorded but not applied"),
      }),
    ]));
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("UNRELATED_OWNER_COMMENT_NOT_FOR_STATUS_SUMMARY");
  });

  it("does not explain a retry as applied when no wakeup was queued", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Applied Company", issuePrefix: `EA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Applied explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: apply retry"].join("\n") });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "decision_recorded_read_only",
        sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
        retryApplied: false,
        explanation: expect.stringContaining("recorded but not applied"),
      }),
    ]));
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, blockedIssue.id))).resolves.toHaveLength(0);
  });

  it("explains invalid owner decisions as not applicable without executing", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Invalid Company", issuePrefix: `EI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Invalid explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: auto_magic", `Source issue: ${blockedIssue.identifier}`, "Reason: invalid"].join("\n") });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(result.ownerActionExplanations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "not_applicable_or_invalid",
        latestDecision: expect.objectContaining({ decision: null, invalidDecision: "auto_magic" }),
        retryApplied: false,
        explanation: expect.stringContaining("invalid"),
      }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });

  it("returns ownerActionExplanations from getById matching supervision path results", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explanation Parity Company", issuePrefix: `EP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Explanation parity mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: parity check"].join("\n") });

    const supervisionResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    const detail = await svc.getById(missionId);
    const supervisionExplanation = supervisionResult.ownerActionExplanations.find((explanation) => explanation.ownerActionIssue.id === unblockIssue.id);
    const detailExplanation = detail.ownerActionExplanations.find((explanation) => explanation.ownerActionIssue.id === unblockIssue.id);

    expect(detailExplanation).toBeDefined();
    expect(supervisionExplanation).toBeDefined();
    expect(detailExplanation).toEqual(expect.objectContaining({
      status: supervisionExplanation!.status,
      explanation: supervisionExplanation!.explanation,
      retryApplied: supervisionExplanation!.retryApplied,
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, status: "blocked", assigneeAgentId: workerAgentId }),
      latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
    }));
  });

  it("excludes hidden owner-action issues from supervision and getById explanations", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hidden Explanation Company", issuePrefix: `HE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Hidden explanation mission", status: "active" });
    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    const hiddenOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Hidden owner action" });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenOwnerAction.id));

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    const detail = await svc.getById(missionId);

    expect(result.ownerActionExplanations.some((explanation) => explanation.ownerActionIssue.id === hiddenOwnerAction.id)).toBe(false);
    expect(detail.ownerActionExplanations.some((explanation) => explanation.ownerActionIssue.id === hiddenOwnerAction.id)).toBe(false);
    expect(JSON.stringify(result.ownerActionExplanations)).not.toContain("Hidden owner action");
    expect(JSON.stringify(detail.ownerActionExplanations)).not.toContain("Hidden owner action");
  });

  it("treats invalid owner-action decisions conservatively without auto action", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Invalid owner-decision comment is display-only",
      issuePrefix: `IO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Invalid decision mission", status: "active" });

    const svc = missionService(db);
    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Blocked source work",
    });

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]);
    expect(unblockIssue).toBeTruthy();

    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue!.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: auto_fix_everything",
        `Source issue: ${blockedIssue.identifier}`,
        "Reason: Unsupported automated action.",
      ].join("\n"),
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_decision_invalid"),
    ]));
    expect(result.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining("auto_fix_everything") }),
    ]));
    expect(result.appliedActions).toEqual([]);

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockedIssue.id))
      .then((rows) => rows[0]);
    expect(sourceIssue).toEqual(expect.objectContaining({
      assigneeAgentId: workerAgentId,
      status: "blocked",
    }));
  });

  it("surfaces blocked owner unblock actions as recovery work instead of ignoring the deadlock", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Owner Action Deadlock Company",
      issuePrefix: `OD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Blog Writer",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "gazua-morning artifact mission",
      status: "active",
    });

    const blockedIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "[gazua-morning] blog markdown 작성",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: blockedIssue.id,
      authorAgentId: workerAgentId,
      body: [
        "### Work completed in comment but artifact missing",
        "Required source artifact is missing: `/tmp/Public_Market_Report_2026-05-20.md`",
        "# Public Market Report 2026-05-20",
        "본문 초안입니다.",
      ].join("\n"),
    });

    await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    const unblockIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"))
      .then((rows) => rows[0]);
    expect(unblockIssue).toBeTruthy();

    await issueService(db).update(unblockIssue!.id, { status: "blocked" });
    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue!.id,
      authorAgentId: ownerAgentId,
      body: "Blocked: Required source artifact is missing: `/tmp/Public_Market_Report_2026-05-20.md`",
    });

    const result = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_unblock_action_blocked"),
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("artifact_recovery_available"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: unblockIssue!.id,
        reason: expect.stringContaining("self-block"),
        safeToAutoApply: false,
      }),
    ]));

    const unblockIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(unblockIssues).toHaveLength(1);
  });

  it("surfaces repeated artifact-missing failures as recurring owner-improvement work", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Recurring Artifact Company",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Main Executor",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Blog Writer",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "gazua-morning recurring blog artifact mission",
      status: "active",
    });

    const previousIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      status: "blocked",
      title: "[gazua-morning] 2026-05-18 일간 블로그 markdown 작성",
    });
    // Display-only missing-artifact comment must not authorize recurring-replan by itself.
    await db.insert(issueComments).values({
      companyId,
      issueId: previousIssue.id,
      body: "### Required workflow artifact missing\n- Required artifact: reports/blog/202605/Public_Market_Report_2026-05-18.md",
    });
    const currentIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "[gazua-morning] 2026-05-20 일간 블로그 markdown 작성",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: currentIssue.id,
      body: "### Required workflow artifact missing\n- Required artifact: reports/blog/202605/Public_Market_Report_2026-05-20.md",
    });
    // Structured gate activity is the only authority for recurring artifact-missing detection.
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.artifact_work_product_missing_auto_blocked",
        entityType: "issue",
        entityId: previousIssue.id,
        details: { reason: "missing_work_product_registration" },
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.artifact_work_product_missing_auto_blocked",
        entityType: "issue",
        entityId: currentIssue.id,
        details: { reason: "missing_work_product_registration" },
      },
    ]);

    const result = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("recurring_artifact_missing"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: currentIssue.id,
        reason: expect.stringContaining("Recurring artifact-missing"),
        safeToAutoApply: false,
      }),
    ]));
  });

  registerMissionPluginSubstrateCases(() => db);
  registerMissionStalePluginEscalationCases(() => db);

  it("restores terminal mission oversight when the mission is still active", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();
    const completedAt = new Date("2026-06-12T09:52:51.477Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Oversight Restore Company",
      issuePrefix: `OR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Active mission with closed oversight",
      status: "active",
    }).returning();
    await db.insert(issues).values({
      id: oversightIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] stale title",
      status: "done",
      priority: "medium",
      completedAt,
    });

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 30,
      now: new Date("2026-06-12T10:00:00.000Z"),
    });

    expect(supervision.oversightIssueId).toBe(oversightIssueId);
    const [storedOversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));
    expect(storedOversight).toEqual(expect.objectContaining({
      status: "todo",
      completedAt: null,
      assigneeAgentId: ownerAgentId,
      title: "[OVERSIGHT] stale title",
    }));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, oversightIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission oversight restored"))).toBe(true);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, oversightIssueId));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "mission.oversight_restored",
        entityType: "issue",
        entityId: oversightIssueId,
      }),
    ]));
  });

  registerMissionToolRecoveryCases(() => db);
  registerMissionToolRecoveryClassificationCases(() => db);

  it("creates the main executor oversight substrate when a workflow mission is created", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Oversight Company",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await missionService(db).create({
      companyId,
      ownerAgentId,
      title: "2026-05-15 gazua-weekly",
      description: "Created automatically for plugin workflow run: gazua-weekly",
      status: "active",
      source: "workflow",
    });

    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, result.id));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, result.id));

    expect(oversightIssues).toEqual([
      expect.objectContaining({
        companyId,
        assigneeAgentId: ownerAgentId,
        missionId: result.id,
        originKind: "mission_main_executor_oversight",
        status: "todo",
        title: "[OVERSIGHT] 2026-05-15 gazua-weekly",
      }),
    ]);
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.refs).toMatchObject({
      oversightIssueId: oversightIssues[0]?.id,
      workflowName: "2026-05-15 gazua-weekly",
    });
  });

  it("does not reuse a workflow mission that reconciles to terminal from linked workflow runs", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Terminal Dedup Company",
      issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-watchlist-refresh",
      stepsJson: [],
    });

    const input = {
      companyId,
      ownerAgentId,
      title: "2026-04-30 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active" as const,
      source: "workflow" as const,
    };

    const first = await missionService(db).create(input);
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      companyId,
      workflowId,
      missionId: first.id,
      status: "cancelled",
      triggeredBy: "test",
      completedAt: new Date("2026-04-30T00:05:00.000Z"),
    });

    const second = await missionService(db).create(input);
    const missionRows = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, companyId));

    expect(second.id).not.toBe(first.id);
    expect(missionRows).toHaveLength(2);
  });

  registerMissionListingCases(() => db);
  registerMissionIssueTreeCases(() => db);
  registerMissionWorkflowRunCases(() => db);
  registerMissionOversightCompletionCases(() => db);

  registerMissionReopenCases(() => db);
  registerMissionLegacyPluginCases(() => db);
  registerMissionLegacyPlanningCases(() => db);
  registerMissionCancelledMissionCases(() => db);

  it("links plugin workflow step issue ancestors to the mission before returning the issue tree", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const parentIssueId = randomUUID();
    const stepIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Issue Company",
      issuePrefix: `PI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin Workflow Mission",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: missionPluginManifest("insightflo.workflow-engine", "Workflow Engine", "1.0.0"),
      status: "ready",
    });

    await db.insert(pluginEntities).values([
      {
        id: workflowId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-definition:${workflowId}`,
        title: "tech-scout",
        status: "active",
        data: { name: "tech-scout", companyId, steps: [{ id: "scout", title: "Scout", dependsOn: [] }] },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "tech-scout run",
        status: "running",
        data: {
          workflowId,
          workflowName: "tech-scout",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scout`,
        title: "scout",
        status: "completed",
        data: { runId, stepId: "scout", issueId: stepIssueId, status: "completed" },
      },
    ]);

    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId: null,
        title: "[tech-scout] #2026-04-27-1",
        status: "backlog",
        priority: "medium",
        identifier: "PI-1",
      },
      {
        id: stepIssueId,
        companyId,
        missionId: null,
        parentId: parentIssueId,
        title: "[tech-scout] 2026-04-27 기술 리서치 리포트",
        status: "done",
        priority: "high",
        identifier: "PI-2",
      },
    ]);

    const svc = missionService(db);
    const result = await svc.getIssueTree(missionId);

    expect(result.map((issue) => issue.id)).toEqual(expect.arrayContaining([parentIssueId, stepIssueId]));
    expect(result.find((issue) => issue.id === stepIssueId)?.parentId).toBe(parentIssueId);

    const stored = await db
      .select({ id: issues.id, missionId: issues.missionId })
      .from(issues)
      .where(inArray(issues.id, [parentIssueId, stepIssueId]));
    expect(stored).toEqual(
      expect.arrayContaining([
        { id: parentIssueId, missionId },
        { id: stepIssueId, missionId },
      ]),
    );
  });

  it("returns plugin entity workflow runs linked to a mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Workflow Company",
      issuePrefix: `PW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Workflow Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin Workflow Mission",
      status: "active",
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "insightflo.workflow-engine",
      packageName: "@insightflo/paperclip-workflow-engine",
      version: "1.0.0",
      apiVersion: 1,
      categories: [],
      manifestJson: missionPluginManifest("insightflo.workflow-engine", "Workflow Engine", "1.0.0"),
      status: "ready",
    });

    await db.insert(pluginEntities).values([
      {
        id: workflowId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-definition:${workflowId}`,
        title: "Scheduled Plugin Workflow",
        status: "active",
        data: {
          name: "Scheduled Plugin Workflow",
          description: "Scheduled plugin run should show on mission execution flow.",
          companyId,
          status: "active",
          steps: [
            {
              id: "scheduled-step",
              title: "Scheduled E2E pass step",
              dependsOn: [],
              type: "agent",
              agentName: "Workflow Owner",
            },
          ],
        },
      },
      {
        id: runId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `workflow-run:${runId}`,
        title: "Scheduled Plugin Workflow run",
        status: "running",
        data: {
          workflowId,
          workflowName: "Scheduled Plugin Workflow",
          companyId,
          missionId,
          status: "running",
          triggerSource: "schedule",
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
      {
        id: stepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: `${runId}:scheduled-step`,
        title: "scheduled-step",
        status: "in_progress",
        data: {
          runId,
          stepId: "scheduled-step",
          issueId,
          agentName: "Workflow Owner",
          status: "in_progress",
          retryCount: 0,
          startedAt: "2026-04-27T00:00:00.000Z",
        },
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Scheduled plugin step issue",
      status: "in_progress",
      priority: "high",
      identifier: "PW-11",
      assigneeAgentId: ownerAgentId,
    });

    const svc = missionService(db);
    const result = await svc.listWorkflowRuns(missionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: runId,
        missionId,
        companyId,
        workflowName: "Scheduled Plugin Workflow",
        status: "running",
        triggeredBy: "schedule",
      }),
    );
    expect(result[0]?.steps).toEqual([
      expect.objectContaining({
        stepId: "scheduled-step",
        name: "Scheduled E2E pass step",
        type: "agent",
        agentId: ownerAgentId,
        dependencies: [],
        status: "running",
        issueId,
        issue: expect.objectContaining({
          id: issueId,
          identifier: "PW-11",
          title: "Scheduled plugin step issue",
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
        }),
      }),
    ]);
  });
});

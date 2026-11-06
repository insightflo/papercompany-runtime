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
import { registerMissionStaleRetryDispatchCases } from "./helpers/mission-service-stale-retry-dispatch-cases.js";
import { registerMissionRetryIdempotencyCases } from "./helpers/mission-service-retry-idempotency-cases.js";
import { registerMissionCloseoutCases } from "./helpers/mission-service-mission-closeout-cases.js";
import { registerMissionOwnerWakeupCadenceCases } from "./helpers/mission-service-owner-wakeup-cadence-cases.js";
import { registerMissionPlanSupervisionCases } from "./helpers/mission-service-plan-supervision-cases.js";
import { registerMissionPlanReopenCases } from "./helpers/mission-service-plan-reopen-cases.js";
import { registerMissionPlanSubmissionFollowupCases } from "./helpers/mission-service-plan-submission-followup-cases.js";
import { registerMissionStaleSourceClassificationCases } from "./helpers/mission-service-stale-source-classification-cases.js";
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

  registerMissionPlanSupervisionCases(() => db);
  registerMissionPlanReopenCases(() => db);
  registerMissionPlanSubmissionFollowupCases(() => db);
  registerMissionStaleSourceClassificationCases(() => db);

  registerMissionStaleRetryDispatchCases(() => db);
  registerMissionRetryIdempotencyCases(() => db);
  registerMissionCloseoutCases(() => db);
  registerMissionOwnerWakeupCadenceCases(() => db);

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

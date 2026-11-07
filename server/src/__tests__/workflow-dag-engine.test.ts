import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// vi.hoisted: mock factories run during ESM import resolution, before plain consts init.
// Production path: wakeExistingWorkflowStepIssue → queueIssueAssignmentWakeup({ heartbeat: heartbeatService(db) })
// → heartbeat.wakeup(...). The heartbeatService mock alone does not always bind in this file's
// import graph, so real enqueueWakeup runs (agent_runtime_state / activity_log FK cleanup failures
// + 0 spy calls). Force the assignment-wakeup helper to use the test spy while keeping its
// real guards/payload shape so existing wakeup assertions stay valid.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

import { registerStuckWorkflowCase } from "./helpers/workflow-stuck-case.js";
import { cleanWorkflowDagFixture } from "./helpers/workflow-dag-cleanup-fixture.js";
import { createWorkflowDependencyFixture } from "./helpers/workflow-dependency-fixture.js";
import { registerWorkflowDagBackedgeVerdictCases } from "./helpers/workflow-dag-backedge-verdict-cases.js";
import { registerWorkflowDagQaLoopBudgetCases } from "./helpers/workflow-dag-qa-loop-budget-cases.js";
import { registerWorkflowDagQaDownstreamCases } from "./helpers/workflow-dag-qa-downstream-cases.js";
import { registerWorkflowDagQaLoopTerminalCases } from "./helpers/workflow-dag-qa-loop-terminal-cases.js";
import { registerWorkflowDagStaleDispatchCases } from "./helpers/workflow-dag-stale-dispatch-cases.js";
import { registerWorkflowDagMissionSupervisionCases } from "./helpers/workflow-dag-mission-supervision-cases.js";
import { registerWorkflowDagOwnerRecommendationCases } from "./helpers/workflow-dag-owner-recommendation-cases.js";
import { registerWorkflowDagPlanAndCancelCases } from "./helpers/workflow-dag-plan-and-cancel-cases.js";
import { registerWorkflowDagCrossCompanyDelegationCases } from "./helpers/workflow-dag-cross-company-delegation-cases.js";
import { registerWorkflowDagPrerequisiteFailureCases } from "./helpers/workflow-dag-prerequisite-failure-cases.js";
import { registerWorkflowDagFailureGateCases } from "./helpers/workflow-dag-failure-gate-cases.js";
import { registerWorkflowDagMixedControlFlowCases } from "./helpers/workflow-dag-mixed-control-flow-cases.js";
import { registerWorkflowDagToolArgsAndCacheCases } from "./helpers/workflow-dag-tool-args-and-cache-cases.js";
import { registerWorkflowDagToolConcurrencyAndRetentionCases } from "./helpers/workflow-dag-tool-concurrency-and-retention-cases.js";
import { registerWorkflowDagAllToolWorkflowCases } from "./helpers/workflow-dag-all-tool-workflow-cases.js";
import { registerWorkflowDagToolRegistryEventCases } from "./helpers/workflow-dag-tool-registry-event-cases.js";
import { registerWorkflowDagDependentStepAdvanceCases } from "./helpers/workflow-dag-dependent-step-advance-cases.js";
import { registerWorkflowDagOversightAndUnassignedCases } from "./helpers/workflow-dag-oversight-and-unassigned-cases.js";
import { registerWorkflowDagLegacyPluginAssigneeCases } from "./helpers/workflow-dag-legacy-plugin-assignee-cases.js";
import { registerWorkflowDagToolArtifactAndFailureCases } from "./helpers/workflow-dag-tool-artifact-and-failure-cases.js";
import { registerWorkflowDagTriggerMissionCases } from "./helpers/workflow-dag-trigger-mission-cases.js";
import { registerWorkflowDagScheduleTimezoneCases } from "./helpers/workflow-dag-schedule-timezone-cases.js";
import { registerWorkflowDagArtifactDependencyCases } from "./helpers/workflow-dag-artifact-dependency-cases.js";
import { registerWorkflowDagQaGateAndMarkerCases } from "./helpers/workflow-dag-qa-gate-and-marker-cases.js";
import { registerWorkflowDagStepResumeCases } from "./helpers/workflow-dag-step-resume-cases.js";
import { registerWorkflowDagResumeAssigneeCases } from "./helpers/workflow-dag-resume-assignee-cases.js";
import { registerWorkflowDagValidatorBlockCases } from "./helpers/workflow-dag-validator-block-cases.js";
import { registerWorkflowDagValidatorRequeueCases } from "./helpers/workflow-dag-validator-requeue-cases.js";
import { registerWorkflowDagQaRubricCases } from "./helpers/workflow-dag-qa-rubric-cases.js";
import { registerWorkflowDagDispatchContractCases } from "./helpers/workflow-dag-dispatch-contract-cases.js";
import { registerWorkflowDagDeliveryGateCases } from "./helpers/workflow-dag-delivery-gate-cases.js";
import { registerWorkflowDagReadbackCases } from "./helpers/workflow-dag-readback-cases.js";
import { registerWorkflowDagDefinitionAuthoringCases } from "./helpers/workflow-dag-definition-authoring-cases.js";
import { registerWorkflowDagToolReferenceCases } from "./helpers/workflow-dag-tool-reference-cases.js";
import { registerWorkflowDagEntryStepCases } from "./helpers/workflow-dag-entry-step-cases.js";
import { registerWorkflowDagRunMetadataCases } from "./helpers/workflow-dag-run-metadata-cases.js";
import { registerWorkflowDagStuckRunCases } from "./helpers/workflow-dag-stuck-run-cases.js";
import { registerWorkflowDagDeadlockRecoveryCases } from "./helpers/workflow-dag-deadlock-recovery-cases.js";
import { registerWorkflowDagParallelAndWakeupCases } from "./helpers/workflow-dag-parallel-and-wakeup-cases.js";
import { registerWorkflowDagGateAndReworkCases } from "./helpers/workflow-dag-gate-and-rework-cases.js";
import {
  executeWorkflowRun,
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepReadinessChecker,
  setWorkflowToolStepExecutor,
  syncWorkflowRunForIssue,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow DAG tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeWorkflowRun issue lifecycle parity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const { recordWorkflowVerdictForIssue } = createWorkflowDependencyFixture(() => db, heartbeatWakeup);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-dag-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
    await cleanWorkflowDagFixture(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  registerStuckWorkflowCase(() => db);

  registerWorkflowDagStuckRunCases(() => db);

  registerWorkflowDagDeadlockRecoveryCases(() => db);

  describe("revive stale controlFlowSkipped after predecessor recovery (plain dependsOn)", () => {
    async function seedStaleSkipRun(normalizeGovStatus: "completed" | "failed"): Promise<string> {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const workflowId = randomUUID();
      const runId = randomUUID();
      heartbeatWakeup.mockResolvedValue({ id: "queued-revive-skip" });
      await db.insert(companies).values({
        id: companyId,
        name: "Revive Skip Company",
        issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Revive Skip Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      // Plain dependsOn only — no conditional edge. select-targets requires three normalize steps.
      await db.insert(workflowDefinitions).values({
        id: workflowId,
        companyId,
        name: "merge-candidates",
        stepsJson: [
          { id: "n-gov", name: "Normalize Government Iris", type: "agent", agentId, dependencies: [] },
          { id: "n-a", name: "Normalize A", type: "agent", agentId, dependencies: [] },
          { id: "n-b", name: "Normalize B", type: "agent", agentId, dependencies: [] },
          { id: "select-targets", name: "Select Targets", type: "agent", agentId, dependencies: ["n-gov", "n-a", "n-b"] },
        ],
      });
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        companyId,
        status: "running",
        triggeredBy: "schedule",
        startedAt: new Date(),
        completedAt: null,
      });
      const now = new Date();
      // Stale state left when select-targets was force-skipped at first failure (deadlock-reconciler
      // sentinel) while n-gov later either recovered (completed) or stayed failed.
      await db.insert(workflowStepRuns).values([
        {
          workflowRunId: runId,
          stepId: "n-gov",
          status: normalizeGovStatus,
          startedAt: normalizeGovStatus === "failed" ? now : null,
          completedAt: normalizeGovStatus === "completed" ? now : null,
        },
        { workflowRunId: runId, stepId: "n-a", status: "completed", completedAt: now },
        { workflowRunId: runId, stepId: "n-b", status: "completed", completedAt: now },
        { workflowRunId: runId, stepId: "select-targets", status: "skipped", completedAt: now, metadata: { controlFlowSkipped: true } },
      ]);
      return runId;
    }

    it("re-evaluates a stale controlFlowSkipped step once its plain dependencies recover to completed", async () => {
      const runId = await seedStaleSkipRun("completed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      // Revived: no longer skipped (now pending/created for launch).
      expect(select.status).toBe("pending");
    });

    it("keeps a controlFlowSkipped step skipped while a plain dependency is still failed", async () => {
      const runId = await seedStaleSkipRun("failed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      // Legitimate skip preserved: predecessor still failed, activation not runnable.
      expect(select.status).toBe("skipped");
    });

    it("flag ON keeps the stale controlFlowSkipped step skipped until predecessors are dispatch-ready (same fact map as launch)", async () => {
      // [B2 사실망 통일] 완료 선행이 dispatch_ready_at 없이 완료된 상태에서 v1 이 켜지면 launch 가
      //   대기하듯 revive 도 부활하지 않는다(플래그 off 의 revive 와 기대가 다르다).
      await db.delete(instanceSettings);
      await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
      const runId = await seedStaleSkipRun("completed");
      await syncWorkflowRunState(db, runId);
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const select = rows.find((row) => row.stepId === "select-targets")!;
      expect(select.status).toBe("skipped");
      expect((select.metadata as { controlFlowSkipped?: boolean }).controlFlowSkipped).toBe(true);
    });
  });

  registerWorkflowDagParallelAndWakeupCases(() => db, heartbeatWakeup);

  registerWorkflowDagGateAndReworkCases(() => db);


  registerWorkflowDagDefinitionAuthoringCases(() => db);

  registerWorkflowDagToolReferenceCases(() => db);

  registerWorkflowDagEntryStepCases(() => db, heartbeatWakeup);

  registerWorkflowDagRunMetadataCases(() => db, heartbeatWakeup);

  registerWorkflowDagQaRubricCases(() => db, heartbeatWakeup);

  registerWorkflowDagDispatchContractCases(() => db, heartbeatWakeup);

  registerWorkflowDagDeliveryGateCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagReadbackCases(() => db, heartbeatWakeup);

  registerWorkflowDagStepResumeCases(() => db, heartbeatWakeup);

  registerWorkflowDagResumeAssigneeCases(() => db, heartbeatWakeup);

  registerWorkflowDagValidatorBlockCases(() => db, recordWorkflowVerdictForIssue);

  registerWorkflowDagValidatorRequeueCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  it("[structured authority] a heartbeat PASS in stdout and a REQUEST_CHANGES comment do not record a verdict event or drive completion", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const passRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Recovery",
      issuePrefix: `VR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:05:00.000Z"),
      completedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier validation failed.",
    });
    await db.insert(heartbeatRuns).values({
      id: passRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        result: "## Report Validator Verdict: **PASS**\n\nBoth requested fixes are verified.",
      },
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      finishedAt: new Date("2026-06-14T06:12:00.000Z"),
      createdAt: new Date("2026-06-14T06:11:00.000Z"),
      updatedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a REQUEST_CHANGES comment and a heartbeat resultJson.stdout PASS are not verdict
    //   authority — no structured workflow_validation_verdict event is recorded, so no downstream
    //   completion is driven by comment/stdout.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  it("[structured authority] a REQUEST_CHANGES comment before the execution window does not record a verdict event (no stdout/comment authority)", async () => {
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();
    const passRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Validation Requeued Recovery",
      issuePrefix: `VQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Report Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Daily AI news requeued recovery",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "validate-ai-news-note", qaType: "semantic",
          name: "Validate TechCrunch AI note claims and sources",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-note"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      title: "tech-ai-news: Validate TechCrunch AI note claims and sources",
      status: "done",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      completedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: validatorIssueId,
      authorAgentId: validatorAgentId,
      createdAt: new Date("2026-06-14T06:09:00.000Z"),
      body: "## Mission validation gate: REQUEST_CHANGES\n- Earlier execution failed before requeue.",
    });
    await db.insert(heartbeatRuns).values({
      id: passRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        result: "## Report Validator Verdict: **PASS**\n\nThe current execution passes validation.",
      },
      startedAt: new Date("2026-06-14T06:11:00.000Z"),
      finishedAt: new Date("2026-06-14T06:12:00.000Z"),
      createdAt: new Date("2026-06-14T06:11:00.000Z"),
      updatedAt: new Date("2026-06-14T06:12:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-note",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:11:00.000Z"),
        completedAt: new Date("2026-06-14T06:12:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: comments and heartbeat stdout are not verdict authority — no event recorded, no completion.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-note")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  // stdout fixtures remain only to verify that natural-language output is not workflow authority.
  function buildCodexStdout(lines: unknown[]): string {
    return lines.map((line) => JSON.stringify(line)).join("\n");
  }

  it("[structured authority] a REQUEST_CHANGES verdict in heartbeat resultJson.stdout does not record a verdict event or fail the validator", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Validation Gate",
      issuePrefix: `CS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
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
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact", qaType: "semantic",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // This Codex JSONL output resembles a rejection but must not cause a workflow transition.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: { type: "agent_message", text: "Validating the artifact against source claims." },
          },
          {
            type: "task_complete",
            payload: {
              last_agent_message: "REQUEST_CHANGES\n- Hallucinated label remains in the PNG.\n- Coverage is incomplete; do not deliver to Telegram.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "running",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "pending",
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a REQUEST_CHANGES verdict carried only in heartbeat resultJson.stdout is not authority.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
  });

  it("[structured authority] a PASS verdict in heartbeat resultJson.stdout does not record a verdict event or drive downstream", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const collectIssueId = randomUUID();
    const validatorIssueId = randomUUID();
    const verdictRunId = randomUUID();
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(toolExecutor);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Codex Stdout Pass Gate",
      issuePrefix: `CP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: validatorAgentId,
        companyId,
        name: "Artifact Validator",
        role: "qa",
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
      title: "Daily AI news",
      status: "active",
      source: "workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "tech-ai-news",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect AI news evidence",
          agentId: validatorAgentId,
          dependencies: [],
        },
        {
          id: "validate-ai-news-artifact", qaType: "semantic",
          name: "Validate TechCrunch AI artifact before delivery",
          agentId: validatorAgentId,
          dependencies: ["collect-ai-news-evidence"],
        },
        {
          id: "send-telegram",
          name: "Send Telegram",
          agentId: "",
          dependencies: ["validate-ai-news-artifact"],
          type: "tool",
          toolNames: ["send-telegram"],
          toolArgs: { chatId: "ops" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "running",
      startedAt: new Date("2026-06-14T06:00:00.000Z"),
    });
    await db.insert(issues).values([
      {
        id: collectIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Collect AI news evidence",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        id: validatorIssueId,
        companyId,
        missionId,
        title: "tech-ai-news: Validate TechCrunch AI artifact before delivery",
        status: "done",
        assigneeAgentId: validatorAgentId,
        originKind: "workflow_execution",
        originId: runId,
        originRunId: runId,
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);
    // This Codex JSONL output resembles a pass but must not cause a workflow transition.
    await db.insert(heartbeatRuns).values({
      id: verdictRunId,
      companyId,
      agentId: validatorAgentId,
      issueId: validatorIssueId,
      status: "succeeded",
      invocationSource: "automation",
      resultJson: {
        stdout: buildCodexStdout([
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "PASS — Both requested fixes are verified in the PNG; sources match.",
            },
          },
        ]),
      },
      startedAt: new Date("2026-06-14T06:08:00.000Z"),
      finishedAt: new Date("2026-06-14T06:10:00.000Z"),
      createdAt: new Date("2026-06-14T06:08:00.000Z"),
      updatedAt: new Date("2026-06-14T06:10:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "collect-ai-news-evidence",
        issueId: collectIssueId,
        status: "completed",
        startedAt: new Date("2026-06-14T06:00:00.000Z"),
        completedAt: new Date("2026-06-14T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "validate-ai-news-artifact",
        issueId: validatorIssueId,
        status: "failed",
        startedAt: new Date("2026-06-14T06:05:00.000Z"),
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "send-telegram",
        issueId: null,
        status: "skipped",
        completedAt: new Date("2026-06-14T06:10:00.000Z"),
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, validatorIssueId);

    expect(result?.status).toBe("running");
    expect(toolExecutor).not.toHaveBeenCalled();
    // NEGATIVE: a PASS verdict carried only in heartbeat resultJson.stdout is not authority — no event,
    //   no downstream completion.
    const verdictEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.issueId, validatorIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      ));
    expect(verdictEvents).toHaveLength(0);
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRows.find((stepRun) => stepRun.stepId === "validate-ai-news-artifact")?.status).toBe("running");
    expect(stepRows.find((stepRun) => stepRun.stepId === "send-telegram")?.status).toBe("pending");
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const dispatchResult = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatchResult).toMatchObject({ claimedCount: 0, executedCount: 0, failedCount: 0 });
  });

  registerWorkflowDagTriggerMissionCases(() => db, heartbeatWakeup);

  registerWorkflowDagScheduleTimezoneCases(() => db, heartbeatWakeup);

  registerWorkflowDagArtifactDependencyCases(() => db, heartbeatWakeup);

  registerWorkflowDagQaGateAndMarkerCases(() => db, heartbeatWakeup);

  registerWorkflowDagDependentStepAdvanceCases(() => db, heartbeatWakeup);

  registerWorkflowDagOversightAndUnassignedCases(() => db, heartbeatWakeup);

  registerWorkflowDagLegacyPluginAssigneeCases(() => db, heartbeatWakeup);

  registerWorkflowDagToolArtifactAndFailureCases(() => db, heartbeatWakeup);

  registerWorkflowDagToolArgsAndCacheCases(() => db);

  registerWorkflowDagToolConcurrencyAndRetentionCases(() => db);

  registerWorkflowDagAllToolWorkflowCases(() => db);

  registerWorkflowDagToolRegistryEventCases(() => db);

  registerWorkflowDagCrossCompanyDelegationCases(() => db, heartbeatWakeup);

  registerWorkflowDagPrerequisiteFailureCases(() => db, heartbeatWakeup);

  registerWorkflowDagFailureGateCases(() => db, heartbeatWakeup);

  registerWorkflowDagMixedControlFlowCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagStaleDispatchCases(() => db);

  registerWorkflowDagMissionSupervisionCases(() => db, heartbeatWakeup);

  registerWorkflowDagOwnerRecommendationCases(() => db);

  registerWorkflowDagPlanAndCancelCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagBackedgeVerdictCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaLoopBudgetCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaDownstreamCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);

  registerWorkflowDagQaLoopTerminalCases(() => db, heartbeatWakeup, recordWorkflowVerdictForIssue);
});

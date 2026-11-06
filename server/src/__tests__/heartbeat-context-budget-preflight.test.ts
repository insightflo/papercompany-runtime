import { randomUUID } from "node:crypto";
import type { HeartbeatAdapterFailureOverrides } from "./helpers/heartbeat-budget-owner-cases.js";
import { registerHeartbeatFailureClassificationCase } from "./helpers/heartbeat-failure-classification-case.js";
import { registerHeartbeatOwnerContextCases } from "./helpers/heartbeat-budget-owner-cases.js";
import { registerHeartbeatContextCases } from "./helpers/heartbeat-budget-context-cases.js";
import { registerHeartbeatLifecycleCases } from "./helpers/heartbeat-budget-lifecycle-cases.js";
import { registerHeartbeatValidationCases } from "./helpers/heartbeat-budget-validation-cases.js";
import { registerHeartbeatRootPlanIssueCases } from "./helpers/heartbeat-budget-root-plan-issue-cases.js";
import { registerHeartbeatOversightTimeoutCases } from "./helpers/heartbeat-budget-oversight-timeout-cases.js";
import { registerHeartbeatChildOutputCases } from "./helpers/heartbeat-budget-child-output-cases.js";
import { registerHeartbeatArtifactChildCases } from "./helpers/heartbeat-budget-artifact-child-cases.js";
import { registerHeartbeatWorkProductAuthorityCases } from "./helpers/heartbeat-budget-workproduct-authority-cases.js";
import { registerHeartbeatArtifactMarkerCases } from "./helpers/heartbeat-budget-artifact-marker-cases.js";
import { registerHeartbeatWorkProductPathClaimsCases } from "./helpers/heartbeat-budget-workproduct-path-claims-cases.js";
import { registerHeartbeatValidatorStdoutCases } from "./helpers/heartbeat-budget-validator-stdout-cases.js";
import { registerHeartbeatVerdictLedgerCases } from "./helpers/heartbeat-budget-verdict-ledger-cases.js";
import { registerHeartbeatValidationGateScopeCases } from "./helpers/heartbeat-budget-validation-gate-scope-cases.js";
import { registerHeartbeatToolLimitAndLeadGateCases } from "./helpers/heartbeat-budget-tool-limit-and-lead-gate-cases.js";
import { registerHeartbeatContextBudgetRotationCases } from "./helpers/heartbeat-budget-context-budget-rotation-cases.js";
import { registerHeartbeatBroadScanInterceptionCases } from "./helpers/heartbeat-budget-broad-scan-interception-cases.js";
import { registerHeartbeatBootstrapAndTokenAuthorityCases } from "./helpers/heartbeat-budget-bootstrap-and-token-authority-cases.js";
import { registerHeartbeatMaintenanceActivityCases } from "./helpers/heartbeat-budget-maintenance-activity-cases.js";
import { registerHeartbeatStepToolContractCases } from "./helpers/heartbeat-budget-step-tool-contract-cases.js";
import { registerHeartbeatPromptAndToolGateCases } from "./helpers/heartbeat-budget-prompt-and-tool-gate-cases.js";
import { registerHeartbeatKnowledgeContractCases } from "./helpers/heartbeat-budget-knowledge-contract-cases.js";
import { registerHeartbeatManifestWorkspaceCases } from "./helpers/heartbeat-budget-manifest-workspace-cases.js";
import { registerHeartbeatWakeupAssigneeCases } from "./helpers/heartbeat-budget-wakeup-assignee-cases.js";
import { registerHeartbeatOwnerPlanCases } from "./helpers/heartbeat-budget-owner-plan-cases.js";
import { registerHeartbeatHandoffSessionCases } from "./helpers/heartbeat-budget-handoff-session-cases.js";
import { registerHeartbeatMissionSessionCases } from "./helpers/heartbeat-budget-mission-session-cases.js";
import { registerHeartbeatSessionAuthorityCases } from "./helpers/heartbeat-budget-session-authority-cases.js";
import { startTempDatabase, type EmbeddedPostgresInstance } from "./helpers/heartbeat-budget-database-fixture.js";
import { cleanupHeartbeatBudgetFixture } from "./helpers/heartbeat-budget-cleanup-fixture.js";
import { createInstructionRotationFixture } from "./helpers/heartbeat-instruction-rotation-fixture.js";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  projects,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  instanceSettings,
} from "@paperclipai/db";

const executeSpy = vi.fn();
const mockedAdapterOptions = vi.hoisted(() => ({ supportsLocalAgentJwt: false }));
const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: mockedAdapterOptions.supportsLocalAgentJwt,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";


/** [플레이크 RCA 2026-09-28] 런 종단 이후 wakeup 행 상태 전환(claimed→failed 등)은 비동기
 *   사후 기록이라 고정 sleep 후 읽으면 부하 시 아직 claimed 인 채로 읽힌다 — 유계 폴링으로 대기. */
async function waitForWakeupStatus(
  db: ReturnType<typeof createDb>,
  wakeupRequestId: string,
  expected: string,
  deadlineMs = 5_000,
) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const row = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    if (row?.status === expected) return row;
    if (Date.now() >= deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

/** Assert a runtime broad-scan hook interception event was recorded (not a throw). */
async function expectBroadScanInterception(db: ReturnType<typeof createDb>, runId: string) {
  const events = await db
    .select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, runId));
  const intercepted = events.find((e) => e.eventType === "guard.broad_scan_intercepted");
  expect(intercepted, "expected a guard.broad_scan_intercepted event").toBeTruthy();
  const payload = typeof intercepted?.payload === "string" ? JSON.parse(intercepted.payload) : intercepted?.payload;
  expect(payload).toMatchObject({ errorCode: "manifest_broad_scan_hook_intercepted", phase: "runtime_hook" });
}

async function waitForIssueStatus(
  db: ReturnType<typeof createDb>,
  issueId: string,
  predicate: (issue: typeof issues.$inferSelect) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (issue && predicate(issue)) return issue;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  throw new Error(`Timed out waiting for issue ${issueId}; latest status=${issue?.status ?? "missing"}`);
}

async function waitForWakeupRequestStatus(
  db: ReturnType<typeof createDb>,
  runId: string,
  predicate: (request: typeof agentWakeupRequests.$inferSelect) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runId));
    if (request && predicate(request)) return request;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runId));
  throw new Error(`Timed out waiting for wakeup request for run ${runId}; latest status=${request?.status ?? "missing"}`);
}

function successfulAdapterResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: null,
    provider: "test",
    model: "test-model",
    resultJson: null,
    runtimeServices: [],
  };
}

function failedAdapterResult(overrides: Partial<ReturnType<typeof successfulAdapterResult> & { errorCode: string }> = {}) {
  return {
    ...successfulAdapterResult(),
    exitCode: 1,
    timedOut: false,
    errorMessage: "Adapter failed",
    errorCode: "adapter_failed",
    ...overrides,
  };
}

function mockRequestChangesOnce(db: ReturnType<typeof createDb>, issueId: string, lines: string[]) {
  let returnedRequestChanges = false;
  executeSpy.mockImplementation(async ({ runId }) => {
    if (returnedRequestChanges) return successfulAdapterResult();
    returnedRequestChanges = true;
    await db
      .update(issues)
      .set({
        checkoutRunId: runId,
        executionRunId: runId,
      })
      .where(eq(issues.id, issueId));
    return {
      ...successfulAdapterResult(),
      resultJson: {
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
          JSON.stringify({
            type: "task_complete",
            payload: {
              last_agent_message: lines.join("\n"),
            },
          }),
        ].join("\n"),
      },
    };
  });
}

function decisionComment(decision: Record<string, unknown>) {
  return `### Mission owner plan decision
\`\`\`json
${JSON.stringify(decision)}
\`\`\``;
}

function validOwnerPlanDecision(missionId: string, workflowDefinitionId: string) {
  return {
    missionId,
    missionGoal: "Ship controlled rollout",
    selectedExecutionUnits: [
      {
        id: `wf:${workflowDefinitionId}:step:smoke`,
        kind: "workflow_definition_step",
        title: "Run smoke",
        selectionState: "selected",
        reason: "Required for validation",
        sourceRef: { type: "workflow_definition_step", id: workflowDefinitionId, stepId: "smoke" },
      },
    ],
    requiredInputs: ["stagingUrl"],
    successCriteria: ["smoke passes"],
    steps: [{ id: "step-1", title: "Verify staging" }],
  };
}


describe("heartbeat context budget preflight", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
    process.env.PAPERCLIP_HOME = path.join(dataDir, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "heartbeat-test";
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } }).onConflictDoNothing();
  }, 60_000);

  afterEach(async () => {
    executeSpy.mockReset();
    mockedAdapterOptions.supportsLocalAgentJwt = false;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    delete process.env.PAPERCLIP_AGENT_JWT_ISSUER;
    delete process.env.PAPERCLIP_AGENT_JWT_AUDIENCE;
    await cleanupHeartbeatBudgetFixture(db);
  });

  afterAll(async () => {
    await instance?.stop();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const seedInstructionRotationFixture = createInstructionRotationFixture(() => db, () => dataDir);

  const heartbeatBudgetCaseContext = {
    getDb: () => db,
    heartbeatService,
    executeSpy,
    successfulAdapterResult,
    waitForRunTerminal,
    mockedAdapterOptions,
    waitForIssueStatus,
    waitForWakeupRequestStatus,
    mockRequestChangesOnce,
    failedAdapterResult,
    waitForWakeupStatus,
    expectBroadScanInterception,
    seedInstructionRotationFixture,
  };
  registerHeartbeatOwnerContextCases(heartbeatBudgetCaseContext);
  registerHeartbeatContextCases(heartbeatBudgetCaseContext);
  registerHeartbeatLifecycleCases(heartbeatBudgetCaseContext);
  registerHeartbeatValidationCases(heartbeatBudgetCaseContext);
  registerHeartbeatManifestWorkspaceCases(heartbeatBudgetCaseContext);
  registerHeartbeatWakeupAssigneeCases(heartbeatBudgetCaseContext);
  registerHeartbeatOwnerPlanCases(heartbeatBudgetCaseContext);
  registerHeartbeatHandoffSessionCases(heartbeatBudgetCaseContext);
  registerHeartbeatMissionSessionCases(heartbeatBudgetCaseContext);
  registerHeartbeatSessionAuthorityCases(heartbeatBudgetCaseContext);

  // Boundary coverage for the title-based REQUEST_CHANGES validation gate
  // (`canApplyRequestChangesValidationGate` in services/heartbeat.ts). These
  // cases pin the intended gating behavior and guard against false-positive
  // drift: ordinary-titled issues must slip through even when a checked-out
  // run ends with a REQUEST_CHANGES verdict, while titles carrying common
  // validation verbs ("verify", "review") currently DO trigger the gate.

  it("does NOT block an ordinary-titled issue whose checked-out run ends with REQUEST_CHANGES (no gate keyword in title)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Synthesis",
      issuePrefix: "PSN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Synthesis Worker",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Draft the report." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "lead",
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
      title: "Synthesize report workflow",
      status: "active",
    });
    // Title intentionally contains NONE of the gate keywords
    // (no QA / audit / auditor / validator / validation / validate / verify /
    // review / check / [QA] / 검증). This documents that ordinary-titled
    // issues slip through the REQUEST_CHANGES gate even when a checked-out
    // run surfaces a REQUEST_CHANGES verdict in Codex stdout.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PSN-NEWS",
      title: "Discuss ai news wording",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({
          checkoutRunId: runId,
          executionRunId: runId,
        })
        .where(eq(issues.id, issueId));
      return {
        ...successfulAdapterResult(),
        resultJson: {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
            JSON.stringify({
              type: "task_complete",
              payload: {
                // REQUEST_CHANGES verdict present in stdout, yet the issue
                // title carries no gate keyword → the validation gate must
                // NOT auto-block it.
                last_agent_message: [
                  "REQUEST_CHANGES",
                  "",
                  "- Tighten the lede and cite primary sources.",
                ].join("\n"),
              },
            }),
          ].join("\n"),
        },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    // The issue is linked to a mission and assigned to the run agent, but its
    // title does not match the validation gate. It must therefore be
    // auto-completed (not blocked) by the successful checked-out run path.
    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) =>
      comment.body.includes("Mission validation gate: REQUEST_CHANGES"),
    )).toBe(false);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities.some((entry) =>
      entry.action === "issue.validation_request_changes_auto_blocked" &&
      entry.entityId === issueId,
    )).toBe(false);
  });

  it("does not block a 'verify' titled issue from REQUEST_CHANGES text in the checked-out run alone", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Verify",
      issuePrefix: "PVF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Verify Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Verify the deliverable." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "lead",
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
      title: "Verify report workflow",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PVF-VERIFY",
      title: "Verify citation accuracy of the report",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    mockRequestChangesOnce(db, issueId, [
      "REQUEST_CHANGES",
      "",
      "- Three citations point to secondary sources.",
    ]);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);
  });

  it("does not block a 'review' titled issue from REQUEST_CHANGES text in the checked-out run alone", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Review",
      issuePrefix: "PRV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Review Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the deliverable." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "lead",
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
      title: "Review report workflow",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PRV-REVIEW",
      title: "Review editorial consistency of the report",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    mockRequestChangesOnce(db, issueId, [
      "REQUEST_CHANGES",
      "",
      "- Tone is inconsistent across sections two and four.",
    ]);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );
    expect(updatedIssue).toEqual(
      expect.objectContaining({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
      }),
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run!.id));
    expect(activities.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);
  });

  it("syncs workflow step runs after auto-completing a successful workflow execution issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const qaAgentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedStepRunId = randomUUID();
    const followupStepRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Workflow Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Work the checked out issue." },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Workflow QA Agent",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the completed workflow step." },
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Two step workflow",
      stepsJson: [
        { id: "draft", name: "Draft", agentId, dependencies: [] },
        { id: "review", name: "Review", agentId: qaAgentId, dependencies: ["draft"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-WF-1",
      title: "Draft workflow output",
      status: "in_progress",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: workflowRunId,
    });
    await db.insert(workflowStepRuns).values([
      {
        id: completedStepRunId,
        workflowRunId,
        stepId: "draft",
        issueId,
        status: "running",
        startedAt: new Date(),
      },
      {
        id: followupStepRunId,
        workflowRunId,
        stepId: "review",
        issueId: null,
        status: "pending",
      },
    ]);

    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const deadline = Date.now() + 5_000;
    let stepRuns: (typeof workflowStepRuns.$inferSelect)[] = [];
    while (Date.now() < deadline) {
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
      const draft = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
      const review = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);
      if (draft?.status === "completed" && review?.issueId) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const draftStep = stepRuns.find((stepRun) => stepRun.id === completedStepRunId);
    const reviewStep = stepRuns.find((stepRun) => stepRun.id === followupStepRunId);

    expect(draftStep).toEqual(
      expect.objectContaining({
        status: "completed",
        issueId,
      }),
    );
    expect(draftStep?.completedAt).toBeInstanceOf(Date);
    expect(reviewStep).toEqual(
      expect.objectContaining({
        status: "pending",
        issueId: expect.any(String),
      }),
    );
    const reviewIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewStep!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(reviewIssue).toEqual(
      expect.objectContaining({
        assigneeAgentId: qaAgentId,
        originKind: "workflow_execution",
        originRunId: workflowRunId,
        status: "todo",
      }),
    );
  });

  it("does not treat a PLAN decision comment as authority when heartbeat auto-completes the planning issue", async () => {
    // Structured authority only: Markdown/JSON decision comments are display-only after 655e889.
    // Heartbeat may still complete the checked-out PLAN issue, but must not materialize plans/PAQO.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await db.insert(issueComments).values({
        companyId,
        issueId: planningIssueId,
        authorAgentId: ownerAgentId,
        body: decisionComment(decision),
      });
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    expect(comments.map((comment) => comment.body).join("\n")).toContain("### Mission owner plan decision");

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans.filter((candidate) => candidate.status === "active")).toHaveLength(0);

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(0);
    const missionRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(missionRuns).toHaveLength(0);
  });

  it("does not treat adapter-captured PLAN decision output as plan materialization authority", async () => {
    // Captured PLAN decision comments may remain for display/audit, but stdout/comment JSON is
    // not control-plane authority and must not create active plans or PAQO workflows.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const sourceWorkflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Plan the mission." },
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: sourceWorkflowDefinitionId,
      companyId,
      name: "Source smoke workflow",
    });
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "[PLAN] Planning mission",
      status: "in_progress",
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
    });

    const decision = validOwnerPlanDecision(missionId, sourceWorkflowDefinitionId);
    executeSpy.mockImplementation(async ({ runId, onLog }) => {
      await db
        .update(issues)
        .set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, planningIssueId));
      await onLog("stdout", `${JSON.stringify({
        type: "result",
        subtype: "success",
        result: `Planning complete.\n\n${decisionComment(decision)}\n\nSummary: proceed.`,
      })}\n`);
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      ownerAgentId,
      "timer",
      { taskKey: `issue:${planningIssueId}`, issueId: planningIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await waitForIssueStatus(
      db,
      planningIssueId,
      (issue) => issue.status === "done" && issue.checkoutRunId === null && issue.executionRunId === null,
    );

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, planningIssueId));
    const commentBodies = comments.map((comment) => comment.body).join("\n\n");
    expect(commentBodies).toContain("### Captured PLAN decision output");
    expect(commentBodies).toContain("### Mission owner plan decision");

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans.filter((candidate) => candidate.status === "active")).toHaveLength(0);
    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(0);
    const missionRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));
    expect(missionRuns).toHaveLength(0);
  });

  registerHeartbeatFailureClassificationCase();

  it("does not queue the same adapter fallback again after a provider model parameter failure", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Guard",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {
        command: "primary-agent",
        fallbackCommand: "fallback-agent",
        fallback: { maxAttempts: 2, triggers: ["exit_error"] },
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Run guarded fallback",
      status: "todo",
      assigneeAgentId: agentId,
    });

    executeSpy.mockImplementationOnce(async () =>
      failedAdapterResult({
        errorMessage: "Claude run failed: subtype=success: API Error: 400 Param Incorrect",
        provider: "anthropic",
        model: "mimo-v2.5-pro-ultraspeeed[1m]",
        resultJson: {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 400,
          result: "API Error: 400 Param Incorrect",
        },
      }),
    );

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      {
        taskKey: `issue:${issueId}`,
        issueId,
        wakeReason: "adapter_fallback",
        fallbackOfRunId: randomUUID(),
        fallbackAttempt: 1,
        fallbackCommand: "fallback-agent",
      },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");

    const fallbackRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, finalized.id));
    expect(fallbackRuns).toHaveLength(0);

    const deadline = Date.now() + 1_000;
    let sawSuppressedEvent = false;
    while (Date.now() < deadline && !sawSuppressedEvent) {
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finalized.id));
      sawSuppressedEvent = events.some((event) => event.message.includes("adapter fallback suppressed"));
      if (!sawSuppressedEvent) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sawSuppressedEvent).toBe(true);
  });

  it("queues adapter fallback when adapter execution throws before returning a result", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let fallbackConfig: Record<string, unknown> | null = null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Throw",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {
        command: "opencode",
        model: "zai-coding-plan/glm-5.2",
        fallback: {
          command: "opencode",
          model: "openai/gpt-5.4-mini",
          maxAttempts: 1,
          triggers: ["run_failed"],
        },
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      title: "Run fallback after adapter throw",
      status: "todo",
      assigneeAgentId: agentId,
    });

    executeSpy
      .mockImplementationOnce(async () => {
        throw new Error("`opencode models` timed out after 20s.");
      })
      .mockImplementationOnce(async ({ config }) => {
        fallbackConfig = structuredClone(config) as Record<string, unknown>;
        return successfulAdapterResult();
      });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, wakeReason: "assignment" },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.error).toContain("opencode models");

    const deadline = Date.now() + 5_000;
    let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
    while (Date.now() < deadline && !fallbackRun) {
      fallbackRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, finalized.id))
        .then((rows) => rows[0] ?? null);
      if (!fallbackRun) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(fallbackRun).toBeTruthy();
    expect(fallbackRun?.contextSnapshot).toMatchObject({
      fallbackOfRunId: finalized.id,
      fallbackReason: "run_failed",
      fallbackAttempt: 1,
      fallbackCommand: "opencode",
      fallbackModel: "openai/gpt-5.4-mini",
      wakeReason: "adapter_fallback",
    });

    const fallbackFinalized = await waitForRunTerminal(heartbeat, fallbackRun!.id);
    expect(fallbackFinalized.status).toBe("succeeded");
    expect(fallbackConfig).toMatchObject({
      command: "opencode",
      model: "openai/gpt-5.4-mini",
    });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, finalized.id));
    expect(events.some((event) => event.message.includes("queued fallback"))).toBe(true);
  });

  registerHeartbeatRootPlanIssueCases(heartbeatBudgetCaseContext);
  registerHeartbeatOversightTimeoutCases(heartbeatBudgetCaseContext);
  registerHeartbeatChildOutputCases(heartbeatBudgetCaseContext);
  registerHeartbeatArtifactChildCases(heartbeatBudgetCaseContext);
  registerHeartbeatWorkProductAuthorityCases(heartbeatBudgetCaseContext);
  registerHeartbeatArtifactMarkerCases(heartbeatBudgetCaseContext);
  registerHeartbeatWorkProductPathClaimsCases(heartbeatBudgetCaseContext);

  it("does not auto-register ARTIFACT paths for audit issues even when an output contract is present", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const workProductRoot = "/srv/papercompany/projects/research-company/produced_work";
    const outputDir = `${workProductRoot}/missions/${missionId}/runs/${workflowRunId}/steps/audit-tech-scout-coverage`;
    const artifactPath = `${outputDir}/audit.json`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coverage Auditor",
      role: "auditor",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Audit upstream workProducts." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-AUDIT",
      title: "Audit source coverage",
      description: [
        "Deliverable output (use exactly this directory):",
        `- ${outputDir}`,
        "- If you create a separate audit artifact, finish with: [ARTIFACT]: <absolute path>.",
      ].join("\n"),
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", `Coverage audit passed.\n[ARTIFACT]: ${artifactPath}\n`);
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { taskKey: `issue:${issueId}`, issueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      issueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("done");

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("workProduct registration missing"))).toBe(false);
  });

  registerHeartbeatValidatorStdoutCases(heartbeatBudgetCaseContext);
  registerHeartbeatVerdictLedgerCases(heartbeatBudgetCaseContext);
  registerHeartbeatValidationGateScopeCases(heartbeatBudgetCaseContext);
  registerHeartbeatToolLimitAndLeadGateCases(heartbeatBudgetCaseContext);
  registerHeartbeatContextBudgetRotationCases(heartbeatBudgetCaseContext);
  registerHeartbeatBroadScanInterceptionCases(heartbeatBudgetCaseContext);
  registerHeartbeatBootstrapAndTokenAuthorityCases(heartbeatBudgetCaseContext);

  it("attaches a server-computed step input manifest before adapter execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:manifest";
    const runtimeServiceId = randomUUID();
    const issueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      companyKind: "maintenance",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Manifest issue",
      description: "사용자가 불편하다고만 전달했고 대상 시스템, 증상, 발생 시간이 빠짐",
      status: "todo",
    });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts and ../secret.env",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [{
          id: runtimeServiceId,
          scopeType: "run",
          scopeId: "run-scope",
          serviceName: "api",
          status: "running",
          lifecycle: "ephemeral",
          port: 4100,
          url: "http://localhost:4100",
          healthStatus: "healthy",
        }],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId, note: "hello" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const executionContext = executeSpy.mock.calls[0]?.[0] as { runtime: { taskKey: string | null } };
    expect(executionContext.runtime.taskKey).toBe(taskKey);
    expect(invocationContext).toBeDefined();
    if (!invocationContext) {
      throw new Error("Expected adapter invocation context to be captured");
    }
    const adapterVisibleContext = invocationContext;
    expect(adapterVisibleContext.paperclipMaintenanceDecision).toEqual(
      expect.objectContaining({
        recommendedNextAction: "request_missing_input",
        suggestedStatus: "blocked",
        requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
        roleContext: expect.objectContaining({
          roles: expect.arrayContaining([
            expect.objectContaining({ id: "customer_response" }),
            expect.objectContaining({ id: "maintenance_triage" }),
            expect.objectContaining({ id: "vendor_handoff" }),
            expect.objectContaining({ id: "approver" }),
            expect.objectContaining({ id: "incident_owner" }),
            expect.objectContaining({ id: "srb_sync", kind: "system" }),
          ]),
          questions: expect.arrayContaining([
            expect.stringMatching(/role/i),
            expect.stringMatching(/responsibility\/authority/i),
            expect.stringMatching(/rationale|override/i),
            expect.stringMatching(/hard-stop|observation|escalation/i),
          ]),
        }),
      }),
    );
    const missingInputAuditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(missingInputAuditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "maintenance_decision_evaluated",
          entityType: "issue",
          entityId: issueId,
          agentId,
          runId: run!.id,
          details: expect.objectContaining({
            issueId,
            runId: run!.id,
            recommendedNextAction: "request_missing_input",
            suggestedStatus: "blocked",
            requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
          }),
        }),
      ]),
    );
    expect(adapterVisibleContext.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        version: 1,
        taskKey,
        issueId,
        allowedContextKeys: Object.keys(adapterVisibleContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        guardrails: expect.objectContaining({
          broadScanAllowed: false,
          allowedSearchScopes: [],
        }),
        inputs: expect.objectContaining({
          workspace: {
            available: true,
            source: "agent_home",
            workspaceId: null,
            projectId: null,
          },
          workspaceHints: { available: false, count: 0 },
          runtimeServiceIntents: { available: false, count: 0 },
          runtimeServices: { available: false, count: 0, primaryUrl: null },
          fileViews: { available: true, count: 1, source: "wake_comment" },
          maintenanceDecision: expect.objectContaining({
            available: true,
            recommendedNextAction: "request_missing_input",
            suggestedStatus: "blocked",
            requiredInputs: expect.arrayContaining(["symptom", "timeWindow"]),
            roleContext: expect.objectContaining({
              roles: expect.arrayContaining([expect.objectContaining({ id: "srb_sync", kind: "system" })]),
              questions: expect.arrayContaining([expect.stringMatching(/rationale|override/i)]),
            }),
          }),
          sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
        }),
      }),
    );
    expect(adapterVisibleContext.paperclipFileViews).toEqual([
      {
        workspaceId: null,
        relativePath: "src/server.ts",
        source: "wake_comment",
        exists: false,
        contentHash: null,
      },
    ]);
    const persistedContext = finalized.contextSnapshot ?? {};
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        taskKey,
        allowedContextKeys: Object.keys(persistedContext)
          .filter((key) => key !== "paperclipStepInputManifest")
          .sort(),
        inputs: expect.objectContaining({
          runtimeServices: {
            available: true,
            count: 1,
            primaryUrl: "http://localhost:4100",
          },
          fileViews: {
            available: true,
            count: 1,
            source: "wake_comment",
          },
        }),
      }),
    );
  });

  registerHeartbeatMaintenanceActivityCases(heartbeatBudgetCaseContext);
  registerHeartbeatStepToolContractCases(heartbeatBudgetCaseContext);
  registerHeartbeatPromptAndToolGateCases(heartbeatBudgetCaseContext);
  registerHeartbeatKnowledgeContractCases(heartbeatBudgetCaseContext);

  it("does not attach file views when wakeCommentId belongs to a different issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "manual:file-view-mismatch";
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const wakeCommentId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Manifest Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Follow the heartbeat.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Target issue",
        status: "todo",
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
      },
    ]);
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId: otherIssueId,
      authorUserId: "user-1",
      body: "Please inspect src/server.ts",
    });

    executeSpy.mockImplementationOnce(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey, issueId, wakeCommentId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipFileViews).toBeUndefined();
    expect(finalized.contextSnapshot?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          fileViews: {
            available: false,
            count: 0,
            source: null,
          },
        }),
      }),
    );
  });

});

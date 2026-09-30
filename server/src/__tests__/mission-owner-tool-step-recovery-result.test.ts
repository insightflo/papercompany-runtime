import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowTransitionEvents,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  loadToolRecoveryScenarioRows,
  seedToolRecoveryScenario,
  type ToolRecoveryScenario,
} from "./helpers/tool-recovery-scenario.js";
import { missionService } from "../services/missions.js";
import { resolveNativeToolStepRecoveryResult } from "../services/missions/tool-step-recovery-result.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { completeWorkflowToolStepFromResult, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

// Production path for recovery wakeups:
// supervision / tool retry → wakeExistingWorkflowStepIssue (or assignment wake)
// → queueIssueAssignmentWakeup({ heartbeat: heartbeatService(db) }) → heartbeat.wakeup(...).
// heartbeatService mock alone does not always bind under this file's import graph, so real
// enqueueWakeup runs (company_secrets / mission_agent_runtimes FK side effects). Force the
// assignment-wakeup helper to use the test spy while keeping real guard/payload logic.
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission owner tool recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("resolveNativeToolStepRecoveryResult", () => {
  it("rejects comment success claims — structured completion is required (fail-closed)", () => {
    const result = resolveNativeToolStepRecoveryResult({
      comments: [
        "### Native tool step retry failed",
        [
          "### Native tool step recovery result",
          "Status: success",
          "Exit code: 0",
          "[ARTIFACT]: /tmp/recovered-again.json",
        ].join("\n"),
      ],
      artifactExists: () => true,
    });

    // NL success/comment claims are no longer authority — a failed step completes only via the
    // structured /workflow/complete or registered workProduct path.
    expect(result).toBeNull();
  });

});

describeEmbeddedPostgres("mission owner issue-less tool recovery result", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-recovery-result-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    heartbeatWakeup.mockResolvedValue({ id: "test-heartbeat-run" });
  });

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    for (const tempRoot of tempRoots) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRecoveryScenario(input: {
    readonly artifactExists: boolean;
  }): Promise<ToolRecoveryScenario> {
    const scenario = await seedToolRecoveryScenario({ db, artifactExists: input.artifactExists });
    tempRoots.push(scenario.tempRoot);
    return scenario;
  }

  async function runSupervision(companyId: string) {
    return missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-06T05:07:00.000Z"),
      applyOwnerDecisionActions: true,
    });
  }
  async function submitRecoverArtifactDecision(
    scenario: ToolRecoveryScenario,
    options?: { readonly reworkTargetRef?: string },
  ) {
    const [failedStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.stepRunId));
    const [recoveryIssue] = await db.select({ missionId: issues.missionId, originId: issues.originId })
      .from(issues)
      .where(eq(issues.id, scenario.recoveryIssueId))
      .limit(1);
    if (!recoveryIssue?.missionId) throw new Error("recovery scenario is missing mission scope");
    const [mission] = await db
      .select({ ownerAgentId: missions.ownerAgentId })
      .from(missions)
      .where(eq(missions.id, recoveryIssue.missionId))
      .limit(1);
    if (!mission) throw new Error("recovery scenario is missing mission owner");
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: scenario.companyId,
      agentId: mission.ownerAgentId,
      issueId: scenario.recoveryIssueId,
      status: "succeeded",
      startedAt: new Date("2026-07-06T05:00:00.000Z"),
      finishedAt: new Date("2026-07-06T05:01:00.000Z"),
      createdAt: new Date("2026-07-06T05:01:00.000Z"),
    });
    await recordMissionOwnerDecision({
      db,
      issue: { id: scenario.recoveryIssueId, companyId: scenario.companyId, missionId: recoveryIssue.missionId },
      submission: {
        decision: "recover_artifact",
        recoveryTarget: { kind: "tool_step", workflowRunId: scenario.workflowRunId, stepRunId: scenario.stepRunId,
          expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: failedStep.lastDispatchRequestId },
        sourceIssueRef: scenario.recoveryIssueId,
        ...(options?.reworkTargetRef ? { reworkTargetRef: options.reworkTargetRef } : {}),
      },
      sourceIssueId: recoveryIssue.originId,
      heartbeatRunId,
    });
  }

  async function registerWorkflowArtifact(scenario: ToolRecoveryScenario, issueId = scenario.recoveryIssueId) {
    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId: scenario.companyId,
      issueId,
      type: "file",
      provider: "local",
      title: "Recovered stockflow",
      externalId: scenario.artifactPath,
      status: "active",
      isPrimary: true,
      metadata: { path: scenario.artifactPath },
    });
    await db.insert(activityLog).values({
      companyId: scenario.companyId,
      actorType: "agent",
      actorId: "workflow-agent-api",
      action: "issue.workflow_artifact_registered",
      entityType: "issue",
      entityId: issueId,
      details: { workProductId },
    });
  }

  // Producer issue = the workflow step issue the recovered artifact was registered on. It is a
  // mission peer of the recovery (owner action) issue, not the recovery/source issue itself.
  async function seedMissionProducerIssue(
    scenario: ToolRecoveryScenario,
    options: { readonly missionScope: "same" | "other"; readonly identifier?: string },
  ): Promise<string> {
    const [recoveryIssue] = await db
      .select({ missionId: issues.missionId })
      .from(issues)
      .where(eq(issues.id, scenario.recoveryIssueId))
      .limit(1);
    if (!recoveryIssue?.missionId) throw new Error("recovery scenario is missing mission scope");
    const [mission] = await db
      .select({ ownerAgentId: missions.ownerAgentId })
      .from(missions)
      .where(eq(missions.id, recoveryIssue.missionId))
      .limit(1);
    if (!mission) throw new Error("recovery scenario is missing mission owner");
    let producerMissionId = recoveryIssue.missionId;
    if (options.missionScope === "other") {
      producerMissionId = randomUUID();
      await db.insert(missions).values({
        id: producerMissionId,
        companyId: scenario.companyId,
        ownerAgentId: mission.ownerAgentId,
        title: "Producer issue other mission",
        status: "active",
      });
    }
    const producerIssueId = randomUUID();
    await db.insert(issues).values({
      id: producerIssueId,
      companyId: scenario.companyId,
      missionId: producerMissionId,
      assigneeAgentId: mission.ownerAgentId,
      originKind: "workflow_step",
      status: "done",
      title: "Collect US stockflow (producer)",
      ...(options.identifier ? { identifier: options.identifier } : {}),
    });
    return producerIssueId;
  }

  it("does not authorize a comment-only recovery claim when an active workProduct exists", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    await registerWorkflowArtifact(scenario);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));

    const result = await runSupervision(scenario.companyId);

    expect(result.missions[0]?.appliedActions).toEqual([]);
    expect(result.missions[0]?.recoveryOutcomes?.[0]).toMatchObject({ kind: "no_op", reason: "target_missing" });
  });
  it.each([false, true])("completes structured artifact recovery, resume fence=%s", async (resumed) => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    if (resumed) await db.update(workflowStepRuns).set({ lastDispatchRequestId: randomUUID(), metadata: { resumeRequestId: randomUUID(), toolResult: { success: false } } }).where(eq(workflowStepRuns.id, scenario.stepRunId));
    await submitRecoverArtifactDecision(scenario);
    await registerWorkflowArtifact(scenario);

    const result = await runSupervision(scenario.companyId);
    const { stepRuns } = await loadToolRecoveryScenarioRows(db, scenario);

    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "native_tool_step_recovery_result", artifactPath: scenario.artifactPath }),
    ]));
    expect(stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId)?.status).toBe("completed");
  });

  it("completes a failed tool step when recover_artifact reworkTargetRef points at the mission producer issue holding the registered workProduct", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    const producerIssueId = await seedMissionProducerIssue(scenario, { missionScope: "same" });
    await submitRecoverArtifactDecision(scenario, { reworkTargetRef: producerIssueId });
    await registerWorkflowArtifact(scenario, producerIssueId);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));

    const result = await runSupervision(scenario.companyId);
    const { stepRuns } = await loadToolRecoveryScenarioRows(db, scenario);

    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "native_tool_step_recovery_result", artifactPath: scenario.artifactPath }),
    ]));
    expect(stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId)?.status).toBe("completed");
  });

  it("matches the mission producer issue by identifier for recover_artifact reworkTargetRef", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    const producerIssueId = await seedMissionProducerIssue(scenario, { missionScope: "same", identifier: "TRP-0007" });
    await submitRecoverArtifactDecision(scenario, { reworkTargetRef: "trp-0007" });
    await registerWorkflowArtifact(scenario, producerIssueId);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));

    const result = await runSupervision(scenario.companyId);
    const { stepRuns } = await loadToolRecoveryScenarioRows(db, scenario);

    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "native_tool_step_recovery_result", artifactPath: scenario.artifactPath }),
    ]));
    expect(stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId)?.status).toBe("completed");
  });

  it("rejects recover_artifact when reworkTargetRef points at an issue outside the recovery mission", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    const producerIssueId = await seedMissionProducerIssue(scenario, { missionScope: "other" });
    await submitRecoverArtifactDecision(scenario, { reworkTargetRef: producerIssueId });
    await registerWorkflowArtifact(scenario, producerIssueId);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await runSupervision(scenario.companyId);
    expect(result.missions[0]?.appliedActions).toEqual([]);
    expect(result.missions[0]?.recoveryOutcomes?.[0]).toMatchObject({ kind: "no_op", reason: "missing_artifact" });
  });

  it("rejects recover_artifact when the mission producer issue has no official registered workProduct", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    const producerIssueId = await seedMissionProducerIssue(scenario, { missionScope: "same" });
    await submitRecoverArtifactDecision(scenario, { reworkTargetRef: producerIssueId });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await runSupervision(scenario.companyId);
    expect(result.missions[0]?.appliedActions).toEqual([]);
    expect(result.missions[0]?.recoveryOutcomes?.[0]).toMatchObject({ kind: "no_op", reason: "missing_artifact" });
  });

  it("requires evidence instead of retrying when recover_artifact has no official workProduct", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: false });
    await submitRecoverArtifactDecision(scenario);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));

    const result = await runSupervision(scenario.companyId);

    expect(result.missions[0]?.appliedActions).toEqual([]);
    expect(result.missions[0]?.recoveryOutcomes?.[0]).toMatchObject({ kind: "no_op", reason: "missing_artifact" });
  });

  it("does not overwrite completed tool results when terminal recovery is requested", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    await db.update(workflowStepRuns)
      .set({
        status: "completed",
        metadata: { toolResult: { success: true, stdout: "original tool result" } },
      })
      .where(eq(workflowStepRuns.id, scenario.stepRunId));

    await completeWorkflowToolStepFromResult(db, {
      companyId: scenario.companyId,
      stepRunId: scenario.stepRunId,
      success: true,
      stdout: "owner recovery should not overwrite",
      allowTerminalRecovery: true,
    });

    const { stepRuns } = await loadToolRecoveryScenarioRows(db, scenario);
    const stepAfter = stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId);
    expect(stepAfter?.metadata).toEqual({
      toolResult: { success: true, stdout: "original tool result" },
    });
  });

  it("preserves failure when neither an explicit target nor artifact authority exists", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: false });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await runSupervision(scenario.companyId);

    expect(result.missions[0]?.appliedActions).toEqual([]);

    const { stepRuns, run } = await loadToolRecoveryScenarioRows(db, scenario);
    const retriedStep = stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId);
    const downstreamStep = stepRuns.find((stepRun) => stepRun.id === scenario.downstreamStepRunId);
    expect(retriedStep).toEqual(expect.objectContaining({
      status: "failed",
      issueId: null,
    }));
    expect(downstreamStep?.status).toBe("skipped");
    expect(run?.status).toBe("failed");
  });
});

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
import { completeWorkflowToolStepFromResult, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
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
  it("ignores stale success evidence when a newer native retry boundary exists", () => {
    const result = resolveNativeToolStepRecoveryResult({
      comments: [
        [
          "### Native tool step recovery result",
          "Status: success",
          "Exit code: 0",
          "[ARTIFACT]: /tmp/recovered.json",
        ].join("\n"),
        "### Native tool step retry applied",
      ],
      artifactExists: () => true,
    });

    expect(result).toBeNull();
  });

  it("uses the latest success evidence after a native retry boundary", () => {
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

    expect(result).toEqual({ artifactPath: "/tmp/recovered-again.json" });
  });

  it("rejects success claims when the artifact path does not exist", () => {
    const result = resolveNativeToolStepRecoveryResult({
      comments: [
        [
          "### Native tool step recovery result",
          "Status: success",
          "Exit code: 0",
          "[ARTIFACT]: /tmp/missing-recovered.json",
        ].join("\n"),
      ],
      artifactExists: () => false,
    });

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

  it("applies completed owner-action recovery evidence through the workflow tool result path", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: true });
    const result = await missionService(db).runActiveMissionOwnerSupervision({
      companyId: scenario.companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-06T05:07:00.000Z"),
      applyOwnerDecisionActions: true,
    });

    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("tool_step_recovery_result_applied"),
    ]));
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "native_tool_step_recovery_result",
        ownerActionIssueId: scenario.recoveryIssueId,
        workflowRunId: scenario.workflowRunId,
        stepId: "collect-us-stockflow",
        stepRunId: scenario.stepRunId,
        artifactPath: scenario.artifactPath,
      }),
    ]));

    const { stepRuns, run, commentText } = await loadToolRecoveryScenarioRows(db, scenario);
    const stepAfter = stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId);
    const downstreamStep = stepRuns.find((stepRun) => stepRun.id === scenario.downstreamStepRunId);
    expect(stepAfter).toEqual(expect.objectContaining({
      status: "completed",
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
    }));
    expect(stepAfter?.metadata).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        success: true,
        stdout: `Mission owner recovery artifact: ${scenario.artifactPath}`,
        exitCode: 0,
        recoveredBy: "owner-action",
      }),
    }));
    expect(downstreamStep).toEqual(expect.objectContaining({
      status: "pending",
    }));
    expect(downstreamStep?.issueId).toEqual(expect.any(String));
    expect(run).toEqual(expect.objectContaining({ status: "running" }));
    expect(commentText).toContain("native-tool-step-recovery-result-applied");
    expect(commentText).not.toContain("native-tool-step-retry-applied");
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

  it("falls back to native retry when owner recovery evidence has no artifact proof", async () => {
    const scenario = await seedRecoveryScenario({ artifactExists: false });
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    const result = await runSupervision(scenario.companyId);

    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "native_tool_step_retry",
        ownerActionIssueId: scenario.recoveryIssueId,
        workflowRunId: scenario.workflowRunId,
        stepId: "collect-us-stockflow",
        stepRunId: scenario.stepRunId,
        resultStatus: "running",
      }),
    ]));

    const { stepRuns, run, commentText } = await loadToolRecoveryScenarioRows(db, scenario);
    const retriedStep = stepRuns.find((stepRun) => stepRun.id === scenario.stepRunId);
    const downstreamStep = stepRuns.find((stepRun) => stepRun.id === scenario.downstreamStepRunId);
    expect(retriedStep).toEqual(expect.objectContaining({
      status: "running",
      issueId: null,
    }));
    expect(downstreamStep).toEqual(expect.objectContaining({
      status: "pending",
      issueId: null,
      startedAt: null,
      completedAt: null,
    }));
    expect(run).toEqual(expect.objectContaining({ status: "running" }));
    expect(commentText).toContain("native-tool-step-retry-applied");
    expect(commentText).not.toContain("native-tool-step-recovery-result-applied");
  });
});

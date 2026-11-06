import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagFailureGateCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("resets legacy failed unlaunched downstream rows and launches them after prerequisites recover", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const prepareIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-legacy-downstream" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Legacy Downstream Recovery",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Recovery Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Legacy Downstream Recovery Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Legacy Downstream Recovery Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "approve", name: "Approve", agentId, dependencies: ["prepare"], description: "Approve the work" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-06-18T06:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: prepareIssueId,
      companyId,
      missionId,
      title: "Legacy Downstream Recovery Workflow: Prepare",
      status: "done",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T06:00:00.000Z"),
      completedAt: new Date("2026-06-18T06:05:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "prepare",
        issueId: prepareIssueId,
        status: "completed",
        startedAt: new Date("2026-06-18T06:00:00.000Z"),
        completedAt: new Date("2026-06-18T06:05:00.000Z"),
      },
      {
        workflowRunId: runId,
        stepId: "approve",
        issueId: null,
        status: "failed",
        startedAt: null,
        completedAt: new Date("2026-06-18T06:06:00.000Z"),
        lastDispatchAttemptAt: null,
      },
    ]);

    const result = await syncWorkflowRunForIssue(db, prepareIssueId);

    expect(result?.status).toBe("running");
    const stepRows = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const approveStepRun = stepRows.find((stepRun) => stepRun.stepId === "approve");
    expect(approveStepRun?.status).toBe("pending");
    expect(approveStepRun?.issueId).toBeTruthy();
    const [approveIssue] = await db.select().from(issues).where(eq(issues.id, approveStepRun!.issueId!));
    expect(approveIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
  });

  it("[P2 control-flow] failure-gated step activates on predecessor failure, false-branch is skipped, and skip does not flap across syncs", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const produceIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-control-flow-if" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow IF",
      issuePrefix: `CF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Control Flow Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Conditional IF Mission",
      status: "active",
    });
    // Non-dynamic static DAG (이름이 tech-* 가 아니라 resetUnlaunchedTerminalStepRuns 가 실행됨 → sentinel 검증).
    // produce[root] → on-failure(when:failure), on-success(when:success). 둘 다 conditional edge 만 보유.
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Conditional IF Activation",
      stepsJson: [
        { id: "produce", name: "Produce", agentId, dependencies: [], description: "Produce artifact" },
        {
          id: "on-failure",
          name: "Recover on failure",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "produce", when: "failure" }],
          description: "Run only when produce fails",
        },
        {
          id: "on-success",
          name: "Continue on success",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "produce", when: "success" }],
          description: "Run only when produce succeeds",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-06-18T07:00:00.000Z"),
    });
    // produce 를 failed 상태로 seed (issue blocked → stepRun failed).
    await db.insert(issues).values({
      id: produceIssueId,
      companyId,
      missionId,
      title: "Conditional IF Activation: Produce",
      status: "blocked",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T07:01:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "produce",
        issueId: produceIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T07:01:00.000Z"),
        completedAt: new Date("2026-06-18T07:05:00.000Z"),
      },
      { workflowRunId: runId, stepId: "on-failure", issueId: null, status: "pending" },
      { workflowRunId: runId, stepId: "on-success", issueId: null, status: "pending" },
    ]);

    // 1차 sync: produce failed → on-failure 발화(FAILURE gate), on-success 는 false-branch → skipped.
    const first = await syncWorkflowRunForIssue(db, produceIssueId);
    expect(first?.status).toBe("running"); // on-failure 가 막 발화했으므로 running

    const rows1 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const byId1 = new Map(rows1.map((row) => [row.stepId, row]));
    expect(byId1.get("produce")?.status).toBe("failed");
    expect(byId1.get("on-failure")?.status).toBe("pending");
    expect(byId1.get("on-failure")?.issueId).toBeTruthy(); // failure-gated 발화 확인
    expect(byId1.get("on-success")?.status).toBe("skipped"); // false-branch skip
    expect((byId1.get("on-success")?.metadata as Record<string, unknown> | null)?.controlFlowSkipped).toBe(true);

    // 2차 sync: sentinel 덕분에 resetUnlaunchedTerminalStepRuns 가 on-success 를 skipped→pending 으로 부활시키지 않는다(가즈아 flap/hang 회귀 가드).
    await syncWorkflowRunForIssue(db, produceIssueId);
    const rows2 = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const onSuccess2 = rows2.find((row) => row.stepId === "on-success");
    expect(onSuccess2?.status).toBe("skipped"); // 여전히 skipped — 부활 없음
    const onFailure2 = rows2.find((row) => row.stepId === "on-failure");
    expect(onFailure2?.status).toBe("pending"); // 발화 유지
    expect(onFailure2?.issueId).toBeTruthy();
  });
}

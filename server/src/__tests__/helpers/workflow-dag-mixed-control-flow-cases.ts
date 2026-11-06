import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagMixedControlFlowCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  it("[P2 control-flow] mixed workflow: legacy step downstream of a failed pred is skipped (not stuck pending) so the run is not hung", async () => {
    const db = getDb();
    // 회귀 가드: conditional 이 하나라도 있는 워크플로에선 도달 불가 legacy step 도 skip 되어야 한다.
    // 이전엔 legacy-down 이 pending 에 갇혀 finalize 가 allStepsTerminal 에 도달 못 해 60min reconciler kill(가즈아 hang)을 유발했다.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const produceIssueId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-control-flow-mixed" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Mixed",
      issuePrefix: `CM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mixed Flow Agent",
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
      title: "Conditional Mixed Mission",
      status: "active",
    });
    // produce[root] → on-failure(conditional when:failure), legacy-down(LEGACY dependencies:[produce]).
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Conditional IF Mixed",
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
        { id: "legacy-down", name: "Legacy downstream", agentId, dependencies: ["produce"], description: "Legacy dep on produce" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date("2026-06-18T08:00:00.000Z"),
    });
    await db.insert(issues).values({
      id: produceIssueId,
      companyId,
      missionId,
      title: "Conditional IF Mixed: Produce",
      status: "blocked",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: runId,
      originRunId: runId,
      startedAt: new Date("2026-06-18T08:01:00.000Z"),
    });
    await db.insert(workflowStepRuns).values([
      {
        workflowRunId: runId,
        stepId: "produce",
        issueId: produceIssueId,
        status: "failed",
        startedAt: new Date("2026-06-18T08:01:00.000Z"),
        completedAt: new Date("2026-06-18T08:05:00.000Z"),
      },
      { workflowRunId: runId, stepId: "on-failure", issueId: null, status: "pending" },
      { workflowRunId: runId, stepId: "legacy-down", issueId: null, status: "pending" },
    ]);

    await syncWorkflowRunForIssue(db, produceIssueId);
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const byId = new Map(rows.map((row) => [row.stepId, row]));
    expect(byId.get("produce")?.status).toBe("failed");
    expect(byId.get("on-failure")?.status).toBe("pending");
    expect(byId.get("on-failure")?.issueId).toBeTruthy(); // failure-gated 발화
    // 핵심 회귀 단정: legacy-down 은 pending 에 갇히지 않고 skipped 로 마감(도달 불가).
    expect(byId.get("legacy-down")?.status).toBe("skipped");
    expect((byId.get("legacy-down")?.metadata as Record<string, unknown> | null)?.controlFlowSkipped).toBe(true);
  });
}

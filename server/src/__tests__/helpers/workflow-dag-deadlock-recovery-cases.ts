import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { companies, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { reconcileDeadlockedWorkflowRuns } from "../../services/workflow/reconciler.js";

export function registerWorkflowDagDeadlockRecoveryCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("deadlock fast-path: converges a legacy run with a failed predecessor and unreachable pending steps without waiting 60 min", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const linkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Deadlock Workflow Company",
      issuePrefix: `DL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "deadlock-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
        { id: "report", name: "Report", type: "agent", agentId: "", dependencies: ["synthesize"] },
      ],
    });
    // startedAt is 6 min ago -> past the 5-min deadlock settling gate, but far short
    // of the 60-min stuck gate. Only the deadlock fast-path can converge it.
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: linkedIssueId,
      companyId,
      identifier: "DL-1",
      title: "Report",
      // [B3] 회복 채널이 닫힌 종결(cancelled) 이슈 — 기존 deadlock 처리(skip + run failed 수렴)가 유지되는 회귀.
      status: "cancelled",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "synthesize", status: "pending" },
      { workflowRunId: runId, stepId: "report", status: "pending", issueId: linkedIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    expect(result).toEqual([
      expect.objectContaining({ runId, action: "recovered" }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("failed");

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const synthesize = steps.find((step) => step.stepId === "synthesize");
    expect(synthesize?.status).toBe("skipped");
    expect((synthesize?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);

    const report = steps.find((step) => step.stepId === "report");
    expect(report?.status).toBe("skipped");
    expect((report?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);

    // Terminal (cancelled) linked issue: existing deadlock handling preserved — the step is
    // skipped but the closed recovery channel is not re-blocked and no new comment is written.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, linkedIssueId));
    expect(storedIssue?.status).toBe("cancelled");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssueId));
    expect(comments).toHaveLength(0);
  });

  it("deadlock fast-path holds pending steps with non-terminal linked issues and keeps the recovery channel open", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const linkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Deadlock Hold Company",
      issuePrefix: `DH${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "deadlock-hold-workflow",
      stepsJson: [
        { id: "collect", name: "Collect", type: "agent", agentId: "", dependencies: [] },
        { id: "synthesize", name: "Synthesize", type: "agent", agentId: "", dependencies: ["collect"] },
        { id: "report", name: "Report", type: "agent", agentId: "", dependencies: ["synthesize"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "schedule",
      startedAt: new Date(Date.now() - 6 * 60 * 1000),
      completedAt: null,
    });
    await db.insert(issues).values({
      id: linkedIssueId,
      companyId,
      identifier: "DL-2",
      title: "Report",
      status: "todo",
      originKind: "workflow_execution",
      originId: runId,
    });
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect", status: "failed", completedAt: new Date() },
      { workflowRunId: runId, stepId: "synthesize", status: "pending" },
      { workflowRunId: runId, stepId: "report", status: "pending", issueId: linkedIssueId },
    ]);

    const result = await reconcileDeadlockedWorkflowRuns(db);

    // [B3] 회복 가능한(todo) 실행 이슈를 가진 pending 스텝은 최종 skip 으로 확정하지 않는다 —
    //   대기 사유를 구조화 결과로 남기고 run 종결도 보류한다.
    expect(result).toEqual([
      expect.objectContaining({ runId, action: "skipped", reason: expect.stringContaining("non-terminal") }),
    ]);
    const [storedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(storedRun?.status).toBe("running");
    expect(storedRun?.completedAt).toBeNull();

    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    // 이슈 없는 도달 불가 스텝은 기존대로 수렴한다(진짜 교착 수렴 보존).
    const synthesize = steps.find((step) => step.stepId === "synthesize");
    expect(synthesize?.status).toBe("skipped");
    expect((synthesize?.metadata as { controlFlowSkipped?: boolean })?.controlFlowSkipped).toBe(true);
    // 이슈 보유 스텝은 pending 유지.
    const report = steps.find((step) => step.stepId === "report");
    expect(report?.status).toBe("pending");

    // 회복 채널이 열려 있다 — 이슈 상태 변경/코멘트 없음.
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, linkedIssueId));
    expect(storedIssue?.status).toBe("todo");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssueId));
    expect(comments).toHaveLength(0);
  });
}

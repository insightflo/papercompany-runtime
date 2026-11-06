import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { createWorkflowBackedgeFixture } from "./workflow-backedge-fixture.js";

export function registerWorkflowDagQaLoopTerminalCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  const { seedBackEdgeLoopRun, submitQaVerdictEvidence } = createWorkflowBackedgeFixture(getDb, recordWorkflowVerdictForIssue);

  it("[P4 control-flow loop] keeps downstream steps pending while audit request_changes is still recoverable", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-audit-downstream" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const auditAgentId = randomUUID();
    const writerAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const auditIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Audit Loop Downstream",
      issuePrefix: `AD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Research Agent", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: auditAgentId, companyId, name: "Audit Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: writerAgentId, companyId, name: "Writer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Audit Back-edge Downstream Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "audit-back-edge-downstream",
      stepsJson: [
        {
          id: "collect-ai-news-evidence",
          name: "Collect bounded evidence",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "audit-source-coverage", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
          description: "Collect source evidence",
        },
        {
          id: "audit-source-coverage", qaType: "semantic",
          name: "Audit source coverage and confidence",
          agentId: auditAgentId,
          dependencies: ["collect-ai-news-evidence"],
          description: "Audit source coverage before synthesis",
        },
        {
          id: "synthesize-ai-news-report-draft",
          name: "Synthesize AI news report draft",
          agentId: writerAgentId,
          dependencies: ["audit-source-coverage"],
          description: "Write the report after audit passes",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-22T05:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "audit-back-edge-downstream: Collect bounded evidence", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-22T05:01:00.000Z"), completedAt: new Date("2026-06-22T05:05:00.000Z") },
      { id: auditIssueId, companyId, missionId, title: "audit-back-edge-downstream: Audit source coverage and confidence", status: "blocked", assigneeAgentId: auditAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-22T05:06:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "collect-ai-news-evidence", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-06-22T05:01:00.000Z"), completedAt: new Date("2026-06-22T05:05:00.000Z") },
      { workflowRunId: runId, stepId: "audit-source-coverage", issueId: auditIssueId, status: "failed", startedAt: new Date("2026-06-22T05:06:00.000Z"), completedAt: new Date("2026-06-22T05:10:00.000Z") },
      { workflowRunId: runId, stepId: "synthesize-ai-news-report-draft", status: "pending" },
    ]);
    await submitQaVerdictEvidence(auditIssueId, companyId, auditAgentId, "REQUEST_CHANGES", "2026-06-22T05:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "collect-ai-news-evidence")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "synthesize-ai-news-report-draft")!).toMatchObject({
      status: "pending",
      issueId: null,
    });
  });

  it("[P4 control-flow loop] cascades skips after QA cap exhaustion so the workflow fails instead of hanging pending", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const leadAgentId = randomUUID();
    const htmlAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop Exhausted Cascade",
      issuePrefix: `LX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: leadAgentId, companyId, name: "Lead Agent", role: "lead", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: htmlAgentId, companyId, name: "HTML Agent", role: "publisher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Exhausted Cascade Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-exhausted-cascade",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 1 }],
          description: "Produce the artifact",
        },
        { id: "qa-validate", qaType: "semantic", name: "Validate the produced artifact", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "lead-approval", name: "Lead approval", agentId: leadAgentId, dependencies: ["qa-validate"], description: "Approve validated artifact" },
        { id: "build-html", name: "Build HTML", agentId: htmlAgentId, dependencies: ["lead-approval"], description: "Build HTML artifact" },
        { id: "publish-html", name: "Publish HTML", agentId: htmlAgentId, dependencies: ["build-html"], description: "Publish HTML artifact" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T09:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-exhausted-cascade: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "back-edge-exhausted-cascade: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: 1, startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", startedAt: new Date("2026-06-18T09:03:00.000Z"), completedAt: new Date("2026-06-18T09:10:00.000Z") },
      { workflowRunId: runId, stepId: "lead-approval", status: "pending" },
      { workflowRunId: runId, stepId: "build-html", status: "pending" },
      { workflowRunId: runId, stepId: "publish-html", status: "pending" },
    ]);
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T09:10:00.000Z");

    await syncWorkflowRunForIssue(db, qaIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "completed",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "qa-validate")!.status).toBe("failed");
    expect(rows.find((row) => row.stepId === "lead-approval")!.status).toBe("skipped");
    expect(rows.find((row) => row.stepId === "build-html")!.status).toBe("skipped");
    expect(rows.find((row) => row.stepId === "publish-html")!.status).toBe("skipped");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
  });

  it("[P4 control-flow loop] bounded failure: cap exhausted with persistent QA reject → workflow fails (no infinite loop)", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-fail" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 1 });
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    // Sync 1: QA 반려 → producer rework 리셋(iter 0→1). maxIterations=1 이므로 이 한 번이 유일한 rework.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find((row) => row.stepId === "produce")!.iterationIndex).toBe(1);

    // producer rework 완료 시뮬레이션(verdict 07:10 이후).
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:30:00.000Z"), cancelledAt: null, startedAt: new Date("2026-06-18T07:11:00.000Z") }).where(eq(issues.id, producerIssueId));

    heartbeatWakeup.mockClear();
    await syncWorkflowRunForIssue(db, producerIssueId);
    const [qaIssueAfterRework] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssueAfterRework.status).toBe("blocked");
    expect(heartbeatWakeup).toHaveBeenCalledWith(qaAgentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: qaIssueId,
        mutation: "workflow_resume",
        workflowRunId: runId,
        stepId: "qa-validate",
        workflowStepRunId: expect.any(String),
      }),
    }));

    // QA 가 다시 반려(producer 07:30 이후). 이번엔 cap 초과라 producer 가 더 rework 못 한다.
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:40:00.000Z");
    await db.update(issues).set({ status: "blocked", completedAt: null, cancelledAt: null }).where(eq(issues.id, qaIssueId));

    // Sync 3: producer iter1 == cap → 리셋 안 함. QA failed → 워크플로 failed(무한 loop 아님).
    await syncWorkflowRunForIssue(db, producerIssueId);
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    expect(produce.iterationIndex).toBe(1); // cap 초과 없음
    expect(produce.status).toBe("completed");
    expect(rows.find((row) => row.stepId === "qa-validate")!.status).toBe("failed");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
  });
}

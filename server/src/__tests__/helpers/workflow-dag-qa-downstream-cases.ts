import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueComments, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { createWorkflowBackedgeFixture } from "./workflow-backedge-fixture.js";

export function registerWorkflowDagQaDownstreamCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  const { seedBackEdgeLoopRun, submitQaVerdictEvidence } = createWorkflowBackedgeFixture(getDb, recordWorkflowVerdictForIssue);

  it("[P4 control-flow loop] comments current dependency workProducts when requeueing QA after producer rework", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-refresh-qa" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    await db
      .update(issues)
      .set({
        description: [
          "Workflow execution boundary:",
          `- workflowRunId: ${runId}`,
          "- dependencyStepIds: [\"produce\"]",
          "Dependency issue inputs:",
          "- produce: old-producer (done) — Produce artifact",
          "  workProducts: none registered",
          "Dependency workProduct hard-stop:",
          "- produce: old-producer has no registered dependency workProduct.",
        ].join("\n"),
      })
      .where(eq(issues.id, qaIssueId));
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const reportPath = "/srv/papercompany/projects/research-company/produced_work/missions/rework-report.md";
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "file",
      provider: "local",
      externalId: reportPath,
      title: "rework-report.md",
      status: "active",
      isPrimary: true,
      metadata: { path: reportPath },
    });
    await db
      .update(issues)
      .set({
        status: "done",
        completedAt: new Date("2026-06-18T07:30:00.000Z"),
        cancelledAt: null,
        startedAt: new Date("2026-06-18T07:11:00.000Z"),
      })
      .where(eq(issues.id, producerIssueId));

    await syncWorkflowRunForIssue(db, producerIssueId);

    const [qaIssueAfterRequeue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssueAfterRequeue.status).toBe("blocked");
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
    expect(qaIssueAfterRequeue.description).toContain("workProducts: none registered");
    expect(qaIssueAfterRequeue.description).toContain("Dependency workProduct hard-stop:");
    const qaComments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    const qaCommentBody = qaComments.map((comment) => comment.body).join("\n");
    expect(qaCommentBody).toContain("Workflow validation recheck");
    expect(qaCommentBody).toContain("rework-report.md [file/active]");
    expect(qaCommentBody).toContain(reportPath);
    expect(qaCommentBody).not.toContain("has no registered dependency workProduct");
  });

  it("[P4 control-flow loop] keeps downstream steps pending while QA request_changes is still recoverable", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-downstream" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const leadAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const claimsQaIssueId = randomUUID();
    const readabilityQaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop Downstream",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: leadAgentId, companyId, name: "Lead Agent", role: "lead", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Downstream Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-downstream",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [
            { stepId: "qa-claims", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
            { stepId: "qa-readability", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
          ],
          description: "Produce the artifact",
        },
        { id: "qa-claims", qaType: "semantic", name: "Validate the produced artifact claims", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "qa-readability", qaType: "semantic", name: "Validate the produced artifact readability", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
        { id: "lead-approval", name: "Lead approval", agentId: leadAgentId, dependencies: ["qa-claims", "qa-readability"], description: "Approve validated artifact" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T08:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-downstream: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:01:00.000Z"), completedAt: new Date("2026-06-18T08:05:00.000Z") },
      { id: claimsQaIssueId, companyId, missionId, title: "back-edge-downstream: Validate the produced artifact claims", status: "done", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:09:00.000Z") },
      { id: readabilityQaIssueId, companyId, missionId, title: "back-edge-downstream: Validate the produced artifact readability", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T08:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-06-18T08:01:00.000Z"), completedAt: new Date("2026-06-18T08:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-claims", issueId: claimsQaIssueId, status: "completed", startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:09:00.000Z") },
      { workflowRunId: runId, stepId: "qa-readability", issueId: readabilityQaIssueId, status: "failed", startedAt: new Date("2026-06-18T08:03:00.000Z"), completedAt: new Date("2026-06-18T08:10:00.000Z") },
      { workflowRunId: runId, stepId: "lead-approval", status: "pending" },
    ]);
    await submitQaVerdictEvidence(claimsQaIssueId, companyId, qaAgentId, "PASS", "2026-06-18T08:09:00.000Z");
    await submitQaVerdictEvidence(readabilityQaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T08:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    let rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    expect(rows.find((row) => row.stepId === "lead-approval")!).toMatchObject({
      status: "pending",
      issueId: null,
    });

    await db.update(issues).set({
      status: "done",
      completedAt: new Date("2026-06-18T08:30:00.000Z"),
      cancelledAt: null,
      startedAt: new Date("2026-06-18T08:11:00.000Z"),
    }).where(eq(issues.id, producerIssueId));
    await syncWorkflowRunForIssue(db, producerIssueId);

    await submitQaVerdictEvidence(readabilityQaIssueId, companyId, qaAgentId, "PASS", "2026-06-18T08:40:00.000Z");
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T08:40:00.000Z"), cancelledAt: null }).where(eq(issues.id, readabilityQaIssueId));
    await syncWorkflowRunForIssue(db, readabilityQaIssueId);

    rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const lead = rows.find((row) => row.stepId === "lead-approval")!;
    expect(lead.status).toBe("pending");
    expect(lead.issueId).toBeTruthy();
  });
}

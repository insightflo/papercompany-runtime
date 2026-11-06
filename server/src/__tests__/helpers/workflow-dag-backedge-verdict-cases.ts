import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { issueComments, issues, workflowStepRuns, type createDb } from "@paperclipai/db";
import { loadWorkflowApiFeedback } from "../../services/workflow/validation-verdict-ledger.js";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { createWorkflowBackedgeFixture } from "./workflow-backedge-fixture.js";

export function registerWorkflowDagBackedgeVerdictCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  const { seedBackEdgeLoopRun, submitQaVerdictEvidence } = createWorkflowBackedgeFixture(getDb, recordWorkflowVerdictForIssue);

  it("[P4 control-flow loop] QA request_changes fires the back-edge: producer is reset (rework), iteration_index++ and attempt archived", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-fire" });
    const { companyId, producerAgentId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    // QA 가 produce 완료(07:05) 후 반려(07:10).
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    heartbeatWakeup.mockClear();
    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    const qa = rows.find((row) => row.stepId === "qa-validate")!;
    // producer 리셋(rework): pending, iteration_index 0→1, attempt 아카이브.
    expect(produce.status).toBe("pending");
    expect(produce.iterationIndex).toBe(1);
    expect(produce.startedAt).toBeNull();
    expect(produce.completedAt).toBeNull();
    const attempts = (produce.metadata as Record<string, unknown> | null)?.controlFlowAttempts as Array<Record<string, unknown>> | undefined;
    expect(attempts).toHaveLength(1);
    expect(attempts![0]).toMatchObject({ iteration: 0, verdict: "request_changes" });
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    expect(producerIssue.status).toBe("done");
    expect(producerIssue.completedAt).toBeTruthy();
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    const producerCommentBody = producerComments.map((comment) => comment.body).join("\n");
    expect(producerCommentBody).toContain("Workflow QA rework request");
    expect(producerCommentBody).toContain("qa-validate");
    expect(producerCommentBody).toContain("Decision: REQUEST_CHANGES");
    expect(heartbeatWakeup).toHaveBeenCalledWith(producerAgentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: producerIssueId,
        mutation: "workflow_resume",
        workflowRunId: runId,
        stepId: "produce",
        workflowStepRunId: expect.any(String),
      }),
    }));
    // QA 는 이 sync 에서 리셋하지 않는다(producer 가 아직 재완료 전이라 validation-recheck 도 미발화).
    expect(qa.status).toBe("failed");
    expect(qa.iterationIndex).toBe(0);
  });

  it("[P4 control-flow loop] ignores non-terminal REQUEST_CHANGES mentions in QA comments", async () => {
    const db = getDb();
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    await db.insert(issueComments).values({
      companyId,
      issueId: qaIssueId,
      authorAgentId: qaAgentId,
      createdAt: new Date("2026-06-18T07:10:00.000Z"),
      body: [
        "Previous reviewer wrote REQUEST_CHANGES: missing glossary.",
        "This comment is only explaining prior state and does not provide a final verdict.",
        "Validation review still in progress.",
      ].join("\n"),
    });

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "completed",
      iterationIndex: 0,
    });
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    expect(producerComments.map((comment) => comment.body).join("\n")).not.toContain("Workflow QA rework request");
  });

  it("[P4 control-flow loop] ignores a stale QA verdict observed before the current producer iteration completion (RES-995)", async () => {
    const db = getDb();
    // RES-995: producer 가 이미 1회 rework(iteration 1) 후 completed(07:20). 이전 generation QA
    // verdict(07:10)는 stale → 두 번째 rework cap 소모 없이 iteration 2 로 증가하지 않는다.
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2, initialProducerIteration: 1 });
    await db.update(workflowStepRuns)
      .set({ status: "completed", completedAt: new Date("2026-06-18T07:20:00.000Z") })
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "produce")));
    await db.update(issues)
      .set({ status: "done", completedAt: new Date("2026-06-18T07:20:00.000Z") })
      .where(eq(issues.id, producerIssueId));
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    heartbeatWakeup.mockResolvedValue({ id: "queued-res995-stale" });
    heartbeatWakeup.mockClear();
    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    // stale verdict(observedAt 07:10 < producerCompletedAt 07:20) → cap 미소모, iteration 2 미증가.
    expect(produce.iterationIndex).toBe(1);
    expect(produce.status).toBe("completed");
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    expect(producerComments.map((comment) => comment.body).join("\n")).not.toContain("Workflow QA rework request");
    const [qaIssueRow] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssueRow.status).toBe("blocked");
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
  });

  it("[P4 control-flow loop] carries QA structured-verdict feedback into the producer rework issue", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-p4-loop-feedback" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    await recordWorkflowVerdictForIssue(qaIssueId, "request_changes", "2026-06-18T07:10:00.000Z", "REQUEST_CHANGES: Add a glossary before approval.");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(rows.find((row) => row.stepId === "produce")!).toMatchObject({
      status: "pending",
      iterationIndex: 1,
    });
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    const producerCommentBody = producerComments.map((comment) => comment.body).join("\n");
    expect(producerCommentBody).toContain("Workflow QA rework request");
    expect(producerCommentBody).toContain("QA feedback");
    expect(producerCommentBody).toContain("Add a glossary before approval");
    const qaStepRun = rows.find((row) => row.stepId === "qa-validate")!;
    await recordWorkflowVerdictForIssue(qaIssueId, "pass", "2026-06-18T07:11:00.000Z");
    await expect(loadWorkflowApiFeedback({
      db,
      companyId,
      issueId: qaIssueId,
      workflowRunId: runId,
      workflowStepRunId: qaStepRun.id,
    })).resolves.toContain("Add a glossary before approval");
  });
}

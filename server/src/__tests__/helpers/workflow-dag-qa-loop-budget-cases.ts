import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { createWorkflowBackedgeFixture } from "./workflow-backedge-fixture.js";

export function registerWorkflowDagQaLoopBudgetCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  const { seedBackEdgeLoopRun, submitQaVerdictEvidence } = createWorkflowBackedgeFixture(getDb, recordWorkflowVerdictForIssue);

  it("[QA loop hardening] two parallel QA validators both request_changes in one round → ONE producer rework with merged feedback (budget consumed once)", async () => {
    const db = getDb();
    // 회귀 대상(A1 live bug): 한 producer 에 달린 2개 back-edge QA 가 비동기로 verdict 를 낼 때
    //   verdict 단위로 producer 가 따로 리셋되어 maxIterations 이 빨리 소진되던 문제.
    //   기대: 같은 round 에 두 QA 가 모두 terminal+반려면 producer 리셋은 1회, iteration 0→1,
    //   두 QA feedback 이 하나의 rework comment 에 합쳐 생산자에게 전달된다.
    heartbeatWakeup.mockResolvedValue({ id: "queued-qa-loop-coalesce" });
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const claimsQaIssueId = randomUUID();
    const readabilityQaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "QA Loop Coalesce",
      issuePrefix: `QC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "QA Loop Coalesce Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "qa-loop-coalesce",
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
        { id: "qa-claims", qaType: "semantic", name: "Validate claims", agentId: qaAgentId, dependencies: ["produce"], description: "QA claims gate" },
        { id: "qa-readability", qaType: "semantic", name: "Validate readability", agentId: qaAgentId, dependencies: ["produce"], description: "QA readability gate" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T09:00:00.000Z"),
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "qa-loop-coalesce: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { id: claimsQaIssueId, companyId, missionId, title: "qa-loop-coalesce: Validate claims", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:03:00.000Z") },
      { id: readabilityQaIssueId, companyId, missionId, title: "qa-loop-coalesce: Validate readability", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T09:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-06-18T09:01:00.000Z"), completedAt: new Date("2026-06-18T09:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-claims", issueId: claimsQaIssueId, status: "failed", startedAt: new Date("2026-06-18T09:03:00.000Z"), completedAt: new Date("2026-06-18T09:09:00.000Z") },
      { workflowRunId: runId, stepId: "qa-readability", issueId: readabilityQaIssueId, status: "failed", startedAt: new Date("2026-06-18T09:03:00.000Z"), completedAt: new Date("2026-06-18T09:10:00.000Z") },
    ]);
    // 두 QA 가 같은 producer 산출물을 서로 다른 이유로 동시 반려(각각 다른 feedback).
    // 두 QA 가 같은 producer 산출물을 서로 다른 이유로 동시 반려(각각 다른 structured feedback).
    await recordWorkflowVerdictForIssue(claimsQaIssueId, "request_changes", "2026-06-18T09:09:00.000Z", "REQUEST_CHANGES: Fix the claim sourcing gaps before delivery.");
    await recordWorkflowVerdictForIssue(readabilityQaIssueId, "request_changes", "2026-06-18T09:10:00.000Z", "REQUEST_CHANGES: Fix the readability gaps before delivery.");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    // 리셋은 1회만 → iteration 0→1 (구 동작처럼 2로 jump 안 함).
    expect(produce.status).toBe("pending");
    expect(produce.iterationIndex).toBe(1);

    // rework comment 도 1개, 두 QA feedback 이 모두 합쳐져 있어야 한다.
    const producerComments = await db.select().from(issueComments).where(eq(issueComments.issueId, producerIssueId));
    const reworkComments = producerComments.filter((comment) => comment.body.includes("Workflow QA rework request"));
    expect(reworkComments).toHaveLength(1);
    const body = reworkComments[0]!.body;
    expect(body).toContain("qa-claims");
    expect(body).toContain("qa-readability");
    expect(body).toContain("Fix the claim sourcing gaps");
    expect(body).toContain("Fix the readability gaps");
  });

  it("[Patch 3 recheck idempotency] QA already re-checked (succeeded heartbeat >= producer completion) is NOT enqueued again on later sync", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-patch3-idempotency" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 2 });
    // T1=07:10 REQUEST_CHANGES verdict (구 verdict).
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");
    // T2=07:15 producer rework 완료(verdict 이후 → 기존 로직은 requeue 조건).
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:15:00.000Z") }).where(eq(issues.id, producerIssueId));
    // T3=07:16 QA recheck heartbeat succeeded (producer 완료 이후, explicit verdict 없이).
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: qaAgentId,
      issueId: qaIssueId,
      status: "succeeded",
      startedAt: new Date("2026-06-18T07:15:30.000Z"),
      finishedAt: new Date("2026-06-18T07:16:00.000Z"),
      resultJson: { note: "rechecked but emitted no explicit verdict" },
    });

    heartbeatWakeup.mockClear();
    // 늦은 owner/comment 등으로 sync 가 다시 돌았다고 가정.
    await syncWorkflowRunForIssue(db, producerIssueId);

    const qaIssueAfter = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, qaIssueId)).then((rows) => rows[0]!);
    expect(qaIssueAfter.status).not.toBe("todo");
    const recheckComments = await db.select().from(issueComments).where(eq(issueComments.issueId, qaIssueId));
    expect(recheckComments.filter((comment) => comment.body.includes("Workflow validation recheck")).length).toBe(0);
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    const producerAfter = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, producerIssueId)).then((rows) => rows[0]!);
    expect(producerAfter.status).toBe("done");
  });

  it("[P4 control-flow loop] maxIterations cap blocks further rework (no infinite loop): producer at cap is not reset", async () => {
    const db = getDb();
    // 가즈아 무한 loop 회귀 가드: iteration_index 가 maxIterations 에 도달하면 더 이상 리셋하지 않는다.
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({ maxIterations: 1, initialProducerIteration: 1 });
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");

    await syncWorkflowRunForIssue(db, producerIssueId);

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const produce = rows.find((row) => row.stepId === "produce")!;
    // cap(=1) 도달 → 리셋 안 함: iteration_index 그대로 1, status completed 유지, issue 도 done 유지.
    expect(produce.iterationIndex).toBe(1);
    expect(produce.status).toBe("completed");
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    expect(producerIssue.status).toBe("done");
    // attempt 도 추가되지 않음(리셋 자체가 안 일어남).
    const attempts = (produce.metadata as Record<string, unknown> | null)?.controlFlowAttempts as unknown[] | undefined;
    expect(attempts ?? []).toHaveLength(0);
  });

  it("queues an opted-in QA at the final producer generation with a cap-acceptance runtime contract", async () => {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "queued-cap-acceptance-recheck" });
    const { companyId, qaAgentId, runId, producerIssueId, qaIssueId } = await seedBackEdgeLoopRun({
      maxIterations: 2,
      initialProducerIteration: 2,
      allowCapAcceptance: true,
    });
    await submitQaVerdictEvidence(qaIssueId, companyId, qaAgentId, "REQUEST_CHANGES", "2026-06-18T07:10:00.000Z");
    await db.update(issues).set({
      status: "done",
      startedAt: new Date("2026-06-18T07:11:00.000Z"),
      completedAt: new Date("2026-06-18T07:15:00.000Z"),
    }).where(eq(issues.id, producerIssueId));

    heartbeatWakeup.mockClear();
    await syncWorkflowRunForIssue(db, producerIssueId);

    expect(heartbeatWakeup).toHaveBeenCalledWith(qaAgentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        workflowRunId: runId,
        stepId: "qa-validate",
        paperclipQaCapAcceptanceContract: expect.objectContaining({
          kind: "workflow_qa_cap_acceptance",
          qaStepId: "qa-validate",
          producerStepId: "produce",
          currentIteration: 2,
          maxIterations: 2,
        }),
      }),
      contextSnapshot: expect.objectContaining({
        forceFreshSession: true,
        paperclipQaCapAcceptanceContract: expect.objectContaining({
          verdictEndpoint: expect.stringContaining(`/issues/${qaIssueId}/workflow/verdict`),
          nonblockingAcceptance: {
            classification: "nonblocking",
            limitationsRequired: true,
          },
        }),
      }),
    }));
  });
}

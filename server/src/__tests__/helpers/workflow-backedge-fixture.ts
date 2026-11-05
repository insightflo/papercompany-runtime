import { randomUUID } from "node:crypto";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";

export function createWorkflowBackedgeFixture(
  getDb: () => ReturnType<typeof createDb>,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  async function seedBackEdgeLoopRun(opts: { maxIterations: number; initialProducerIteration?: number; allowCapAcceptance?: boolean }) {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Control Flow Loop P4",
      issuePrefix: `CL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Back-edge Loop Mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "back-edge-loop",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{
            stepId: "qa-validate",
            when: "qa_request_changes",
            isBackEdge: true,
            maxIterations: opts.maxIterations,
            ...(opts.allowCapAcceptance ? { allowCapAcceptance: true } : {}),
          }],
          description: "Produce the artifact. Do not validate your own output.",
        },
        { id: "qa-validate", qaType: "semantic", name: "Validate the produced artifact", agentId: qaAgentId, dependencies: ["produce"], description: "QA validation gate" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T07:00:00.000Z"),
    });
    // produce 는 done(07:05) — QA verdict(07:10) 보다 먼저 완료(이래야 validation-recheck 가 아니라 loop-driver 가 발화).
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "back-edge-loop: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "back-edge-loop: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: opts.initialProducerIteration ?? 0, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", startedAt: new Date("2026-06-18T07:03:00.000Z"), completedAt: new Date("2026-06-18T07:10:00.000Z") },
    ]);
    return { companyId, producerAgentId, qaAgentId, runId, producerIssueId, qaIssueId };
  }

  async function submitQaVerdictEvidence(qaIssueId: string, companyId: string, qaAgentId: string, verdict: "REQUEST_CHANGES" | "PASS", at: string) {
    // authoritative fixture: submits the structured workflow_api verdict event (the only decision +
    //   feedback authority). The feedback rationale is carried in the event payload reason field.
    const reason = [
      `Prior state marker for review context: Decision: ${verdict}`,
      "Validation review complete.",
      "",
      verdict === "REQUEST_CHANGES"
        ? "REQUEST_CHANGES: Fix the validation gaps before delivery."
        : "PASS",
    ].join("\n");
    void companyId;
    void qaAgentId;
    await recordWorkflowVerdictForIssue(qaIssueId, verdict === "PASS" ? "pass" : "request_changes", at, reason);
  }
  return { seedBackEdgeLoopRun, submitQaVerdictEvidence };
}

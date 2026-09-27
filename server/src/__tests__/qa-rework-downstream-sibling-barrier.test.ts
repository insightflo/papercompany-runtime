// server/src/__tests__/qa-rework-downstream-sibling-barrier.test.ts
//
// [purpose] Reproduce live incident 2026-09-26 (run 72c54dc8, mission 6d5f7b1e):
//   a producer with TWO back-edge sibling QAs where the second QA is sequentially
//   DOWNSTREAM of the first. When the first QA rejects (REQUEST_CHANGES, findings
//   not submitted), the downstream sibling can never become terminal (not runnable:
//   its success-edge predecessor failed; not skippable: hasRecoverableQaRequest-
//   ChangesDependency holds it pending). The sibling barrier must not wait for it,
//   otherwise the 5-min deadlock reconciler skips the pending tail and fails the run.
// [regression guard] a PARALLEL reachable sibling (still working) must keep holding
//   the barrier (coalesce contract preserved).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import type { PredFacts } from "../services/workflow/control-flow/edge-condition.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip downstream sibling barrier tests: ${support.reason ?? "unsupported"}`);

type StepRun = typeof workflowStepRuns.$inferSelect;

async function seedBase(db: ReturnType<typeof createDb>, suffix: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: `SiblingCo-${suffix}`, issuePrefix: `SB${suffix}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "sibling mission", status: "active" });
  return { companyId, agentId, missionId };
}

/** Live service-onboarding dependency shape (ids + edges preserved, fields minimized). */
function serviceOnboardingSteps(agentId: string) {
  const rc = (stepId: string) => ({ stepId, when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 });
  return [
    { id: "collect-service-source", name: "Collect service source page", type: "tool", agentId: "", dependencies: [] },
    { id: "capture-service-shot", name: "Capture service screenshot", type: "tool", agentId: "", dependencies: ["collect-service-source"] },
    { id: "collect-repo-meta", name: "Collect GitHub repo meta", type: "tool", agentId: "", dependencies: ["collect-service-source"] },
    { id: "analyze-service-profile", name: "Analyze service into structured profile", type: "agent", agentId, dependencies: ["collect-service-source", "collect-repo-meta"] },
    {
      id: "build-service-report-html", name: "Build service onboarding HTML", type: "agent", agentId,
      dependencies: ["analyze-service-profile", "capture-service-shot", "collect-repo-meta"],
      conditionalDependencies: [rc("validate-service-report-html"), rc("qa-service-report-html")],
    },
    { id: "prescreen-service-html", name: "Judgment prescreen", type: "tool", agentId: "", dependencies: ["build-service-report-html"] },
    { id: "validate-service-report-html", name: "Validate service onboarding HTML", type: "agent", agentId, dependencies: ["build-service-report-html", "capture-service-shot"] },
    {
      id: "qa-service-report-html", name: "Mechanical QA gate", type: "tool", agentId: "",
      dependencies: ["validate-service-report-html"], conditionalDependencies: [rc("verify-onboarding-manual-publish")],
    },
    { id: "publish-onboarding-manual", name: "Publish onboarding manual", type: "tool", agentId: "", dependencies: ["qa-service-report-html"] },
    { id: "verify-onboarding-manual-publish", name: "Verify onboarding manual publish", type: "tool", agentId: "", dependencies: ["publish-onboarding-manual"] },
  ];
}

describeDb("loop-driver back-edge rework: downstream sibling barrier", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sibling-barrier-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("reworks the producer when the only rejecting sibling QA has an unreachable downstream sibling (incident 72c54dc8)", async () => {
    const { companyId, agentId, missionId } = await seedBase(db, "A");
    const steps = serviceOnboardingSteps(agentId);
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "service-onboarding", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const doneIssue = async (title: string, status: string) =>
      (await db.insert(issues).values({ companyId, missionId, title, description: `${title} step`, status, assigneeAgentId: agentId }).returning({ id: issues.id }))[0]!.id;
    const upstreamIssueIds = await Promise.all([
      doneIssue("collect-service-source", "done"),
      doneIssue("capture-service-shot", "done"),
      doneIssue("collect-repo-meta", "done"),
      doneIssue("analyze-service-profile", "done"),
    ]);
    const producerIssueId = await doneIssue("build-service-report-html", "in_progress");
    const qaIssueId = await doneIssue("validate-service-report-html", "done");

    const now = Date.now();
    const completedAt = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const baseRun = { workflowRunId: runId, companyId } as const;
    await db.insert(workflowStepRuns).values([
      { ...baseRun, stepId: "collect-service-source", issueId: upstreamIssueIds[0], status: "completed", completedAt: completedAt(70) },
      { ...baseRun, stepId: "capture-service-shot", issueId: upstreamIssueIds[1], status: "completed", completedAt: completedAt(68) },
      { ...baseRun, stepId: "collect-repo-meta", issueId: upstreamIssueIds[2], status: "completed", completedAt: completedAt(66) },
      { ...baseRun, stepId: "analyze-service-profile", issueId: upstreamIssueIds[3], status: "completed", completedAt: completedAt(50) },
      { ...baseRun, stepId: "build-service-report-html", issueId: producerIssueId, status: "completed", iterationIndex: 0, completedAt: completedAt(40) },
      { ...baseRun, stepId: "prescreen-service-html", status: "completed", completedAt: completedAt(39) },
      { ...baseRun, stepId: "publish-onboarding-manual", status: "pending" },
      { ...baseRun, stepId: "verify-onboarding-manual-publish", status: "pending" },
    ]);
    const [validateRun] = await db.insert(workflowStepRuns).values({ ...baseRun, stepId: "validate-service-report-html", issueId: qaIssueId, status: "failed" }).returning({ id: workflowStepRuns.id });
    // Downstream sibling QA stuck pending exactly like the live run.
    await db.insert(workflowStepRuns).values({ ...baseRun, stepId: "qa-service-report-html", status: "pending" });

    // Official workflow_api REQUEST_CHANGES verdict, no structured findings (live payload had findings=null).
    const qaHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: qaHeartbeatId, companyId, agentId, issueId: qaIssueId, status: "succeeded",
      startedAt: completedAt(35), finishedAt: completedAt(34),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: validateRun!.id, issueId: qaIssueId,
      heartbeatRunId: qaHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `sibling-barrier:${validateRun!.id}`,
      createdAt: completedAt(33),
      payload: {
        kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: validateRun!.id, issueId: qaIssueId,
        verdict: "request_changes", diagnostics: [], reason: "17 checkpoints failed on section structure.",
      },
    });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const fact = (status: PredFacts["status"], isQaGate: boolean, verdict: PredFacts["verdict"]): PredFacts =>
      ({ status, isQaGate, verdict });
    const predsByStepId = new Map<string, PredFacts>([
      ["collect-service-source", fact("completed", false, null)],
      ["capture-service-shot", fact("completed", false, null)],
      ["collect-repo-meta", fact("completed", false, null)],
      ["analyze-service-profile", fact("completed", false, null)],
      ["build-service-report-html", fact("completed", false, null)],
      ["prescreen-service-html", fact("completed", false, null)],
      ["validate-service-report-html", fact("failed", true, "request_changes")],
      ["qa-service-report-html", fact("pending", true, null)],
      ["publish-onboarding-manual", fact("pending", false, null)],
      ["verify-onboarding-manual-publish", fact("pending", true, null)],
    ]);

    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: runId, companyId, status: "running", missionId },
      steps: steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    expect(result.reworkedCount).toBe(1);
    const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "build-service-report-html"));
    expect(producer!.status).toBe("pending");
    expect(producer!.iterationIndex).toBe(1);
    // The rejecting QA and the unreachable sibling are not reset by this pass.
    const [validateAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "validate-service-report-html"));
    expect(validateAfter!.status).toBe("failed");
    const [siblingAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "qa-service-report-html"));
    expect(siblingAfter!.status).toBe("pending");
  });

  it("keeps holding the barrier while a parallel sibling QA is still reachable/working", async () => {
    const { companyId, agentId, missionId } = await seedBase(db, "B");
    const steps = [
      { id: "collect", name: "Collect", agentId, dependencies: [] },
      {
        id: "produce", name: "Produce", agentId, dependencies: ["collect"],
        conditionalDependencies: [
          { stepId: "qa-semantic", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 },
          { stepId: "qa-mechanical", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 },
        ],
      },
      { id: "qa-semantic", name: "QA semantic", agentId, dependencies: ["produce"] },
      { id: "qa-mechanical", name: "QA mechanical", agentId, dependencies: ["produce"] },
    ];
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "parallel-siblings", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const collectIssueId = (await db.insert(issues).values({ companyId, missionId, title: "collect", description: "collect", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id }))[0]!.id;
    const producerIssueId = (await db.insert(issues).values({ companyId, missionId, title: "produce", description: "produce", status: "in_progress", assigneeAgentId: agentId }).returning({ id: issues.id }))[0]!.id;
    const qaIssueId = (await db.insert(issues).values({ companyId, missionId, title: "qa-semantic", description: "qa", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id }))[0]!.id;

    const now = Date.now();
    const ago = (m: number) => new Date(now - m * 60_000);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, companyId, stepId: "collect", issueId: collectIssueId, status: "completed", completedAt: ago(60) },
      { workflowRunId: runId, companyId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: 0, completedAt: ago(40) },
      { workflowRunId: runId, companyId, stepId: "qa-mechanical", status: "running" },
    ]);
    const [qaRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, companyId, stepId: "qa-semantic", issueId: qaIssueId, status: "failed" }).returning({ id: workflowStepRuns.id });
    const hb = randomUUID();
    await db.insert(heartbeatRuns).values({ id: hb, companyId, agentId, issueId: qaIssueId, status: "succeeded", startedAt: ago(35), finishedAt: ago(34) });
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun!.id, issueId: qaIssueId,
      heartbeatRunId: hb, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `parallel-sibling:${qaRun!.id}`, createdAt: ago(33),
      payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaRun!.id, issueId: qaIssueId, verdict: "request_changes", diagnostics: [] },
    });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const predsByStepId = new Map<string, PredFacts>([
      ["collect", { status: "completed", isQaGate: false, verdict: null }],
      ["produce", { status: "completed", isQaGate: false, verdict: null }],
      ["qa-semantic", { status: "failed", isQaGate: true, verdict: "request_changes" }],
      ["qa-mechanical", { status: "running", isQaGate: true, verdict: null }],
    ]);

    const result = await applyBackEdgeReworkPass({
      db,
      run: { id: runId, companyId, status: "running", missionId },
      steps: steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    expect(result.reworkedCount).toBe(0);
    const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "produce"));
    expect(producer!.status).toBe("completed");
    expect(producer!.iterationIndex).toBe(0);
  });
});

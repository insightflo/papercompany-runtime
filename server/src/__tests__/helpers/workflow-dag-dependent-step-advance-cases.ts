import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagDependentStepAdvanceCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("advances dependent steps when a linked workflow step issue lost workflow origin metadata", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-originless-step" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Originless Workflow",
      issuePrefix: `WO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Originless Step Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    await executeWorkflowRun(db, runId);
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesizeStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collectStepRun?.issueId).toBeTruthy();
    expect(synthesizeStepRun?.issueId).toBeNull();

    await db
      .update(issues)
      .set({
        originKind: "manual",
        originId: null,
        originRunId: null,
      })
      .where(eq(issues.id, collectStepRun!.issueId!));

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });
    const afterCollect = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(afterCollect?.status).toBe("running");

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedCollect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const progressedSynthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(progressedCollect?.status).toBe("completed");
    expect(progressedSynthesize?.issueId).toBeTruthy();

    const createdSynthesisIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedSynthesize!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdSynthesisIssue).toMatchObject({
      title: "Synthesize",
      assigneeAgentId: agentBId,
      originKind: "workflow_execution",
      originRunId: runId,
    });
  });

  it("automatically advances dependent steps when a workflow issue is marked done", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-auto-advance" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Auto Advance Workflow",
      issuePrefix: `AA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Collector Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Agent",
        role: "writer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentAId,
      title: "Auto advance mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Auto Advance Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId: agentBId, dependencies: ["collect"], description: "Write report" },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    const issueSvc = issueService(db);
    await executeWorkflowRun(db, runId);
    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collectStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "collect");
    expect(collectStepRun?.issueId).toBeTruthy();

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const collect = progressedStepRuns.find((stepRun) => stepRun.stepId === "collect");
    const synthesize = progressedStepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    expect(collect?.status).toBe("completed");
    expect(synthesize?.issueId).toBeTruthy();
    expect(synthesize?.status).toBe("pending");

    const [synthesisIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, synthesize!.issueId!));
    expect(synthesisIssue).toEqual(expect.objectContaining({
      title: "Synthesize",
      status: "todo",
      assigneeAgentId: agentBId,
    }));
  });
}

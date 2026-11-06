import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueComments, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagPrerequisiteFailureCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("keeps dependent steps pending when a prerequisite execution issue fails", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-3" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Failure",
      issuePrefix: `WX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Failure Agent",
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
      title: "Failure Workflow Mission",
      status: "active",
    });
    const issueSvc = issueService(db);
    const oversightIssue = await issueSvc.create(companyId, {
      assigneeAgentId: agentId,
      missionId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[Oversight] Failure Workflow",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Failure Workflow",
      stepsJson: [
        { id: "prepare", name: "Prepare", agentId, dependencies: [], description: "Prepare the work" },
        { id: "ship", name: "Ship", agentId, dependencies: ["prepare"], description: "Ship the work" },
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

    await executeWorkflowRun(db, runId);
    const prepareStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "prepare") ?? null);

    await issueSvc.update(prepareStepRun!.issueId!, { status: "blocked" });
    const failed = await syncWorkflowRunForIssue(db, prepareStepRun!.issueId!);
    expect(failed?.status).toBe("running");

    const finalStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const prepare = finalStepRuns.find((stepRun) => stepRun.stepId === "prepare");
    const ship = finalStepRuns.find((stepRun) => stepRun.stepId === "ship");
    expect(prepare?.status).toBe("failed");
    expect(ship?.status).toBe("pending");
    expect(ship?.issueId).toBeNull();

    const oversightComments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    expect(oversightComments.map((comment) => comment.body).join("\n")).toContain("Workflow step failed");
    expect(oversightComments.map((comment) => comment.body).join("\n")).toContain("prepare");
    expect(oversightComments[0]?.authorAgentId).toBe(agentId);

    await db.delete(issueComments).where(eq(issueComments.issueId, oversightIssue.id));

    const supervision = await missionService(db).runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });
    expect(supervision).toMatchObject({
      missionId,
      oversightIssueId: oversightIssue.id,
      commented: true,
    });
    expect(supervision.findings.join("\n")).toContain("blocked_without_replan");
    expect(supervision.findings.join("\n")).toContain("failed_step_without_diagnosis");
    const commentsAfterSupervision = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, oversightIssue.id));
    const supervisionCommentBody = commentsAfterSupervision.map((comment) => comment.body).join("\n");
    expect(supervisionCommentBody).toContain("Mission owner supervision diagnosis");
    expect(supervisionCommentBody).toContain("Governance thread evidence:");
    expect(supervisionCommentBody).toContain("Workflow step reached terminal status failed.");
    expect(supervisionCommentBody).toContain("workflow_step_failed: Workflow step failed");
    expect(supervisionCommentBody).not.toContain("wake_agent");
  });

  it("keeps downstream steps pending when a prerequisite issue fails and resumes them when it recovers", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-reactivate" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Reactivation",
      issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workflow Reactivation Agent",
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
      title: "Reactivation Workflow Mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Reactivation Workflow",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [], description: "Collect evidence" },
        { id: "synthesize", name: "Synthesize", agentId, dependencies: ["collect"], description: "Synthesize evidence" },
        { id: "validate", name: "Validate", agentId, dependencies: ["synthesize"], description: "Validate synthesis" },
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

    await executeWorkflowRun(db, runId);
    const collectStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "collect") ?? null);

    const issueSvc = issueService(db);
    await issueSvc.update(collectStepRun!.issueId!, { status: "blocked" });
    await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);

    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("failed");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.status).toBe("pending");

    await issueSvc.update(collectStepRun!.issueId!, { status: "todo" });
    const reopened = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(reopened?.status).toBe("running");

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "synthesize")?.issueId).toBeNull();
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.status).toBe("pending");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "validate")?.issueId).toBeNull();

    await issueSvc.update(collectStepRun!.issueId!, { status: "done" });
    const progressed = await syncWorkflowRunForIssue(db, collectStepRun!.issueId!);
    expect(progressed?.status).toBe("running");

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const synthesizeStepRun = stepRuns.find((stepRun) => stepRun.stepId === "synthesize");
    const validateStepRun = stepRuns.find((stepRun) => stepRun.stepId === "validate");
    expect(synthesizeStepRun?.status).toBe("pending");
    expect(synthesizeStepRun?.issueId).toBeTruthy();
    expect(validateStepRun?.status).toBe("pending");
    expect(validateStepRun?.issueId).toBeNull();
  });
}

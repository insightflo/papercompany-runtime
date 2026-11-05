import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, type Mock } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function createWorkflowDependencyFixture(getDb: () => ReturnType<typeof createDb>, heartbeatWakeup: Mock) {
  // Structured artifact authority: downstream input is restricted to registered DB workProducts
  // (or native tool metadata). Natural-language `[ARTIFACT]:` markers remain non-authoritative.
  type DependencyWorkflowStep = {
    id: string;
    name: string;
    agentId: string;
    dependencies: string[];
    description?: string;
    graphWorkProductRequired?: boolean;
  };

  async function executeDependencyWorkflow(opts: {
    companyId: string;
    companyName: string;
    missionId: string;
    workflowId: string;
    runId: string;
    agents: Array<{ id: string; name: string; role: string }>;
    steps: DependencyWorkflowStep[];
  }): Promise<Record<string, typeof issues.$inferSelect>> {
    const db = getDb();
    heartbeatWakeup.mockResolvedValue({ id: "plan-b-run" });
    await db.insert(companies).values({
      id: opts.companyId,
      name: opts.companyName,
      issuePrefix: `PB${opts.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      opts.agents.map((agent) => ({
        id: agent.id,
        companyId: opts.companyId,
        name: agent.name,
        role: agent.role,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(missions).values({
      id: opts.missionId,
      companyId: opts.companyId,
      ownerAgentId: opts.agents[0]!.id,
      title: opts.companyName,
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: opts.workflowId,
      companyId: opts.companyId,
      name: opts.companyName,
      stepsJson: opts.steps,
    });
    await db.insert(workflowRuns).values({
      id: opts.runId,
      workflowId: opts.workflowId,
      companyId: opts.companyId,
      missionId: opts.missionId,
      triggeredBy: "system",
      status: "pending",
    });
    await executeWorkflowRun(db, opts.runId);
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, opts.runId));
    const issuesByStep: Record<string, typeof issues.$inferSelect> = {};
    for (const stepRun of stepRuns) {
      if (!stepRun.issueId) continue;
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, stepRun.issueId))
        .then((rows) => rows[0] ?? null);
      if (issue) issuesByStep[stepRun.stepId] = issue;
    }
    return issuesByStep;
  }

  async function completeStepIssue(issueId: string) {
    const db = getDb();
    await issueService(db).update(issueId, { status: "done" });
    await syncWorkflowRunForIssue(db, issueId);
  }

  async function recordWorkflowVerdictForIssue(issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) {
    const db = getDb();
    const [row] = await db
      .select({
        companyId: issues.companyId,
        missionId: issues.missionId,
        assigneeAgentId: issues.assigneeAgentId,
        workflowRunId: workflowStepRuns.workflowRunId,
        workflowStepRunId: workflowStepRuns.id,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(issues.id, workflowStepRuns.issueId))
      .where(eq(workflowStepRuns.issueId, issueId))
      .limit(1);
    expect(row).toBeTruthy();
    // authoritative fixture: a checked-out heartbeat run scoped to this QA issue + an exact run/step
    //   workflow_api verdict event — the only submission the structured readers accept.
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId: row!.companyId,
      agentId: row!.assigneeAgentId!,
      issueId,
      status: "succeeded",
      invocationSource: "automation",
      startedAt: new Date(at),
      finishedAt: new Date(at),
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId: row!.companyId,
      missionId: row!.missionId,
      workflowRunId: row!.workflowRunId,
      workflowStepRunId: row!.workflowStepRunId,
      issueId,
      heartbeatRunId,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict,
      decision: verdict,
      reason: "workflow_api",
      reasonCode: "workflow_api",
      idempotencyKey: `test-verdict:${issueId}:${row!.workflowStepRunId}:${heartbeatRunId}`,
      payload: {
        kind: "workflow_validation_verdict",
        workflowRunId: row!.workflowRunId,
        stepRunId: row!.workflowStepRunId,
        issueId,
        verdict,
        ...(reason ? { reason } : {}),
      },
      createdAt: new Date(at),
    });
  }

  async function getStepIssue(runId: string, stepId: string) {
    const db = getDb();
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)))
      .then((rows) => rows[0] ?? null);
    if (!stepRun?.issueId) return null;
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun.issueId))
      .then((rows) => rows[0] ?? null);
  }

  // producer 가 heartbeat run output 에 `[ARTIFACT]:` 를 남긴 경우를 시뮬레이션.
  async function seedArtifactRun(opts: { companyId: string; agentId: string; issueId: string; artifactPath: string }) {
    const db = getDb();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      issueId: opts.issueId,
      status: "succeeded",
      invocationSource: "automation",
      stdoutExcerpt: `Collect finished.\n[ARTIFACT]: ${opts.artifactPath}`,
      startedAt: new Date("2026-06-24T06:00:00.000Z"),
      finishedAt: new Date("2026-06-24T06:05:00.000Z"),
      createdAt: new Date("2026-06-24T06:00:00.000Z"),
      updatedAt: new Date("2026-06-24T06:05:00.000Z"),
    });
    return runId;
  }

  async function seedArtifactComment(opts: { companyId: string; agentId: string; issueId: string; artifactPath: string }) {
    const db = getDb();
    await db.insert(issueComments).values({
      companyId: opts.companyId,
      issueId: opts.issueId,
      authorAgentId: opts.agentId,
      body: `Done — evidence collected.\n[ARTIFACT]: ${opts.artifactPath}`,
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
  }

  return { executeDependencyWorkflow, completeStepIssue, recordWorkflowVerdictForIssue,
    getStepIssue, seedArtifactRun, seedArtifactComment };
}

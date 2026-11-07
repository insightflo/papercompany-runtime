import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";
import { createWorkflowDependencyFixture } from "./workflow-dependency-fixture.js";

export function registerWorkflowDagArtifactDependencyCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  const { executeDependencyWorkflow, completeStepIssue, getStepIssue, seedArtifactRun, seedArtifactComment } = createWorkflowDependencyFixture(getDb, heartbeatWakeup);

  it("progresses dependent steps and completes the workflow as execution issues complete", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-2" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow Progression",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Workflow Agent A",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Synthesis Editor",
        role: "pm",
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
      title: "Workflow Mission",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Execution Workflow",
      stepsJson: [
        { id: "plan", name: "Plan", agentId: agentAId, dependencies: [], description: "Create the plan" },
        { id: "build", name: "Build", agentId: agentBId, dependencies: ["plan"], description: "Implement the plan" },
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
    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");
    expect(initial.completedAt).toBeNull();
    expect(initial.stepRuns).toHaveLength(2);

    const initialStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const planStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const buildStepRun = initialStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(planStepRun?.issueId).toBeTruthy();
    expect(buildStepRun?.issueId).toBeNull();

    const planIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, planStepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(planIssue?.missionId).toBe(missionId);

    await issueSvc.update(planIssue!.id, { status: "done" });
    const afterPlan = await syncWorkflowRunForIssue(db, planIssue!.id);
    expect(afterPlan?.status).toBe("running");
    expect(afterPlan?.completedAt).toBeNull();

    const progressedStepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const progressedPlan = progressedStepRuns.find((stepRun) => stepRun.stepId === "plan");
    const progressedBuild = progressedStepRuns.find((stepRun) => stepRun.stepId === "build");
    expect(progressedPlan?.status).toBe("completed");
    expect(progressedBuild?.issueId).toBeTruthy();

    const buildIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, progressedBuild!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(buildIssue?.description).not.toContain("Dependency workProduct hard-stop:");
    expect(buildIssue?.description).toContain(`- plan: ${planIssue?.identifier ?? planIssue!.id} (done)`);
    expect(buildIssue?.description).toContain("workProducts: none registered");

    await issueSvc.update(progressedBuild!.issueId!, { status: "done" });
    const afterBuild = await syncWorkflowRunForIssue(db, progressedBuild!.issueId!);
    expect(afterBuild?.status).toBe("completed");

    const workflowRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.completedAt).toBeTruthy();
  });



  it("does not inject a producer stdout ARTIFACT marker without a registered workProduct", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Single Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector", role: "engineer" },
        { id: agentBId, name: "Auditor", role: "pm" },
      ],
      steps: [
        { id: "collect", name: "Collect", agentId: agentAId, dependencies: [], description: "Collect evidence" },
        { id: "audit", name: "Audit", agentId: agentBId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/tech-scout/202606/tech_scout_20260624/evidence.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.collect!.id, artifactPath });
    await completeStepIssue(upstream.collect!.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(artifactPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });

  it("does not inject stdout or comment ARTIFACT markers for multiple dependencies", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const agentCId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Multi Upstream",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: agentAId, name: "Collector A1", role: "engineer" },
        { id: agentBId, name: "Collector A2", role: "engineer" },
        { id: agentCId, name: "Synthesizer", role: "pm" },
      ],
      steps: [
        { id: "a1", name: "Collect A1", agentId: agentAId, dependencies: [], description: "Collect A1" },
        { id: "a2", name: "Collect A2", agentId: agentBId, dependencies: [], description: "Collect A2" },
        { id: "b", name: "Synthesize", agentId: agentCId, dependencies: ["a1", "a2"], description: "Synthesize A1+A2" },
      ],
    });
    const a1Path = "/srv/papercompany/produced_work/a1/evidence_a1.json";
    const a2Path = "/srv/papercompany/produced_work/a2/evidence_a2.json";
    await seedArtifactRun({ companyId, agentId: agentAId, issueId: upstream.a1!.id, artifactPath: a1Path });
    await seedArtifactComment({ companyId, agentId: agentBId, issueId: upstream.a2!.id, artifactPath: a2Path });
    await completeStepIssue(upstream.a1!.id);
    await completeStepIssue(upstream.a2!.id);

    const synthIssue = await getStepIssue(runId, "b");
    expect(synthIssue).toBeTruthy();
    const desc = synthIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(a1Path);
    expect(desc).not.toContain(a2Path);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });

  it("keeps graphWorkProductRequired producers incomplete without registered workProducts", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const collectorAgentId = randomUUID();
    const auditorAgentId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Required Dependency",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: collectorAgentId, name: "Collector", role: "engineer" },
        { id: auditorAgentId, name: "Auditor", role: "pm" },
      ],
      steps: [
        {
          id: "collect",
          name: "Collect",
          agentId: collectorAgentId,
          dependencies: [],
          description: "Collect evidence",
          graphWorkProductRequired: true,
        },
        { id: "audit", name: "Audit", agentId: auditorAgentId, dependencies: ["collect"], description: "Audit the evidence" },
      ],
    });
    const artifactPath = "/srv/papercompany/produced_work/collect/evidence.json";
    await seedArtifactRun({ companyId, agentId: collectorAgentId, issueId: upstream.collect!.id, artifactPath });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date("2026-06-24T06:05:00.000Z") })
      .where(eq(issues.id, upstream.collect!.id));
    await syncWorkflowRunForIssue(db, upstream.collect!.id);

    expect(await getStepIssue(runId, "audit")).toBeNull();
    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.find((stepRun) => stepRun.stepId === "collect")?.status).toBe("running");
    expect(stepRuns.find((stepRun) => stepRun.stepId === "audit")).toMatchObject({
      status: "pending",
      issueId: null,
    });
    const workProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, upstream.collect!.id));
    expect(workProducts).toEqual([]);
  });
}

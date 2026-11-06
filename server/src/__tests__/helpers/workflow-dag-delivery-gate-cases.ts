import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagDeliveryGateCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
  recordWorkflowVerdictForIssue: (issueId: string, verdict: "pass" | "request_changes", at: string, reason?: string) => Promise<void>,
) {
  it("creates distinct issues for two QA steps with the same title in one run (same-title step collision regression)", async () => {
    const db = getDb();
    // Regression for the B incident: two QA steps named "[QA] Verify mission result"
    // in the SAME run previously shared one issue because createWorkflowStepIssue
    // reused by title. That collapsed verdict/validation binding (RES-2759).
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-same-title-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-same-title-qa" });

    await db.insert(companies).values({
      id: companyId,
      name: "Same Title QA",
      issuePrefix: `ST${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA Agent",
      role: "validator",
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
      title: "Same-title QA mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "same-title qa steps",
      stepsJson: [
        {
          id: "qa-6-ac16fc87c5",
          name: "[QA] Verify mission result",
          agentId,
          dependencies: [],
          description: "First QA step verifying mission result.",
        },
        {
          id: "qa-9dde506b6c",
          name: "[QA] Verify mission result",
          agentId,
          dependencies: [],
          description: "Second QA step verifying mission result (synthetic).",
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-08-06",
    });

    await executeWorkflowRun(db, runId);

    const stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qa6 = stepRuns.find((row) => row.stepId === "qa-6-ac16fc87c5");
    const qa9 = stepRuns.find((row) => row.stepId === "qa-9dde506b6c");
    expect(qa6?.issueId).toBeTruthy();
    expect(qa9?.issueId).toBeTruthy();
    // Distinct issues — the core regression.
    expect(qa6!.issueId).not.toEqual(qa9!.issueId);

    const issuesForRun = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(
        eq(issues.originRunId, runId),
        eq(issues.originKind, "workflow_execution"),
      ));
    expect(issuesForRun.filter((row) => row.title === "[QA] Verify mission result").length).toBe(2);
  });

  it("injects a delivery verification gate for manual-onboarding publish workflows and blocks completion until readback passes", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const publisherAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-delivery-gate-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-delivery-gate" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Delivery Gate",
      issuePrefix: `DG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "HTML Producer",
        role: "builder",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: publisherAgentId,
        companyId,
        name: "Manual Publisher",
        role: "publisher",
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
      ownerAgentId: producerAgentId,
      title: "Publish Feynman manual",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "manual-onboarding publish workflow",
      stepsJson: [
        {
          id: "build-html",
          name: "Build HTML",
          agentId: producerAgentId,
          dependencies: [],
          description: "Build the manual HTML.",
          graphWorkProductRequired: true,
        },
        {
          id: "publish-manual-onboarding", deliveryVerification: "required",
          name: "Publish to manual-onboarding R2",
          agentId: publisherAgentId,
          dependencies: ["build-html"],
          description: "Upload to the manual-onboarding public hub.",
          graphWorkProductRequired: false,
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
      runDate: "2026-06-28",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRuns.map((row) => row.stepId).sort()).toEqual([
      "build-html",
      "delivery-verification-gate",
      "publish-manual-onboarding",
    ]);
    expect(stepRuns.find((row) => row.stepId === "delivery-verification-gate")?.issueId).toBeNull();

    const buildIssueId = stepRuns.find((row) => row.stepId === "build-html")!.issueId!;
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: buildIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/build-html/index.html`,
      title: "index.html",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/build-html/index.html`,
      },
    });
    await issueService(db).update(buildIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, buildIssueId);

    stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const publishIssueId = stepRuns.find((row) => row.stepId === "publish-manual-onboarding")!.issueId!;
    expect(publishIssueId).toEqual(expect.any(String));
    expect(stepRuns.find((row) => row.stepId === "delivery-verification-gate")?.issueId).toBeNull();

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: publishIssueId,
      type: "url",
      provider: "manual-onboarding",
      externalId: "manual-onboarding/concepts/feynman-technique-v1/index.html",
      url: "https://manual-onboarding.pages.dev/onboarding/concepts/feynman-technique-v1/index.html",
      title: "Published manual URL",
      status: "active",
      isPrimary: true,
      metadata: { section: "concepts" },
    });
    await issueService(db).update(publishIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, publishIssueId);

    stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const deliveryRun = stepRuns.find((row) => row.stepId === "delivery-verification-gate")!;
    expect(deliveryRun.issueId).toEqual(expect.any(String));
    const [runBeforeDeliveryQa] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(runBeforeDeliveryQa?.status).toBe("running");

    const [deliveryIssue] = await db.select().from(issues).where(eq(issues.id, deliveryRun.issueId!));
    const deliveryDescription = deliveryIssue?.description ?? "";
    expect(deliveryDescription).toContain("QA grading rubric:");
    const rubricPath = deliveryDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    const deliveryRubric = fs.readFileSync(rubricPath!, "utf8");
    expect(deliveryRubric).toContain("Verification Before Completion");
    expect(deliveryRubric).toContain("fresh evidence");
    expect(deliveryRubric).toContain("Delivery Verification");
    expect(deliveryRubric).toContain("final consumer path");
    expect(deliveryRubric).toContain("HTTP 200");
    expect(deliveryRubric).toContain("Identify every completion claim");

    await recordWorkflowVerdictForIssue(deliveryRun.issueId!, "pass", "2026-06-28T00:40:00.000Z");
    await issueService(db).update(deliveryRun.issueId!, { status: "done" });
    await syncWorkflowRunForIssue(db, deliveryRun.issueId!);
    const [completedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(completedRun?.status).toBe("completed");
  });
}

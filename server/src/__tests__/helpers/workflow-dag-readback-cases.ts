import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagReadbackCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("strengthens an existing public readback QA step without appending a duplicate delivery gate", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const publisherAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-delivery-readback-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-existing-readback" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Existing Delivery Readback",
      issuePrefix: `DR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: publisherAgentId,
      companyId,
      name: "Manual Publisher",
      role: "publisher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: publisherAgentId,
      title: "Publish with existing smoke QA",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "manual-onboarding publish with smoke QA",
      stepsJson: [
        {
          id: "publish-manual-onboarding", deliveryVerification: "required",
          name: "Publish to manual-onboarding R2",
          agentId: publisherAgentId,
          dependencies: [],
          description: "Upload to the manual-onboarding public hub.",
        },
        {
          id: "publish-smoke-qa", qaType: "delivery",
          name: "[QA] 게시 smoke QA: R2 HTTP 200 + hub index 갱신 확인",
          agentId: publisherAgentId,
          dependencies: ["publish-manual-onboarding"],
          description: "Confirm the published item is visible.",
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
      "publish-manual-onboarding",
      "publish-smoke-qa",
    ]);
    expect(stepRuns.some((row) => row.stepId === "delivery-verification-gate")).toBe(false);

    const publishIssueId = stepRuns.find((row) => row.stepId === "publish-manual-onboarding")!.issueId!;
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
    expect(stepRuns.some((row) => row.stepId === "delivery-verification-gate")).toBe(false);
    const smokeQaRun = stepRuns.find((row) => row.stepId === "publish-smoke-qa")!;
    expect(smokeQaRun.issueId).toEqual(expect.any(String));

    const [smokeQaIssue] = await db.select().from(issues).where(eq(issues.id, smokeQaRun.issueId!));
    const smokeQaDescription = smokeQaIssue?.description ?? "";
    const rubricPath = smokeQaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Confirm the published item is visible.");
    expect(rubric).toContain("Verification Before Completion");
    expect(rubric).toContain("fresh evidence");
    expect(rubric).toContain("Delivery Verification");
    expect(rubric).toContain("final consumer path");
    expect(rubric).toContain("HTTP 200");
  });
}

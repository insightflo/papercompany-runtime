import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { executeWorkflowRun } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagRunMetadataCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("renders {$runMetadata.<key>} tokens in step name and description from run metadata", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepId = "summarize-video";

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-1" });

    await db.insert(companies).values({
      id: companyId,
      name: "Run Metadata Workflow",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Metadata Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "YouTube Summary",
      stepsJson: [
        {
          id: stepId,
          name: "Summarize {$runMetadata.videoId}",
          agentId,
          dependencies: [],
          description: "Input URL: {$runMetadata.url} on {$runDate}; missing stays {$runMetadata.notDeclared}",
        },
      ],
    });

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "board",
      triggerSource: "manual",
      status: "pending",
      runDate: "2026-08-27",
      metadata: { videoId: "dQw4w9WgXcQ", url: "https://example.com/watch?v=dQw4w9WgXcQ" },
    });

    const result = await executeWorkflowRun(db, runId);

    expect(result.status).toBe("running");
    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();

    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);
    expect(createdIssue?.title).toBe("Summarize dQw4w9WgXcQ");
    expect(createdIssue?.description).toContain(
      "Input URL: https://example.com/watch?v=dQw4w9WgXcQ on 2026-08-27; missing stays {$runMetadata.notDeclared}",
    );
  });

  it("injects deliverable + registration contract only for workProduct steps (graphWorkProductRequired=true)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const stepId = "produce-report";
    const workProductRoot = `/tmp/wf-workproduct-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-run-workproduct" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip WorkProduct",
      issuePrefix: `WP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer Agent",
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
      title: "WorkProduct mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Producer Workflow",
      stepsJson: [
        {
          id: stepId,
          name: "Produce report",
          agentId,
          dependencies: [],
          description: "Write the report file.",
          graphWorkProductRequired: true,
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
      runDate: "2026-06-12",
    });

    await executeWorkflowRun(db, runId);

    const stepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === stepId) ?? null);
    expect(stepRun?.issueId).toBeTruthy();
    const createdIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, stepRun!.issueId!))
      .then((rows) => rows[0] ?? null);

    // graphWorkProductRequired=true → dag-engine injects the full contract.
    expect(createdIssue?.description).toContain("Deliverable output (use exactly this directory):");
    expect(createdIssue?.description).toContain(workProductRoot);
    expect(createdIssue?.description).toContain("Workflow API closeout:");
    expect(createdIssue?.description).toContain("/workflow/artifacts");
    expect(createdIssue?.description).toContain("/workflow/complete");
    expect(createdIssue?.description).toContain("WorkProduct registration contract:");
    expect(createdIssue?.description).toContain("only the Workflow API registers a work product");
    expect(createdIssue?.description).not.toContain("[ARTIFACT]:");
    expect(createdIssue?.description).toContain("Evidence explanation quality");
    expect(createdIssue?.description).toContain("source content -> observation -> interpretation -> conclusion");
    expect(createdIssue?.description).toContain("private traceability");
    expect(createdIssue?.description).toContain("interpretation");
    // AREA-3: the QA/validator guidance line is gated on !graphWorkProductRequired,
    // so a producer step must NOT receive it — it would contradict the [ARTIFACT]
    // FINAL LINE RULE above. QA/validator steps (flag=false) still get the line.
    expect(createdIssue?.description).not.toContain("For QA/validator steps");
    expect(createdIssue?.description).not.toContain("POST /api/issues/{issueId}/work-products");
  });
}

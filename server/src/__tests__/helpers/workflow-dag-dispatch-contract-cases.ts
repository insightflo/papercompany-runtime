import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagDispatchContractCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("renders the step dispatch contract in issue instructions and QA rubric dependency contracts", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-step-contract-${companyId}`;

    heartbeatWakeup.mockResolvedValue({ id: "queued-step-contract" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Step Contract",
      issuePrefix: `SC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      workProductRoot,
    });
    await db.insert(agents).values([
      {
        id: producerAgentId,
        companyId,
        name: "Producer Agent",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Agent",
        role: "validator",
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
      title: "Step contract mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Step Contract Workflow",
      stepsJson: [
        {
          id: "collect-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write evidence.json.",
          graphWorkProductRequired: true,
          contract: {
            preconditions: ["Data source brief is registered"],
            postconditions: ["evidence.json exists in the step output directory"],
            undefinedBehaviors: ["If the data source is unreachable, evidence content is undefined — report blocked instead of guessing"],
          },
        },
        {
          id: "summarize",
          name: "Summarize",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write a summary without any contract.",
          graphWorkProductRequired: false,
        },
        {
          id: "audit-evidence", qaType: "semantic",
          name: "Audit evidence",
          agentId: qaAgentId,
          dependencies: ["collect-evidence"],
          description: "Validate the dependency workProduct.",
          graphWorkProductRequired: false,
          contract: {
            postconditions: ["Verdict submitted via /workflow/verdict"],
          },
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
      runDate: "2026-06-26",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const producerStepRun = stepRuns.find((row) => row.stepId === "collect-evidence")!;
    const producerIssueId = producerStepRun.issueId!;
    const summarizeStepRun = stepRuns.find((row) => row.stepId === "summarize")!;

    // [B안] producer step 계약이 발주 이슈 지침에 구조 섹션으로 주입된다.
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
    const producerDescription = producerIssue.description ?? "";
    expect(producerDescription).toContain("Step contract:");
    expect(producerDescription).toContain("Preconditions (verify before starting; report blocked if unmet):");
    expect(producerDescription).toContain("Data source brief is registered");
    expect(producerDescription).toContain("Postconditions (must hold when you mark this step complete):");
    expect(producerDescription).toContain("evidence.json exists in the step output directory");
    expect(producerDescription).toContain("Undefined behaviors (outcome is NOT guaranteed; stop and report instead of guessing):");
    expect(producerDescription).toContain("If the data source is unreachable, evidence content is undefined — report blocked instead of guessing");

    // 계약 없는 스텝은 섹션 자체가 없어야 한다.
    const [summarizeIssue] = await db.select().from(issues).where(eq(issues.id, summarizeStepRun.issueId!));
    expect((summarizeIssue.description ?? "")).not.toContain("Step contract:");

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "file",
      provider: "local",
      externalId: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: {
        path: `${workProductRoot}/missions/${missionId}/runs/${runId}/steps/collect-evidence/evidence.json`,
      },
    });
    await issueService(db).update(producerIssueId, { status: "done" });
    await syncWorkflowRunForIssue(db, producerIssueId);

    stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const qaStepRun = stepRuns.find((row) => row.stepId === "audit-evidence")!;
    expect(qaStepRun.issueId).toBeTruthy();

    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qaStepRun.issueId!));
    const qaDescription = qaIssue.description ?? "";
    // QA 스텝 자체 계약도 이슈 지침에 주입된다.
    expect(qaDescription).toContain("Step contract:");
    expect(qaDescription).toContain("Verdict submitted via /workflow/verdict");

    // 의존 producer 스텝의 계약(사후조건·미정의동작)이 QA 루브릭에 전달된다.
    const rubricPath = qaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    expect(fs.existsSync(rubricPath!)).toBe(true);
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Dependency step contracts");
    expect(rubric).toContain("collect-evidence");
    expect(rubric).toContain("evidence.json exists in the step output directory");
    expect(rubric).toContain("If the data source is unreachable, evidence content is undefined — report blocked instead of guessing");
  });
}

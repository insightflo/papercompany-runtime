import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, companies, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { executeWorkflowRun, syncWorkflowRunForIssue } from "../../services/workflow/dag-engine.js";

export function registerWorkflowDagQaRubricCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  it("writes QA step grading criteria to a rubric markdown file and gives the QA agent only that path", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const missionId = randomUUID();
    const workProductRoot = `/tmp/wf-qa-rubric-${companyId}`;
    const criteriaText = [
      "Report Validator step.",
      "Check Top25 rank coverage, duplicate/missing entries, source URL presence,",
      "collection timestamp, fallback notes, confidence labels, and whether any item should be excluded from synthesis.",
      "Return PASS or REQUEST_CHANGES with exact gaps.",
    ].join(" ");

    heartbeatWakeup.mockResolvedValue({ id: "queued-qa-rubric" });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip QA Rubric",
      issuePrefix: `QR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "QA rubric mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "QA Rubric Workflow",
      stepsJson: [
        {
          id: "collect-evidence",
          name: "Collect evidence",
          agentId: producerAgentId,
          dependencies: [],
          description: "Write evidence.json.",
          graphWorkProductRequired: true,
        },
        {
          id: "audit-evidence", qaType: "semantic",
          name: "Audit evidence",
          agentId: qaAgentId,
          dependencies: ["collect-evidence"],
          description: criteriaText,
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
      runDate: "2026-06-25",
    });

    await executeWorkflowRun(db, runId);
    let stepRuns = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const producerStepRun = stepRuns.find((row) => row.stepId === "collect-evidence")!;
    const producerIssueId = producerStepRun.issueId!;

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

    const [qaIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, qaStepRun.issueId!));

    const qaDescription = qaIssue.description ?? "";
    expect(qaDescription).toContain("QA grading rubric:");
    expect(qaDescription).toContain("qa-rubric.md");
    expect(qaDescription).toContain("Workflow API closeout:");
    expect(qaDescription).toContain("/workflow/verdict");
    expect(qaDescription).toContain("/workflow/complete");
    // [findings 계약 교육] closeout 도 findings 병기 계약을 가르친다 — 루브릭과 동일 스키마.
    expect(qaDescription).toContain("`REQUEST_CHANGES` requires `findings`");
    expect(qaDescription).toContain("one entry per blocking defect with `id`, `summary`, `layer`");
    expect(qaDescription).toContain("`REQUEST_CHANGES` requires one findings entry per blocking defect");
    // [remediations 계약 교육] 클로짓아웃 표면도 가르친다 — 루브릭과 동일 계약.
    expect(qaDescription).toContain("`REQUEST_CHANGES` may attach `remediations` only when every defect is a purely mechanical string replacement");
    expect(qaDescription).toContain("`find` must occur exactly once in the file");
    expect(qaDescription).not.toContain("Check Top25 rank coverage");
    expect(qaDescription).not.toContain("collection timestamp, fallback notes");
    expect(qaDescription).not.toContain("Deliverable output (use exactly this directory):");
    expect(qaDescription).not.toContain("[ARTIFACT]:");

    const rubricPath = qaDescription.match(/- (\/.*qa-rubric\.md)/)?.[1];
    expect(rubricPath).toBeTruthy();
    expect(fs.existsSync(rubricPath!)).toBe(true);
    const rubric = fs.readFileSync(rubricPath!, "utf8");
    expect(rubric).toContain("Check Top25 rank coverage");
    expect(rubric).toContain("Return PASS or REQUEST_CHANGES with exact gaps.");
    expect(rubric).toContain(`workflowRunId: ${runId}`);
    expect(rubric).toContain("collect-evidence");
    expect(rubric).toContain("evidence.json");
    expect(rubric).toContain("Mission quality contract");
    expect(rubric).toContain("purpose-fitness first");
    expect(rubric).toContain("Adaptive quality profile");
    expect(rubric).toContain("Outcome review standard");
    expect(rubric).toContain("REQUEST_CHANGES only for an observed blocking defect");
    expect(rubric).toContain("A failed checklist item or probe is evidence to assess, not an automatic blocking verdict");
    expect(rubric).toContain("Return `PASS` when no blocking defect remains");
    // [findings 계약 교육] REQUEST_CHANGES 는 findings 병기가 공식 계약 — reason-글쩍 단독 가르침은 소멸.
    expect(rubric).toContain("must carry `findings` — one entry per blocking defect");
    // [remediations 계약 교육] 순수 기계적 결함의 remediations 계약도 엔진 표면이 가르친다
    //   — 참조 파일 수작업 오버레이(MECHANICAL_REMEDIATION_CONTRACT_V1) 제거 근거.
    expect(rubric).toContain("also attach `remediations` to the REQUEST_CHANGES body");
    expect(rubric).toContain("{\"op\":\"string_replace\"");
    expect(rubric).toContain("max 20 items");
    expect(rubric).toContain("falls back to producer rework");
    expect(rubric).toContain("do not attach `remediations`");
    expect(rubric).toContain("`artifact` = the produced deliverable, `source_data` = upstream source data");
    expect(rubric).toContain("mislayered findings are themselves recorded as verdict-quality defects");
    expect(rubric).toContain("Keep `reason` to concise human context");
    expect(rubric).not.toContain("REQUEST_CHANGES: <specific gaps>");
    expect(rubric).not.toContain("End the final answer with one clear verdict");
    expect(rubric).not.toContain("Return `PASS` only when the dependency workProducts meet every criterion above");
    expect(rubric).not.toContain("when any criterion is missing, ambiguous, stale, or unsupported");
    expect(rubric).not.toContain("5-axis scoring");
    expect(rubric).toContain("Evidence explanation quality");
    expect(rubric).toContain("source content -> observation -> interpretation -> conclusion");
    expect(rubric).toContain("storage fields, internal filenames, manifests, or workProduct paths");
    // [Verification Before Completion] QA verdict must be based on fresh claim/evidence checks.
    expect(rubric).toContain("Verification Before Completion");
    expect(rubric).toContain("fresh evidence");
    expect(rubric).toContain("direct dependency workProducts");
    expect(rubric).not.toContain("Identify every completion claim");
    expect(rubric).not.toContain("final user-visible or machine-consumed output contract");
    expect(rubric).toContain("notVerified");
  });
}

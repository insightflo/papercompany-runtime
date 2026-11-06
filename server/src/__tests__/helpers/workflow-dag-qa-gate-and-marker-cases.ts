import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, type Mock } from "vitest";
import { agents, issueComments, issueExecutionCards, issueWorkProducts, issues, missions, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { buildRuntimeSearchPathPermissions } from "../../services/runtime-search-path-permissions.js";
import { createWorkflowDependencyFixture } from "./workflow-dependency-fixture.js";

export function registerWorkflowDagQaGateAndMarkerCases(
  getDb: () => ReturnType<typeof createDb>,
  heartbeatWakeup: Mock,
) {
  const { executeDependencyWorkflow, recordWorkflowVerdictForIssue, completeStepIssue, getStepIssue } = createWorkflowDependencyFixture(getDb, heartbeatWakeup);

  it("treats QA gate dependencies as pass gates and forwards checked producer workProducts", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const collectorAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const outlineAgentId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact QA Gate Forwarding",
      missionId: randomUUID(),
      workflowId: randomUUID(),
      runId,
      agents: [
        { id: collectorAgentId, name: "Collector", role: "researcher" },
        { id: validatorAgentId, name: "Validator", role: "validator" },
        { id: outlineAgentId, name: "Outline Writer", role: "editor" },
      ],
      steps: [
        {
          id: "collect",
          name: "Collect evidence",
          agentId: collectorAgentId,
          dependencies: [],
          description: "Collect evidence.",
          graphWorkProductRequired: true,
        },
        {
          id: "audit",
          name: "Audit evidence",
          agentId: validatorAgentId,
          dependencies: ["collect"],
          description: "Return PASS or REQUEST_CHANGES.",
          graphWorkProductRequired: false,
        },
        {
          id: "outline",
          name: "Draft outline",
          agentId: outlineAgentId,
          dependencies: ["audit"],
          description: "Read the collected evidence and write outline.md.",
          graphWorkProductRequired: true,
        },
      ],
    });

    const evidencePath = "/srv/papercompany/projects/research-company/produced_work/missions/run/steps/collect/evidence.json";
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: upstream.collect!.id,
      type: "file",
      provider: "local",
      externalId: evidencePath,
      title: "evidence.json",
      status: "active",
      isPrimary: true,
      metadata: { path: evidencePath },
    });
    await completeStepIssue(upstream.collect!.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    await db.insert(issueComments).values({
      companyId,
      issueId: auditIssue!.id,
      authorAgentId: validatorAgentId,
      body: "Coverage checked.\nPASS",
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
    await recordWorkflowVerdictForIssue(auditIssue!.id, "pass", "2026-06-24T06:06:00.000Z");
    await completeStepIssue(auditIssue!.id);

    const outlineIssue = await getStepIssue(runId, "outline");
    expect(outlineIssue).toBeTruthy();
    const desc = outlineIssue!.description ?? "";
    expect(desc).toContain("audit:"); // keep the gate visible in dependency inputs
    expect(desc).toContain("gate dependency passed without its own workProduct");
    expect(desc).toContain("Validated upstream workProducts:");
    expect(desc).toContain("collect: ");
    expect(desc).toContain("evidence.json [file/active]");
    expect(desc).toContain(evidencePath);
    expect(desc).not.toContain(`- audit: ${auditIssue!.identifier ?? auditIssue!.id} has no registered dependency workProduct.`);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");

    const outlineCard = await db
      .select({ cardJson: issueExecutionCards.cardJson })
      .from(issueExecutionCards)
      .where(eq(issueExecutionCards.issueId, outlineIssue!.id))
      .then((rows) => rows[0]?.cardJson ?? null);
    expect(outlineCard?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "dependency_work_product",
        path: evidencePath,
      }),
    ]));
    const unrelatedIssue = await issueService(db).create(companyId, {
      title: "Unrelated workProduct source",
      description: "Outside the current workflow run.",
      status: "done",
    });
    const unrelatedProductId = randomUUID();
    const archivedProductId = randomUUID();
    const delegatedProductId = randomUUID();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: "same-run-sibling",
      issueId: unrelatedIssue.id,
      status: "completed",
    });
    await db.insert(issueWorkProducts).values([
      {
        id: unrelatedProductId,
        companyId,
        issueId: unrelatedIssue.id,
        type: "file",
        provider: "local",
        title: "unrelated.md",
        status: "active",
        metadata: { path: "/srv/papercompany/projects/research-company/unrelated.md" },
      },
      {
        id: archivedProductId,
        companyId,
        issueId: upstream.collect!.id,
        type: "file",
        provider: "local",
        title: "archived.md",
        status: "archived",
        metadata: { path: "/srv/papercompany/projects/research-company/archived.md" },
      },
      {
        id: delegatedProductId,
        companyId,
        issueId: upstream.collect!.id,
        type: "file",
        provider: "delegated",
        title: "delegated.md",
        status: "active",
        metadata: { path: "/srv/papercompany/projects/other-company/delegated.md" },
      },
    ]);
    await db
      .update(issueExecutionCards)
      .set({
        cardJson: {
          ...outlineCard!,
          evidenceRefs: [
            ...outlineCard!.evidenceRefs,
            { type: "dependency_work_product", id: unrelatedProductId },
            { type: "dependency_work_product", id: archivedProductId },
            { type: "dependency_work_product", id: delegatedProductId },
          ],
        },
      })
      .where(eq(issueExecutionCards.issueId, outlineIssue!.id));
    const runtimeSearchPaths = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: outlineIssue!.id,
      workingDirectory: "/srv/papercompany/projects/research-company",
    });
    expect(runtimeSearchPaths).toMatchObject({
      version: 1,
      workingDirectory: "/srv/papercompany/projects/research-company",
      dependencyFiles: [evidencePath],
      dependencyDirectories: [
        "/srv/papercompany/projects/research-company/produced_work/missions/run/steps/collect",
      ],
    });
  });

  it("does not inject ARTIFACT markers from dependency or unrelated issue text", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentAId = randomUUID();
    const agentBId = randomUUID();
    const runId = randomUUID();
    const upstream = await executeDependencyWorkflow({
      companyId,
      companyName: "Structured Artifact Scope Guard",
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
    const depPath = "/srv/papercompany/produced_work/collect/evidence.json";
    const orphanPath = "/srv/papercompany/produced_work/orphan/unrelated.json";
    // The dependency description and an unrelated comment both contain non-authoritative markers.
    const collectIssue = upstream.collect!;
    await db
      .update(issues)
      .set({ description: `${collectIssue.description ?? ""}\n[ARTIFACT]: ${depPath}` })
      .where(eq(issues.id, collectIssue.id));
    // The unrelated issue remains outside the workflow dependency scope.
    const orphanIssue = await issueService(db).create(companyId, {
      title: "Unrelated orphan issue",
      description: "Not part of this workflow run",
      status: "todo",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: orphanIssue.id,
      authorAgentId: agentAId,
      body: `Some unrelated work.\n[ARTIFACT]: ${orphanPath}`,
      createdAt: new Date("2026-06-24T06:06:00.000Z"),
    });
    await completeStepIssue(collectIssue.id);

    const auditIssue = await getStepIssue(runId, "audit");
    expect(auditIssue).toBeTruthy();
    const desc = auditIssue!.description ?? "";
    expect(desc).toContain("workProducts: none registered");
    expect(desc).not.toContain(depPath);
    expect(desc).not.toContain(orphanPath);
    expect(desc).not.toContain("Dependency workProduct hard-stop:");
  });
}

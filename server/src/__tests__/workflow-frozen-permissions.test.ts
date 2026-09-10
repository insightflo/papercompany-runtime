import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  issueExecutionCards,
  issueWorkProducts,
  issues,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { buildRuntimeSearchPathPermissions } from "../services/runtime-search-path-permissions.js";
import { upsertWorkflowIssueExecutionCard } from "../services/issue-execution-cards/workflow-upsert.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  seedCompanyOnly,
  seedCompanyWithMission,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const WORKING_DIRECTORY = "/srv/papercompany/projects/frozen-permissions";
const TOOL_ARTIFACT_IN_SCOPE = `${WORKING_DIRECTORY}/tool-artifacts/summary.json`;
const TOOL_ARTIFACT_OUT_OF_SCOPE = "/srv/papercompany/other-company/leak.json";

describeEP("runtime search permissions follow the frozen execution definition (Task5a2c)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-permissions-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** producer A -> B, A -> A2, QA(B + conditional A2), unrelated U. */
  function capturedGraphStepsJson(agentId: string) {
    return [
      { id: "capture-a", name: "Capture A", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: "capture-b", name: "Capture B", agentId, dependencies: ["capture-a"] },
      { id: "capture-a2", name: "Capture A2", agentId, dependencies: ["capture-a"] },
      {
        id: "qa-review",
        name: "[QA] Review",
        agentId,
        qaType: "semantic",
        dependencies: ["capture-b"],
        conditionalDependencies: [{ stepId: "capture-a2", when: "always" }],
      },
      { id: "unrelated-u", name: "Unrelated U", agentId, dependencies: [] },
    ];
  }

  async function seedCapturedCardCase() {
    const { companyId, agentId, missionId } = await seedCompanyWithMission(fixture.sql, "FP" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "frozen-permissions-workflow",
      stepsJson: capturedGraphStepsJson(agentId),
    });
    const run = await createFrozenRun(db, { workflowId, companyId, missionId });
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    const capturedStep = execution.steps.find((step) => step.id === "qa-review");
    if (!capturedStep) throw new Error("captured qa-review step missing");

    const qaIssueId = randomUUID();
    const depAIssueId = randomUUID();
    const depA2IssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: qaIssueId, companyId, missionId, title: "[QA] Review",
        originKind: "workflow_execution", originId: run.id, originRunId: run.id,
        assigneeAgentId: agentId, status: "in_progress",
      },
      { id: depAIssueId, companyId, missionId, title: "Capture A", originKind: "workflow_execution", originRunId: run.id, status: "completed" },
      { id: depA2IssueId, companyId, missionId, title: "Capture A2", originKind: "workflow_execution", originRunId: run.id, status: "completed" },
      { id: unrelatedIssueId, companyId, missionId, title: "Unrelated U", originKind: "workflow_execution", originRunId: run.id, status: "completed" },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "qa-review", issueId: qaIssueId, status: "running" },
      { workflowRunId: run.id, stepId: "capture-a", issueId: depAIssueId, status: "completed" },
      { workflowRunId: run.id, stepId: "capture-a2", issueId: depA2IssueId, status: "completed" },
      { workflowRunId: run.id, stepId: "unrelated-u", issueId: unrelatedIssueId, status: "completed" },
    ]);
    const pathA = `${WORKING_DIRECTORY}/produced/a-report.md`;
    const pathA2 = `${WORKING_DIRECTORY}/produced/a2-summary.md`;
    const pathU = `${WORKING_DIRECTORY}/produced/u-leak.md`;
    await db.insert(issueWorkProducts).values([
      { companyId, issueId: depAIssueId, title: "a-report.md", type: "document", provider: "local_file", externalId: pathA, status: "active", metadata: { path: pathA } },
      { companyId, issueId: depA2IssueId, title: "a2-summary.md", type: "document", provider: "local_file", externalId: pathA2, status: "active", metadata: { path: pathA2 } },
      { companyId, issueId: unrelatedIssueId, title: "u-leak.md", type: "document", provider: "local_file", externalId: pathU, status: "active", metadata: { path: pathU } },
    ]);
    await upsertWorkflowIssueExecutionCard({
      db,
      companyId,
      issueId: qaIssueId,
      title: "[QA] Review",
      description: "Review the captured dependency work products.",
      assigneeAgentId: agentId,
      missionId,
      workflowDefinitionId: workflowId,
      workflowRunId: run.id,
      step: capturedStep,
      stepOutputDir: `${WORKING_DIRECTORY}/out`,
      evidenceRefs: [
        { type: "dependency_tool_artifact", path: TOOL_ARTIFACT_IN_SCOPE },
        { type: "dependency_tool_artifact", path: TOOL_ARTIFACT_OUT_OF_SCOPE },
      ],
    });
    return { companyId, agentId, missionId, workflowId, runId: run.id, issueId: qaIssueId };
  }

  function permissionsFor(companyId: string, issueId: string) {
    return buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId,
      workingDirectory: WORKING_DIRECTORY,
    });
  }

  it("keeps captured transitive dependency products (incl. conditional edge) after live QA dependency edits", async () => {
    const seeded = await seedCapturedCardCase();

    const before = await permissionsFor(seeded.companyId, seeded.issueId);
    expect(before).not.toBeNull();
    expect(before!.qaType).toBe("semantic");
    expect(before!.outputDirectory).toBe(`${WORKING_DIRECTORY}/out`);
    const expectedFiles = [
      TOOL_ARTIFACT_IN_SCOPE,
      `${WORKING_DIRECTORY}/produced/a-report.md`,
      `${WORKING_DIRECTORY}/produced/a2-summary.md`,
    ].sort();
    expect([...before!.dependencyFiles].sort()).toEqual(expectedFiles);
    expect(before!.dependencyFiles).not.toContain(`${WORKING_DIRECTORY}/produced/u-leak.md`);
    expect(before!.dependencyFiles).not.toContain(TOOL_ARTIFACT_OUT_OF_SCOPE);

    // Editor rewires the live QA step to the unrelated step and drops the conditional edge.
    const liveSteps = capturedGraphStepsJson(seeded.agentId).map((step) => {
      const record = step as Record<string, unknown>;
      if (record.id !== "qa-review") return step;
      return { ...record, dependencies: ["unrelated-u"], conditionalDependencies: [] };
    });
    await editLiveDefinition(db, seeded.workflowId, { stepsJson: liveSteps });

    const after = await permissionsFor(seeded.companyId, seeded.issueId);
    expect(after).not.toBeNull();
    // Frozen graph still decides dependency files: only captured products, never U.
    expect([...after!.dependencyFiles].sort()).toEqual(expectedFiles);
    expect(after!.dependencyFiles).not.toContain(`${WORKING_DIRECTORY}/produced/u-leak.md`);
    expect(after!.dependencyDirectories.sort()).toEqual(
      [`${WORKING_DIRECTORY}/produced`, `${WORKING_DIRECTORY}/tool-artifacts`].sort(),
    );
  });

  it("rejects with 422 and changes nothing when the expected snapshot is corrupt", async () => {
    const corrupted = await seedCapturedCardCase();
    const productsBefore = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts);
    await corruptSnapshotSteps(fixture.sql, corrupted.runId);
    await expect(permissionsFor(corrupted.companyId, corrupted.issueId))
      .rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    const productsAfterCorrupt = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts);
    expect(productsAfterCorrupt).toEqual(productsBefore);
  });

  it("rejects with 422 and changes nothing when the expected snapshot row is missing", async () => {
    const missing = await seedCapturedCardCase();
    const productsBefore = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts);
    await fixture.sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${missing.runId}`;
    await expect(permissionsFor(missing.companyId, missing.issueId))
      .rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    const productsAfterMissing = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts);
    expect(productsAfterMissing).toEqual(productsBefore);
  });

  it("does not leak products through a cross-company run and does not load the unscoped card run", async () => {
    const seeded = await seedCapturedCardCase();
    const other = await seedCompanyOnly(fixture.sql, "FQ" + randomUUID().slice(0, 4));
    const otherWorkflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: other.companyId,
      name: "other-company-frozen",
      stepsJson: [{ id: "other-step", name: "Other", agentId: "", dependencies: [] }],
    });
    const otherRun = await createFrozenRun(db, { workflowId: otherWorkflowId, companyId: other.companyId });
    // The foreign run gets a step-run row for this issue so the currentStep lookup resolves
    // BEFORE the company-scoped run query; only the scoped row guard can then stop the load.
    await db.insert(workflowStepRuns).values({
      workflowRunId: otherRun.id, stepId: "other-step", issueId: seeded.issueId, status: "running",
    });
    const stepRunPrecondition = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, otherRun.id),
        eq(workflowStepRuns.issueId, seeded.issueId),
      ));
    expect(stepRunPrecondition).toHaveLength(1);
    await corruptSnapshotSteps(fixture.sql, otherRun.id);
    await db.update(issueExecutionCards)
      .set({ workflowRunId: otherRun.id })
      .where(eq(issueExecutionCards.issueId, seeded.issueId));

    const permissions = await permissionsFor(seeded.companyId, seeded.issueId);
    // No 422: currentStep exists, so the empty result proves the company-scoped run guard
    // refuses to load the corrupt unscoped run (the loader would otherwise throw).
    expect(permissions).not.toBeNull();
    expect(permissions!.dependencyFiles).toEqual([]);
    expect(permissions!.dependencyDirectories).toEqual([]);
    expect(permissions!.qaType).toBe("semantic");
    expect(permissions!.dependencyFiles).toEqual([]);
    expect(permissions!.dependencyDirectories).toEqual([]);
    expect(permissions!.qaType).toBe("semantic");
  });
});

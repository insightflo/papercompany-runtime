import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  createDb,
  issueExecutionCards,
  issues,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";
import { resyncIssueExecutionCardAfterIssueUpdate } from "../services/issue-execution-cards/resync.js";
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

describeEP("issue execution card resync follows the frozen execution definition (Task5a2c)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-card-resync-");
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

  async function seedResyncCardCase() {
    const { companyId, agentId, missionId } = await seedCompanyWithMission(fixture.sql, "FC" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "frozen-card-resync-workflow",
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId, dependencies: [], graphWorkProductRequired: true },
        {
          id: "qa-review", name: "[QA] Review", agentId, qaType: "semantic",
          dependencies: ["produce"], toolNames: ["missionSearch"],
        },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId, missionId });
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    const capturedStep = execution.steps.find((step) => step.id === "qa-review");
    if (!capturedStep) throw new Error("captured qa-review step missing");

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "[QA] Review",
      description: "Review the captured dependency work products.",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
      originId: run.id,
      originRunId: run.id,
      status: "in_progress",
    });
    await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "qa-review", issueId, status: "running",
    });
    await upsertWorkflowIssueExecutionCard({
      db,
      companyId,
      issueId,
      title: "[QA] Review",
      description: "Review the captured dependency work products.",
      assigneeAgentId: agentId,
      missionId,
      workflowDefinitionId: workflowId,
      workflowRunId: run.id,
      step: capturedStep,
      stepOutputDir: "/srv/papercompany/projects/frozen-cards/out",
    });
    const [card] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issueId));
    if (!card) throw new Error("execution card was not created");
    return { companyId, agentId, missionId, workflowId, runId: run.id, issueId, card };
  }

  async function issueRowOf(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (!row) throw new Error("issue missing");
    return row;
  }

  async function cardOf(issueId: string) {
    const [row] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issueId));
    if (!row) throw new Error("card missing");
    return row;
  }

  function resyncCount() {
    return db.select({ id: activityLog.id }).from(activityLog)
      .where(eq(activityLog.action, "issue_execution_card.resynced"));
  }

  it("resyncs issue-owned fields but keeps captured graph fields, run binding, and hash consistency", async () => {
    const seeded = await seedResyncCardCase();
    await editLiveDefinition(db, seeded.workflowId, {
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId: seeded.agentId, dependencies: [], graphWorkProductRequired: true },
        {
          id: "qa-review", name: "[QA] Review live", agentId: seeded.agentId, qaType: "plan",
          dependencies: ["unrelated-u"], toolNames: ["repoSearch"],
        },
        { id: "unrelated-u", name: "Unrelated", agentId: seeded.agentId, dependencies: [] },
      ],
    });
    const issueNow = await issueRowOf(seeded.issueId);

    const result = await resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...issueNow, title: "[QA] Review — retitled", description: `${issueNow.description ?? ""}\n\nDelivery Verification:\n- Read back the public URL.` },
      actor: { actorType: "system", actorId: "task5a2c-test" },
    });
    expect(result).not.toBeNull();

    const after = await cardOf(seeded.issueId);
    // Issue-owned fields updated from the resync input.
    expect(after.cardJson.issue.title).toBe("[QA] Review — retitled");
    expect(after.cardJson.source.descriptionHash).not.toBe(seeded.card.cardJson.source.descriptionHash);
    // Captured graph fields survive the live step edit.
    expect(after.cardJson.workflow).toEqual(expect.objectContaining({
      definitionId: seeded.workflowId,
      runId: seeded.runId,
      stepId: "qa-review",
      qaType: "semantic",
      dependencyStepIds: ["produce"],
    }));
    expect(after.cardJson.toolPermissionContract?.requiredToolNames).toEqual(["missionSearch"]);
    expect(after.cardJson.requiredOutputs.workProduct.outputDir).toBe("/srv/papercompany/projects/frozen-cards/out");
    expect(after.workflowRunId).toBe(seeded.runId);
    expect(after.contentHash).toBe(result!.nextHash);
    expect(after.contentHash).toBe(hashStructuredValue(after.cardJson));

    const [audit] = await resyncCount();
    expect(audit).toBeTruthy();
  });

  it("still resyncs from the captured step when the editor removes the live step entirely", async () => {
    const seeded = await seedResyncCardCase();
    await editLiveDefinition(db, seeded.workflowId, {
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId: seeded.agentId, dependencies: [], graphWorkProductRequired: true },
      ],
    });
    const issueNow = await issueRowOf(seeded.issueId);

    const result = await resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...issueNow, title: "Retitled after live step removal" },
    });
    expect(result).not.toBeNull();

    const after = await cardOf(seeded.issueId);
    expect(after.cardJson.issue.title).toBe("Retitled after live step removal");
    expect(after.cardJson.workflow).toEqual(expect.objectContaining({
      definitionId: seeded.workflowId,
      runId: seeded.runId,
      stepId: "qa-review",
      qaType: "semantic",
      dependencyStepIds: ["produce"],
    }));
    expect(after.contentHash).toBe(result!.nextHash);
  });

  it("does not duplicate the audit entry when the same resync repeats", async () => {
    const seeded = await seedResyncCardCase();
    const issueNow = await issueRowOf(seeded.issueId);
    const input = { ...issueNow, title: "Retitled once" };

    const first = await resyncIssueExecutionCardAfterIssueUpdate({ db, issue: input });
    expect(first).not.toBeNull();
    expect((await resyncCount()).length).toBe(1);

    const second = await resyncIssueExecutionCardAfterIssueUpdate({ db, issue: input });
    expect(second).toBeNull();
    expect((await resyncCount()).length).toBe(1);
  });

  it("returns null and preserves the card when the card identity is not the run's actual definition binding", async () => {
    const seeded = await seedResyncCardCase();
    // Same-company definition with a same-id step of a different shape: the malformed
    // legacy card references it, but the run was created from another definition.
    const otherDefinitionId = await seedWorkflowDefinition(fixture.sql, {
      companyId: seeded.companyId,
      name: "other-shape-definition",
      stepsJson: [{ id: "qa-review", name: "[QA] Other shape", agentId: seeded.agentId, qaType: "plan", dependencies: [] }],
    });
    await db.update(issueExecutionCards).set({
      cardJson: {
        ...seeded.card.cardJson,
        workflow: { ...seeded.card.cardJson.workflow!, definitionId: otherDefinitionId },
      },
    }).where(eq(issueExecutionCards.id, seeded.card.id));
    const beforeCard = await cardOf(seeded.issueId);

    const issueNow = await issueRowOf(seeded.issueId);
    const result = await resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...issueNow, title: "Should never resync" },
    });
    expect(result).toBeNull();
    expect(await cardOf(seeded.issueId)).toEqual(beforeCard);
    expect((await resyncCount()).length).toBe(0);
  });

  it("returns null and preserves the card for a cross-company run binding", async () => {
    const seeded = await seedResyncCardCase();
    const other = await seedCompanyOnly(fixture.sql, "FR" + randomUUID().slice(0, 4));
    const otherDefinitionId = await seedWorkflowDefinition(fixture.sql, {
      companyId: other.companyId,
      name: "other-company-definition",
      stepsJson: [{ id: "qa-review", name: "[QA] Other company", agentId: "", qaType: "plan", dependencies: [] }],
    });
    const otherRun = await createFrozenRun(db, { workflowId: otherDefinitionId, companyId: other.companyId });
    // The card claims the foreign run AND the foreign definition — an internally consistent
    // binding that only the company scope can reject (no identity mismatch short-circuit).
    await db.update(issueExecutionCards).set({
      workflowRunId: otherRun.id,
      cardJson: {
        ...seeded.card.cardJson,
        workflow: { ...seeded.card.cardJson.workflow!, runId: otherRun.id, definitionId: otherDefinitionId },
      },
    }).where(eq(issueExecutionCards.id, seeded.card.id));
    const beforeCard = await cardOf(seeded.issueId);

    const issueNow = await issueRowOf(seeded.issueId);
    const result = await resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...issueNow, title: "Should never resync" },
    });
    expect(result).toBeNull();
    expect(await cardOf(seeded.issueId)).toEqual(beforeCard);
    expect((await resyncCount()).length).toBe(0);
  });

  it("rejects with 422 and preserves the card and audit when the expected snapshot is corrupt or missing", async () => {
    const corrupted = await seedResyncCardCase();
    await corruptSnapshotSteps(fixture.sql, corrupted.runId);
    const corruptedBefore = await cardOf(corrupted.issueId);
    const corruptedIssue = await issueRowOf(corrupted.issueId);
    await expect(resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...corruptedIssue, title: "Blocked by corrupt history" },
    })).rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    expect(await cardOf(corrupted.issueId)).toEqual(corruptedBefore);
    expect((await resyncCount()).length).toBe(0);

    const missing = await seedResyncCardCase();
    await fixture.sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${missing.runId}`;
    const missingBefore = await cardOf(missing.issueId);
    const missingIssue = await issueRowOf(missing.issueId);
    await expect(resyncIssueExecutionCardAfterIssueUpdate({
      db,
      issue: { ...missingIssue, title: "Blocked by missing history" },
    })).rejects.toMatchObject({ status: 422, message: "historical_definition_unproven" });
    expect(await cardOf(missing.issueId)).toEqual(missingBefore);
    expect((await resyncCount()).length).toBe(0);
  });
});

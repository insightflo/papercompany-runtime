import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  issueExecutionCards,
  issues,
  workflowRunDefinitions,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  markRunStatus,
  seedCompanyOnly,
  seedWorkflowDefinition,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { captureFrozenRecoveryState } from "./helpers/workflow-frozen-recovery-state.js";
import {
  recordWorkflowValidationVerdict,
  resolveWorkflowValidationContext,
} from "../services/workflow/validation-verdict-ledger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const QA_CAPTURED = [{ id: "verify-output", name: "Verify output", agentId: "", dependencies: [], type: "qa" }];
const LIVE_NORMALIZED = [{ id: "verify-output", name: "Verify output", agentId: "", dependencies: [], type: "tool" }];

describeEP("workflow frozen validation (captured step identity governs the verdict context)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-validation-");
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

  async function seedFrozenValidation(input: {
    stepsJson: unknown[];
    liveStepsJson?: unknown[];
    issueTitle?: string;
    stepStatus?: string;
  }) {
    const { companyId } = await seedCompanyOnly(fixture.sql, "FV" + randomUUID().slice(0, 4));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "frozen-validation",
      stepsJson: input.stepsJson,
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await markRunStatus(db, run.id, "running");
    const [issue] = await db.insert(issues).values({
      companyId,
      identifier: "FV-" + randomUUID().slice(0, 8),
      title: input.issueTitle ?? "plain verify issue",
      status: "in_progress",
      originKind: "workflow_execution",
      originRunId: run.id,
    }).returning();
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id,
      stepId: "verify-output",
      issueId: issue!.id,
      status: input.stepStatus ?? "running",
      startedAt: new Date(),
      iterationIndex: 0,
      metadata: {},
    }).returning();
    if (input.liveStepsJson) {
      await editLiveDefinition(db, workflowId, { stepsJson: input.liveStepsJson });
    }
    return { companyId, workflowId, runId: run.id, issueId: issue!.id, stepRunId: stepRun!.id };
  }

  async function reloadIssue(issueId: string) {
    return (await db.select().from(issues).where(eq(issues.id, issueId)).limit(1))[0]!;
  }

  async function verdictEvents(companyId: string, issueId: string) {
    return db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.issueId, issueId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    ));
  }

  it("a captured qa-typed plain-title step stays a validation candidate after the live step is normalized", async () => {
    const f = await seedFrozenValidation({ stepsJson: QA_CAPTURED, liveStepsJson: LIVE_NORMALIZED });
    const issue = await reloadIssue(f.issueId);

    const context = await resolveWorkflowValidationContext(db, issue);

    expect(context).toEqual({
      isCandidate: true,
      workflowRunId: f.runId,
      workflowStepRunId: f.stepRunId,
      stepId: "verify-output",
    });
  });

  it("the inverse live QA edit cannot turn a captured plain step into a candidate", async () => {
    const f = await seedFrozenValidation({
      stepsJson: LIVE_NORMALIZED,
      liveStepsJson: QA_CAPTURED,
    });
    const issue = await reloadIssue(f.issueId);

    const context = await resolveWorkflowValidationContext(db, issue);

    expect(context.isCandidate).toBe(false);
    expect(context.workflowStepRunId).toBe(f.stepRunId);
  });

  it("card verdict.required precedence still holds for a valid frozen snapshot", async () => {
    const f = await seedFrozenValidation({ stepsJson: QA_CAPTURED, liveStepsJson: LIVE_NORMALIZED });
    const issue = await reloadIssue(f.issueId);
    const insertCard = async (required: boolean) => {
      await db.insert(issueExecutionCards).values({
        companyId: f.companyId,
        issueId: f.issueId,
        cardVersion: 1,
        contentHash: "frozen-validation-" + required,
        cardJson: { requiredOutputs: { verdict: { required } } } as never,
        updatedAt: new Date(),
      });
    };

    await insertCard(false);
    expect((await resolveWorkflowValidationContext(db, issue)).isCandidate).toBe(false);
    await db.update(issueExecutionCards).set({ cardJson: { requiredOutputs: { verdict: { required: true } } } as never })
      .where(eq(issueExecutionCards.issueId, f.issueId));
    expect((await resolveWorkflowValidationContext(db, issue)).isCandidate).toBe(true);
  });

  it("recordWorkflowValidationVerdict inside db.transaction writes one scoped event with a valid frozen snapshot after live edit", async () => {
    const f = await seedFrozenValidation({ stepsJson: QA_CAPTURED, liveStepsJson: LIVE_NORMALIZED });
    const issue = await reloadIssue(f.issueId);

    const result = await db.transaction((tx) => recordWorkflowValidationVerdict({
      db: tx, issue, verdict: "pass", source: "workflow_api",
    }));

    expect(result).toMatchObject({
      satisfied: true,
      verdict: "pass",
      isCandidate: true,
      workflowRunId: f.runId,
      workflowStepRunId: f.stepRunId,
    });
    const events = await verdictEvents(f.companyId, f.issueId);
    expect(events).toHaveLength(1);
    expect(events[0]!.workflowRunId).toBe(f.runId);
    expect(events[0]!.workflowStepRunId).toBe(f.stepRunId);
    expect(events[0]!.verdict).toBe("pass");
  });

  const invalidHistoryCases = [
    ["missing", "no-card"], ["missing", "card.required:false"],
    ["corrupt", "no-card"], ["corrupt", "card.required:false"],
  ] as const;

  it.each(invalidHistoryCases)("with a %s frozen history and %s, both resolve and record reject 422 with no state change", async (state, cardCase) => {
    const f = await seedFrozenValidation({ stepsJson: QA_CAPTURED, liveStepsJson: LIVE_NORMALIZED });
    const issue = await reloadIssue(f.issueId);
    if (cardCase !== "no-card") {
      await db.insert(issueExecutionCards).values({
        companyId: f.companyId,
        issueId: f.issueId,
        cardVersion: 1,
        contentHash: "frozen-validation-false",
        cardJson: { requiredOutputs: { verdict: { required: false } } } as never,
        updatedAt: new Date(),
      });
    }
    if (state === "missing") {
      await db.delete(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, f.runId));
    } else {
      await corruptSnapshotSteps(fixture.sql, f.runId);
    }
    const before = await captureFrozenRecoveryState(db, f.runId);
    const cardsOf = () => db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, f.issueId));
    const beforeCards = await cardsOf();

    const resolveError = await captureHttpError(resolveWorkflowValidationContext(db, issue));
    expect(resolveError.status).toBe(422);
    expect(resolveError.message).toBe("historical_definition_unproven");

    const recordError = await captureHttpError(db.transaction((tx) => recordWorkflowValidationVerdict({
      db: tx, issue, verdict: "pass", source: "workflow_api",
    })));
    expect(recordError.status).toBe(422);
    expect(recordError.message).toBe("historical_definition_unproven");

    expect(await captureFrozenRecoveryState(db, f.runId)).toEqual(before);
    expect(await cardsOf()).toEqual(beforeCards);
    expect(await verdictEvents(f.companyId, f.issueId)).toHaveLength(0);
  });

  it("an unlinked issue keeps its ordinary non-candidate context", async () => {
    const f = await seedFrozenValidation({ stepsJson: QA_CAPTURED, liveStepsJson: LIVE_NORMALIZED });
    const [unlinked] = await db.insert(issues).values({
      companyId: f.companyId,
      identifier: "FV-UNLINKED",
      title: "unlinked issue",
      status: "todo",
      originKind: "workflow_execution",
    }).returning();

    const context = await resolveWorkflowValidationContext(db, (await reloadIssue(unlinked!.id)));

    expect(context).toEqual({
      isCandidate: false,
      workflowRunId: null,
      workflowStepRunId: null,
      stepId: null,
    });
  });
});

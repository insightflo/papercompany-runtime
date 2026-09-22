import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import "./helpers/workflow-control-node-boundary.js";
import {
  getStepRuns,
  installMechanicalQaExecutor,
  mirrorFixture,
  seedMirrorWorkflow,
} from "./helpers/workflow-mirror-dag-fixture.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import {
  settleConditionalSkip,
  type ConditionalStepObservation,
} from "../services/workflow/conditional-skip-settlement.js";

const { jsonbSettleBoundary } = vi.hoisted(() => ({
  jsonbSettleBoundary: vi.fn(),
}));

vi.mock("../services/workflow/conditional-skip-settlement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workflow/conditional-skip-settlement.js")>();
  jsonbSettleBoundary.mockImplementation(async (
    db: typeof mirrorFixture.db,
    input: Parameters<typeof actual.settleConditionalSkip>[1],
  ) => await actual.settleConditionalSkip(db, input));
  return { ...actual, settleConditionalSkip: jsonbSettleBoundary };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const nestedControls = {
  concurrencyKey: "conditional-jsonb",
  concurrencyLimit: 2,
  priority: "high",
};
const siblingIds = ["validator", "jsonb-sibling-1", "jsonb-sibling-2"];
type StepRow = typeof workflowStepRuns.$inferSelect;
type SettleInput = Parameters<typeof settleConditionalSkip>[1];
type MetadataProof = { observed: unknown; current: unknown } | null;
const jsonbCalls: Array<{
  targetStepId: string;
  resultKind: string;
  proof: MetadataProof;
}> = [];

async function actualSettle(db: typeof mirrorFixture.db, input: SettleInput) {
  const actual = await vi.importActual<typeof import("../services/workflow/conditional-skip-settlement.js")>(
    "../services/workflow/conditional-skip-settlement.js",
  );
  return await actual.settleConditionalSkip(db, input);
}

async function recordingSettle(db: typeof mirrorFixture.db, input: SettleInput) {
  const observedValidator = input.observedPredecessors.find((row) => row.stepId === "validator");
  let proof: MetadataProof = null;
  if (observedValidator) {
    const [currentValidator] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, observedValidator.id));
    proof = {
      observed: observedValidator.metadata,
      current: currentValidator?.metadata ?? null,
    };
  }
  const result = await actualSettle(db, input);
  jsonbCalls.push({
    targetStepId: input.target.stepId,
    resultKind: result.kind,
    proof,
  });
  return result;
}

function restoreDefaultSettleBoundary() {
  jsonbSettleBoundary.mockReset();
  jsonbSettleBoundary.mockImplementation(recordingSettle);
}

restoreDefaultSettleBoundary();

function observation(row: StepRow): ConditionalStepObservation {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    stepId: row.stepId,
    status: row.status,
    issueId: row.issueId,
    startedAt: row.startedAt,
    lastDispatchAttemptAt: row.lastDispatchAttemptAt,
    dispatchReadyAt: row.dispatchReadyAt,
    executionGeneration: row.executionGeneration,
    metadata: row.metadata,
  };
}

function stepMap(runId: string, rows: StepRow[]) {
  return new Map(rows.filter((row) => row.workflowRunId === runId).map((row) => [row.stepId, row]));
}

async function getRun(runId: string) {
  const [row] = await mirrorFixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  expect(row).toBeTruthy();
  return row!;
}

async function resetPending(runId: string, stepIds: string[]) {
  const rows = await getStepRuns(runId);
  const byStepId = stepMap(runId, rows);
  for (const stepId of stepIds) {
    const row = byStepId.get(stepId)!;
    expect(row).toMatchObject({ status: "skipped", issueId: null });
    const metadata = { ...(row.metadata ?? {}) as Record<string, unknown> };
    delete metadata.controlFlowSkipped;
    await mirrorFixture.db.update(workflowStepRuns).set({
      status: "pending",
      issueId: null,
      startedAt: null,
      lastDispatchAttemptAt: null,
      completedAt: null,
      dispatchReadyAt: null,
      evidenceReadyAt: null,
      dispatchOwnerWakeupRequestId: null,
      dispatchOwnerHeartbeatRunId: null,
      metadata,
    }).where(eq(workflowStepRuns.id, row.id));
  }
}

async function updateFixtureDefinition(
  runId: string,
  transform: (steps: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
) {
  const run = await getRun(runId);
  const [definition] = await mirrorFixture.db.select().from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, run.workflowId));
  expect(definition).toBeTruthy();
  const nextSteps = transform(definition!.stepsJson as Array<Record<string, unknown>>);
  await mirrorFixture.db.update(workflowDefinitions).set({
    stepsJson: nextSteps as never,
  }).where(eq(workflowDefinitions.id, definition!.id));
}

function withControls(stepIds: string[]) {
  const targets = new Set(stepIds);
  return (steps: Array<Record<string, unknown>>) => steps.map((step) => targets.has(String(step.id))
    ? { ...step, executionControls: nestedControls }
    : step);
}

function withThreeFalseBranchSiblings(steps: Array<Record<string, unknown>>) {
  const validatorIndex = steps.findIndex((step) => step.id === "validator");
  expect(validatorIndex).toBeGreaterThanOrEqual(0);
  const validator = steps[validatorIndex]!;
  const extras = [1, 2].map((index) => ({
    ...validator,
    id: "jsonb-sibling-" + index,
    name: "JSONB sibling " + index,
    executionControls: nestedControls,
  }));
  const nextSteps = [...steps];
  nextSteps.splice(validatorIndex + 1, 0, ...extras);
  return nextSteps.map((step) => siblingIds.includes(String(step.id))
    ? { ...step, executionControls: nestedControls }
    : step);
}

describeEmbeddedPostgres("conditional skip predecessor JSONB equality", () => {
  afterEach(async () => {
    jsonbCalls.length = 0;
    restoreDefaultSettleBoundary();
  });

  it("settles the real helper when JSONB reorders local nested object keys", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    await updateFixtureDefinition(seed.runId, withControls(["validator", "mirror"]));
    await resetPending(seed.runId, ["validator", "mirror"]);
    const rows = await getStepRuns(seed.runId);
    const byStepId = stepMap(seed.runId, rows);
    const validator = byStepId.get("validator")!;
    const mirror = byStepId.get("mirror")!;
    const run = await getRun(seed.runId);
    const validatorMetadata = {
      ...(validator.metadata ?? {}) as Record<string, unknown>,
      executionControls: nestedControls,
      controlFlowSkipped: true,
    };

    const first = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(validator),
      nextMetadata: validatorMetadata,
      observedPredecessors: rows.filter((row) => row.id !== validator.id).map(observation),
    });
    expect(first).toMatchObject({ kind: "settled", stepRunId: validator.id });
    const validatorRows = await getStepRuns(seed.runId);
    const storedValidator = stepMap(seed.runId, validatorRows).get("validator")!;
    expect(storedValidator.metadata).toEqual(validatorMetadata);
    expect(JSON.stringify(storedValidator.metadata)).not.toBe(JSON.stringify(validatorMetadata));
    const storedControls = (storedValidator.metadata as Record<string, unknown>).executionControls;
    expect(storedControls).toEqual(nestedControls);
    expect(JSON.stringify(storedControls)).not.toBe(JSON.stringify(nestedControls));

    const localValidator = observation({ ...storedValidator, metadata: validatorMetadata });
    const second = await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(mirror),
      nextMetadata: {
        ...(mirror.metadata ?? {}) as Record<string, unknown>,
        executionControls: nestedControls,
        controlFlowSkipped: true,
      },
      observedPredecessors: rows.filter((row) => row.id !== mirror.id)
        .map((row) => row.id === validator.id ? localValidator : observation(row)),
    });
    expect(second).toMatchObject({ kind: "settled", stepRunId: mirror.id });
    const finalRows = await getStepRuns(seed.runId);
    const finalById = stepMap(seed.runId, finalRows);
    expect(finalById.get("mirror")).toMatchObject({ status: "skipped", issueId: null });
  });

  it("still rejects semantic metadata changes, including array order changes", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    await updateFixtureDefinition(seed.runId, withControls(["validator", "mirror"]));
    await resetPending(seed.runId, ["mirror"]);
    const rows = await getStepRuns(seed.runId);
    const byStepId = stepMap(seed.runId, rows);
    const validator = byStepId.get("validator")!;
    const mirror = byStepId.get("mirror")!;
    const run = await getRun(seed.runId);
    const baseMetadata = {
      ...(validator.metadata ?? {}) as Record<string, unknown>,
      executionControls: nestedControls,
      ordered: ["first", "second"],
    };
    await mirrorFixture.db.update(workflowStepRuns)
      .set({ metadata: baseMetadata })
      .where(eq(workflowStepRuns.id, validator.id));
    const validatorRows = await getStepRuns(seed.runId);
    const storedValidator = stepMap(seed.runId, validatorRows).get("validator")!;
    expect(storedValidator.metadata).toEqual(baseMetadata);
    const changedMetadata = async (patch: Record<string, unknown>) => await settleConditionalSkip(mirrorFixture.db, {
      observedRun: run,
      target: observation(mirror),
      nextMetadata: { ...(mirror.metadata ?? {}) as Record<string, unknown>, controlFlowSkipped: true },
      observedPredecessors: [observation({
        ...storedValidator,
        metadata: { ...storedValidator.metadata, ...patch },
      })],
    });

    const changedValue = await changedMetadata({ executionControls: { ...nestedControls, concurrencyLimit: 3 } });
    const changedArray = await changedMetadata({ ordered: ["second", "first"] });
    const [pendingMirror] = await mirrorFixture.db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, mirror.id));

    expect(changedValue).toEqual({ kind: "no-op" });
    expect(changedArray).toEqual({ kind: "no-op" });
    expect(pendingMirror).toMatchObject({ status: "pending", issueId: null });
    const unchanged = await changedMetadata({});
    expect(unchanged).toMatchObject({ kind: "settled", stepRunId: mirror.id });
    const settledRows = await getStepRuns(seed.runId);
    expect(stepMap(seed.runId, settledRows).get("mirror")).toMatchObject({
      status: "skipped",
      issueId: null,
    });
  });

  it("keeps three false-branch siblings settled in one propagation pass", async () => {
    installMechanicalQaExecutor();
    const seed = await seedMirrorWorkflow("true");
    await updateFixtureDefinition(seed.runId, withThreeFalseBranchSiblings);
    await resetPending(seed.runId, ["validator"]);
    jsonbCalls.length = 0;

    await syncWorkflowRunState(mirrorFixture.db, seed.runId, "workflow_sync");

    const after = stepMap(seed.runId, await getStepRuns(seed.runId));
    for (const stepId of siblingIds) {
      expect(after.get(stepId)).toMatchObject({
        status: "skipped",
        issueId: null,
        dispatchReadyAt: expect.any(Date),
      });
      expect(after.get(stepId)?.metadata).toMatchObject({
        controlFlowSkipped: true,
        executionControls: nestedControls,
      });
    }
    expect(jsonbCalls.map((call) => call.targetStepId)).toEqual(siblingIds);
    expect(jsonbCalls.map((call) => call.resultKind)).toEqual(["settled", "settled", "settled"]);
    const proof = jsonbCalls[1]?.proof;
    expect(proof).toBeTruthy();
    expect(proof!.current).toEqual(proof!.observed);
    expect(JSON.stringify(proof!.current)).not.toBe(JSON.stringify(proof!.observed));
  });
});

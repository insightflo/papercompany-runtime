import { and, eq, sql } from "drizzle-orm";
import { pluginToolExecutionReceipts, toolDefinitions, workflowQaRebindClaims, workflowRuns,
  workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { artifactDagFixture } from "./helpers/artifact-dag-fixture.js";
import { decodeRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";
import { bindRetainedWorkflowTool, finalizeRetainedWorkflowTool,
  type RetainedWorkflowHooks } from "../services/workflow/retained-tool-completion.js";
import { captureExecutionDefinition, loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { readQaRebindContext } from "../services/workflow/qa-rebind-evidence.js";

const acceptedAt = "2026-10-29T00:00:00.000Z";
const actual: ToolOutcome = { kind: "error", error: { code: -32000, message: "publication failed", data: { detail: "full actual" } },
  response: { jsonrpc: "2.0", id: 91, error: { code: -32000, message: "publication failed", data: { detail: "full actual" } } } };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function hooks(): RetainedWorkflowHooks {
  return {
    normalizeRecord: record,
    getMetadataRecord: (value, key) => record(record(value)[key]),
    readMetadataString: value => typeof value === "string" && value.trim() ? value.trim() : undefined,
    buildWorkflowStepRunMetadata: (step, metadata) => ({ ...record(metadata),
      ...(step.executionControls ? { executionControls: step.executionControls } : {}),
      graphWorkProductRequired: step.graphWorkProductRequired === true }),
    syncWorkflowRunStateWithOutcome: vi.fn(async () => ({ kind: "synced", result: { status: "running" } as never })),
  };
}

it("rolls back retained failure completion when eligible observation INSERT fails, then finalizes the same staged actual once", async () => {
  const f = await artifactDagFixture(true);
  const requestId = "publisher-retained-attempt-1";
  await f.db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 },
    startedAt: null, completedAt: null }).where(eq(workflowRuns.id, f.runId));
  await f.db.transaction(tx => captureExecutionDefinition(tx, f.runId));
  await f.db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const qaResult = await f.invoke();
  expect(qaResult.status).toBe(200);
  await f.complete("qa", qaResult);
  const captured = await loadExecutionDefinition(f.db, f.runId, { requireHistorical: true });
  expect(captured.source).toBe("snapshot");
  const spec = captured.steps.find(step => step.id === "publisher");
  expect(spec?.toolArtifactContract).toMatchObject({ role: "publication" });
  if (!spec) throw new Error("captured publication step missing");
  const [tool] = await f.db.select().from(toolDefinitions).where(and(
    eq(toolDefinitions.companyId, f.companyId), eq(toolDefinitions.name, "publisher")));
  const parameters = await f.resolve("publisher");
  const [initialStep] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  await f.db.update(workflowStepRuns).set({ status: "running", executionGeneration: 2,
    lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt), lastDispatchErrorAt: null,
    metadata: { ...initialStep.metadata,
      artifactExecution: freezeArtifactAttempt({ adapterConfig: tool.adapterConfig, step: spec, executionGeneration: 2, requestId }),
      toolQueue: { status: "claimed", claimedAt: acceptedAt },
      toolInvocation: { requestId, toolName: "publisher", args: parameters },
    },
  }).where(eq(workflowStepRuns.id, f.publishId));
  const [step] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  const scope = { companyId: f.companyId, tool: "publisher", parameters, workflow: {
    missionId: f.missionId, workflowRunId: f.runId, stepRunId: f.publishId, stepId: "publisher", requestId,
    executionGeneration: 2, statusTransitionVersion: step.statusTransitionVersion,
    runStatus: "running" as const, stepStatus: "running" as const, acceptedAt,
  } };
  const eligibility = await readQaRebindContext(f.db, { companyId: f.companyId,
    workflowRunId: f.runId, consumerStepRunId: f.publishId });
  expect(eligibility).not.toBeNull();
  if (!eligibility) throw new Error("publication observation context missing");
  expect(eligibility.execution?.source).toBe("snapshot");
  expect(eligibility.frozen?.contract.role).toBe("publication");
  expect(eligibility).toMatchObject({ role: "publication", step: { issueId: null, status: "running" } });
  expect(eligibility.expectedDigests).not.toBeNull();

  const bound = await bindRetainedWorkflowTool(f.db, scope);
  expect(bound.kind).toBe("claim");
  if (bound.kind !== "claim") throw new Error("retained workflow claim missing");
  const owner = bound.owner;
  const before = (await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId)))[0];
  const completionHooks = hooks();

  await f.db.execute(sql`CREATE SEQUENCE p5b3b_observation_fault_hits START 1`);
  await f.db.execute(sql`CREATE FUNCTION p5b3b_observation_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM nextval('p5b3b_observation_fault_hits');
    RAISE EXCEPTION 'p5b3b_observation_insert_fault';
  END $$`);
  await f.db.execute(sql`CREATE TRIGGER p5b3b_observation_reject BEFORE INSERT ON workflow_qa_rebind_claims
    FOR EACH ROW EXECUTE FUNCTION p5b3b_observation_reject()`);
  try {
    await expect(finalizeRetainedWorkflowTool(f.db, owner, actual, completionHooks))
      .rejects.toThrow("retained_failure_observation_missing");
    const fault = await f.db.$client.unsafe("SELECT last_value, is_called FROM p5b3b_observation_fault_hits");
    expect(Number(fault[0].last_value)).toBe(1);
    expect(fault[0].is_called).toBe(true);
    expect((await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId)))[0]).toEqual(before);
    expect(await f.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.publishId))).toHaveLength(0);
    const [stagedRow] = await f.db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
    expect(stagedRow).toMatchObject({ status: "executing", resultStatus: null, completedAt: null });
    const stagedOutcome = decodeRetainedToolOutcome(stagedRow.resultBody);
    expect(stagedOutcome?.actual).toEqual(actual);
    expect(stagedOutcome?.disposition).toBeUndefined();
    expect(await bindRetainedWorkflowTool(f.db, scope)).toEqual({ kind: "held" });
    expect(completionHooks.syncWorkflowRunStateWithOutcome).not.toHaveBeenCalled();
  } finally {
    await f.db.execute(sql`DROP TRIGGER IF EXISTS p5b3b_observation_reject ON workflow_qa_rebind_claims`);
    await f.db.execute(sql`DROP FUNCTION IF EXISTS p5b3b_observation_reject()`);
    await f.db.execute(sql`DROP SEQUENCE IF EXISTS p5b3b_observation_fault_hits`);
  }

  expect(await finalizeRetainedWorkflowTool(f.db, owner, actual, completionHooks)).toMatchObject({ kind: "applied" });
  const [completedStep] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.publishId));
  expect(completedStep.status).toBe("failed");
  expect(completedStep.statusTransitionVersion).toBe(before.statusTransitionVersion + 1);
  expect(await f.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.publishId))).toHaveLength(1);
  const [completedReceipt] = await f.db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
  expect(completedReceipt).toMatchObject({ status: "completed", resultStatus: null });
  expect(decodeRetainedToolOutcome(completedReceipt.resultBody)).toMatchObject({ actual,
    disposition: { kind: "applied", reason: "current_owner", workflow: scope.workflow } });
  const observations = await f.db.select().from(workflowQaRebindClaims).where(and(
    eq(workflowQaRebindClaims.companyId, f.companyId), eq(workflowQaRebindClaims.workflowRunId, f.runId),
    eq(workflowQaRebindClaims.consumerStepRunId, f.publishId)));
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ status: "candidate", bundleDigest: eligibility.bundleDigest,
    expectedDigests: eligibility.expectedDigests });
  expect(completionHooks.syncWorkflowRunStateWithOutcome).toHaveBeenCalledTimes(1);
  expect(await bindRetainedWorkflowTool(f.db, scope)).toMatchObject({ kind: "completed" });
  expect(await f.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.publishId))).toHaveLength(1);
});

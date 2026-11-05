// @vitest-environment node
import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, missions, pluginToolExecutionReceipts, workflowDefinitions, workflowRuns,
  issueComments, issueWorkProducts, issues, workflowStepInvocations, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertAgentAssignments, assertNoHeartbeatWriters, resetControlNodeBoundary } from "./helpers/workflow-control-node-boundary.js";
import { childStep, configureWorkflowChildFixtures, createCompanyFixture, insertDefinition, insertRunWithWorkflowStepRun,
  insertStepRunForRun } from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { decodeRetainedToolOutcome, insertInternalToolReceipt } from "../services/plugin-tool-execution-receipt.js";
import { bindRetainedWorkflowTool, finalizeRetainedWorkflowTool } from "../services/workflow/retained-tool-completion.js";
import { syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { evaluateSemanticStructuralReadiness } from "../services/workflow/control-flow/structural-semantic-readiness.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const support = await getEmbeddedPostgresTestSupport(), describePg = support.supported ? describe : describe.skip;
const token = { producerStepId: "producer", iterationIndex: 0, completedAt: "2026-10-28T12:00:00.000Z" };
const acceptedAt = "2026-10-29T00:00:00.000Z", params = { query: "validate" };
const semantic = { id: "semantic", name: "Semantic review", type: "qa", qaType: "semantic", dependencies: ["producer", "gate"] };
const pass: ToolOutcome = { kind: "result", result: { content: "pass", data: { verdict: "pass" } },
  response: { jsonrpc: "2.0", id: 1, result: { content: "pass", data: { verdict: "pass" } } } };
const requestChanges: ToolOutcome = { kind: "result", result: { content: "revise", data: { verdict: "request_changes" } },
  response: { jsonrpc: "2.0", id: 2, result: { content: "revise", data: { verdict: "request_changes" } } } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

function hooks(sync = syncWorkflowRunStateWithOutcome) {
  return { normalizeRecord: record, getMetadataRecord: (value: unknown, key: string) => record(record(value)[key]),
    readMetadataString: (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined,
    buildWorkflowStepRunMetadata: (step: { executionControls?: unknown; graphWorkProductRequired?: boolean }, metadata: unknown) => ({
      ...record(metadata), ...(step.executionControls ? { executionControls: step.executionControls } : {}),
      graphWorkProductRequired: step.graphWorkProductRequired === true,
    }), syncWorkflowRunStateWithOutcome: sync };
}

async function fixture(options: { linked?: boolean; structural?: boolean; qa?: boolean; deleteAfterUse?: boolean } = {}) {
  const linked = options.linked === true, companyId = await createCompanyFixture(`s3-${randomUUID()}`);
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "S3", status: "active" }).returning();
  const gate: Record<string, unknown> = { id: "gate", name: "Gate", type: "tool", toolNames: ["plugin:gate"], dependencies: ["producer"],
    ...(options.structural ? { qaType: "structural" } : {}), ...(options.qa ? { toolArtifactContract: { role: "qa" } } : {}),
    ...(options.deleteAfterUse ? { executionControls: { deleteAfterUse: true } } : {}) };
  const targetWorkflowId = await insertDefinition({ companyId, name: "Target", steps: [
    { id: "producer", name: "Producer", agentId: agent!.id, graphWorkProductRequired: true, dependencies: [] }, gate,
  ] });
  const parentWorkflowId = linked ? await insertDefinition({ companyId, name: "Parent", steps: [childStep(targetWorkflowId)] }) : targetWorkflowId;
  const parent = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentWorkflowId,
    stepId: linked ? "run-child" : "producer", stepStatus: linked ? "pending" : "completed" });
  await db.update(workflowRuns).set({ missionId: mission!.id }).where(eq(workflowRuns.id, parent.runId));
  let runId = parent.runId, parentStepRunId = parent.stepRunId, invocationId: string | null = null, gateStepId: string;
  if (linked) {
    const child = await insertMaterializedChildRun(db, { companyId, parentRunId: parent.runId,
      parentStepRunId: parent.stepRunId, childWorkflowId: targetWorkflowId, stepIds: ["producer", "gate"] });
    runId = child.childRunId; parentStepRunId = child.parentStepRunId; invocationId = child.invocationId;
    gateStepId = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find((row) => row.stepId === "gate")!.id;
  } else gateStepId = await insertStepRunForRun({ runId, stepId: "gate", status: "pending" });
  const producer = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId))).find((row) => row.stepId === "producer");
  await db.update(workflowStepRuns).set({ status: "completed", iterationIndex: 0, completedAt: new Date(token.completedAt) })
    .where(eq(workflowStepRuns.id, producer!.id));
  const requestId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", iterationIndex: 2, executionGeneration: 4,
    lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt), metadata: {
      ...(options.structural ? { structuralGateProducerToken: token } : {}),
      toolQueue: { status: "claimed", claimedAt: acceptedAt },
      toolInvocation: { requestId, toolName: "plugin:gate", args: params },
    } }).where(eq(workflowStepRuns.id, gateStepId));
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gateStepId));
  const scope = { companyId, tool: "plugin:gate", parameters: params, workflow: { missionId: linked ? null : mission!.id,
    workflowRunId: runId, stepRunId: gateStepId, stepId: "gate", requestId, executionGeneration: 4,
    statusTransitionVersion: step!.statusTransitionVersion, runStatus: "running" as const,
    stepStatus: "running" as const, acceptedAt } };
  return { companyId, missionId: mission!.id, parentRunId: parent.runId, parentStepRunId,
    runId, invocationId, targetWorkflowId, gateStepId, producerStepId: producer!.id, agentId: agent!.id, scope };
}

describePg("retained specialized workflow completion on PostgreSQL", () => {
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("retained-specialized-s3-"); db = createDb(temp.connectionString); configureWorkflowChildFixtures(db); }, 120_000);
  afterEach(async () => {
    await waitForHeartbeatExecutionsToDrain(db);
    await assertNoHeartbeatWriters(db);
    for (const table of [workflowTransitionEvents, activityLog, pluginToolExecutionReceipts, workflowStepInvocations,
      workflowStepRuns, workflowRuns, workflowDefinitions, issueWorkProducts, issueComments, issues, missions, agents, companies]) {
      await db.delete(table);
    }
    resetControlNodeBoundary();
  });
  afterAll(async () => { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("captures structural and linked authority together, grants one binder, and proves native child settlement", async () => {
    const f = await fixture({ linked: true, structural: true });
    const decisions = await Promise.all([bindRetainedWorkflowTool(db, f.scope), bindRetainedWorkflowTool(db, f.scope)]);
    expect(decisions.map((item) => item.kind).sort()).toEqual(["claim", "held"]);
    const owner = decisions.find((item) => item.kind === "claim");
    if (!owner || owner.kind !== "claim") throw new Error("single binder claim missing");
    expect(owner.owner.workflow!.specialized).toEqual({ structural: { producerToken: token, iterationIndex: 2, completedAt: null },
      linkedChild: { identity: { companyId: f.companyId, parentRunId: f.parentRunId, parentStepRunId: f.parentStepRunId,
        stepId: "run-child", invocationId: f.invocationId, childRunId: f.runId, generation: 1 },
        targetWorkflowId: f.targetWorkflowId, parentMissionId: f.missionId } });
    let syncCalls = 0, preSync: Record<string, unknown> | null = null;
    const h = hooks(async (hookDb, runId, source) => {
      syncCalls += 1;
      const [gate] = await hookDb.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      const [receipt] = await hookDb.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.owner.receiptId));
      const committedEvents = await hookDb.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
      const transition = committedEvents.find((event) => event.eventType === "workflow_step_status_transition");
      preSync = { status: gate!.status, statusTransitionVersion: gate!.statusTransitionVersion,
        requestId: gate!.lastDispatchRequestId, generation: gate!.executionGeneration,
        acceptedAt: gate!.lastDispatchAcceptedAt?.toISOString(), receiptStatus: receipt!.status,
        disposition: decodeRetainedToolOutcome(receipt!.resultBody)?.disposition,
        transition: transition && { fromStatus: transition.fromStatus, toStatus: transition.toStatus, payload: transition.payload } };
      return syncWorkflowRunStateWithOutcome(hookDb, runId, source);
    });
    await expect(finalizeRetainedWorkflowTool(db, owner.owner, pass, h)).resolves.toMatchObject({ kind: "applied" });
    const expectedVersion = owner.owner.workflow!.statusTransitionVersion + 1;
    expect(preSync).toMatchObject({ status: "completed", statusTransitionVersion: expectedVersion,
      requestId: owner.owner.workflow!.requestId, generation: owner.owner.workflow!.executionGeneration,
      acceptedAt: owner.owner.workflow!.acceptedAt, receiptStatus: "completed", disposition: { kind: "applied" },
      transition: { fromStatus: "running", toStatus: "completed", payload: { transitionVersion: expectedVersion } } });
    const [child] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    const [parentStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.parentStepRunId));
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.owner.receiptId));
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
    expect(syncCalls).toBe(1); expect(child!.status).toBe("completed"); expect(parentStep!.status).toBe("completed");
    expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "applied" } });
    expect(events.filter((event) => event.eventType === "workflow_validation_verdict")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "workflow_validation_verdict")?.payload).toMatchObject({ producerToken: token });
    expect(events.filter((event) => event.eventType === "workflow_step_status_transition")).toHaveLength(1);
    const definition = await loadExecutionDefinition(db, f.runId, { requireHistorical: false });
    await expect(evaluateSemanticStructuralReadiness({ db, companyId: f.companyId, workflowRunId: f.runId,
      step: semantic, steps: [...definition.steps, semantic] }))
      .resolves.toMatchObject({ ready: true, coverage: [{ gateStepId: "gate", producerStepId: "producer", producerIterationIndex: 0 }] });
  });

  it("runs the existing structural request_changes producer rework path", async () => {
    const f = await fixture({ structural: true }), claim = await bindRetainedWorkflowTool(db, f.scope);
    expect(claim.kind).toBe("claim"); if (claim.kind !== "claim") return;
    await expect(finalizeRetainedWorkflowTool(db, claim.owner, requestChanges, hooks())).resolves.toMatchObject({ kind: "applied" });
    const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.producerStepId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
    expect(producer!.iterationIndex).toBe(1); expect(producer!.status).toBe("pending");
    expect(record(producer!.metadata).workflowReworkContract).toMatchObject({ kind: "workflow_qa_rework",
      producerStepId: "producer", currentIteration: 0, iterationLabel: "1/2", maxIterations: 2 });
    expect(run!.status).toBe("running");
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, claim.owner.receiptId));
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
    expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: requestChanges, disposition: { kind: "applied" } });
    expect(events.map((event) => event.eventType).sort()).toEqual(["workflow_step_status_transition", "workflow_validation_verdict"]);
    expect(events.find((event) => event.eventType === "workflow_validation_verdict")?.payload).toMatchObject({
      requestId: claim.owner.workflow!.requestId, verdict: "request_changes", producerToken: token });
    expect(events.find((event) => event.eventType === "workflow_step_status_transition")).toMatchObject({
      fromStatus: "running", toStatus: "failed" });
    await assertAgentAssignments(db, { companyId: f.companyId, agentId: f.agentId, runId: f.runId,
      steps: [{ stepId: "producer", issueId: producer!.issueId }] });
    await assertNoHeartbeatWriters(db);
  });

  it("replays after sync failure with deleteAfterUse and a changed live generation", async () => {
    const f = await fixture({ linked: true, structural: true, deleteAfterUse: true });
    const claim = await bindRetainedWorkflowTool(db, f.scope);
    expect(claim.kind).toBe("claim"); if (claim.kind !== "claim") return;
    let calls = 0;
    const h = hooks(async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("sync failure");
      return syncWorkflowRunStateWithOutcome(...args);
    });
    await expect(finalizeRetainedWorkflowTool(db, claim.owner, pass, h)).rejects.toThrow("sync failure");
    const [committed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
    expect(committed!.status).toBe("completed"); expect(record(committed!.metadata).toolInvocation).toBeUndefined();
    expect(record(committed!.metadata).toolResult).toBeUndefined();
    await db.update(workflowStepRuns).set({ executionGeneration: 99 }).where(eq(workflowStepRuns.id, f.gateStepId));
    await expect(finalizeRetainedWorkflowTool(db, claim.owner, pass, h)).resolves.toMatchObject({ kind: "applied" });
    await expect(finalizeRetainedWorkflowTool(db, claim.owner, { ...pass, result: { content: "changed" } }, h))
      .rejects.toMatchObject({ reason: "receipt_conflict" });
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, claim.owner.receiptId));
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId));
    expect(calls).toBe(2); expect(receipt!.status).toBe("completed");
    expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "applied" } });
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId)))[0]!.executionGeneration).toBe(99);
    expect(events.filter((event) => event.eventType === "workflow_step_status_transition")).toHaveLength(1);
  });

  it("keeps an applied receipt unacknowledged when a terminal child lacks native parent proof", async () => {
    const f = await fixture({ linked: true, structural: true });
    const claim = await bindRetainedWorkflowTool(db, f.scope);
    expect(claim.kind).toBe("claim"); if (claim.kind !== "claim") return;
    const h = hooks(async (innerDb, runId) => {
      await innerDb.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, runId));
      return { kind: "synced", result: { status: "completed" } } as never;
    });
    await expect(finalizeRetainedWorkflowTool(db, claim.owner, pass, h)).rejects
      .toMatchObject({ reason: "parent_child_settlement_unverified" });
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, claim.owner.receiptId));
    const [parentStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.parentStepRunId));
    expect(receipt!.status).toBe("completed"); expect(parentStep!.status).toBe("pending");
    expect(decodeRetainedToolOutcome(receipt!.resultBody)).toMatchObject({ actual: pass, disposition: { kind: "applied" } });
  });

  it("holds proof-less plugin QA and worker-claimed receipt-shaped data", async () => {
    const f = await fixture({ qa: true }), before = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId)))[0]!;
    expect(await bindRetainedWorkflowTool(db, f.scope)).toEqual({ kind: "held" });
    const owner = await insertInternalToolReceipt(db, { ...f.scope, consumer: "workflow" });
    const claimedResult = { content: "looks verified", data: { toolArtifactReceipt: { verified: true } } };
    const claimed: ToolOutcome = { kind: "result", result: claimedResult,
      response: { jsonrpc: "2.0", id: 3, result: claimedResult } };
    await expect(finalizeRetainedWorkflowTool(db, owner, claimed, hooks())).rejects.toMatchObject({ reason: "specialized_authority" });
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
    expect(receipt!.status).toBe("executing"); expect(decodeRetainedToolOutcome(receipt!.resultBody)?.actual).toEqual(claimed);
    expect((await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId)))[0]).toEqual(before);
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowStepRunId, f.gateStepId)))).toHaveLength(0);
  });

  it.each(["definition step", "target workflow ID"] as const)(
    "holds linked completion when the parent %s is missing without writing a receipt", async (missing) => {
      const f = await fixture({ linked: true });
      const [parent] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns)
        .where(eq(workflowRuns.id, f.parentRunId)).limit(1);
      if (!parent) throw new Error("parent run missing");
      const steps = missing === "definition step" ? [] : [
        Object.fromEntries(Object.entries(childStep(f.targetWorkflowId)).filter(([key]) => key !== "targetWorkflowId")),
      ];
      await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, parent.workflowId));
      const [before] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      await expect(bindRetainedWorkflowTool(db, f.scope)).resolves.toEqual({ kind: "held" });
      const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.gateStepId));
      expect(after).toEqual(before);
      expect(await db.select().from(pluginToolExecutionReceipts)).toHaveLength(0);
      expect(await db.select().from(workflowTransitionEvents)).toHaveLength(0);
    },
  );
});

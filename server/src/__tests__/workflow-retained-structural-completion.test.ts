import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, companies, createDb, missions, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, pluginToolExecutionReceipts } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { configureWorkflowChildFixtures, createCompanyFixture, insertDefinition,
  insertRunWithWorkflowStepRun } from "./helpers/workflow-child-fixtures.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";
import { StructuralCompletionAuthorityMismatch, StructuralCompletionCasLost,
  writeStructuralCompletionInTransaction } from "../services/workflow/control-flow/structural-completion-write.js";
import { discoverLegacyStructuralScope, withWorkflowToolLockScope } from "../services/workflow/workflow-tool-lock-scope.js";
import { decodeRetainedToolOutcome, insertInternalToolReceipt, stageRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const gate = { id: "gate", name: "Structural gate", agentId: "", type: "tool", qaType: "structural",
  toolNames: ["validate"], dependencies: [], graphWorkProductRequired: false };
const token = { producerStepId: "producer", iterationIndex: 2, completedAt: "2026-10-29T00:00:00.000Z" };
const acceptedAt = "2026-10-29T00:01:00.000Z";
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

async function fixture(status = "running", metadata: Record<string, unknown> = {}) {
  const companyId = await createCompanyFixture(`s2-${randomUUID()}`);
  const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
  const [mission] = await db.insert(missions).values({ companyId, ownerAgentId: agent!.id, title: "S2", status: "active" }).returning();
  const workflowId = await insertDefinition({ companyId, name: "S2 gate", steps: [gate] });
  const run = await insertRunWithWorkflowStepRun({ companyId, workflowId, stepId: gate.id, stepStatus: status });
  const requestId = `request-${randomUUID()}`;
  const completedAt = status === "failed" ? new Date("2026-10-28T00:00:00.000Z") : null;
  await db.update(workflowRuns).set({ missionId: mission!.id }).where(eq(workflowRuns.id, run.runId));
  const [step] = await db.update(workflowStepRuns).set({ lastDispatchRequestId: requestId,
    executionGeneration: 4, statusTransitionVersion: 1, completedAt, metadata: { structuralGateProducerToken: token, ...metadata } })
    .where(eq(workflowStepRuns.id, run.stepRunId)).returning();
  return { companyId, missionId: mission!.id, runId: run.runId, step: step!, requestId };
}

function input(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return { db, step: gate, success: true, data: { verdict: "pass" }, companyId: f.companyId,
    workflowRunId: f.runId, workflowStepRunId: f.step.id, missionId: f.missionId, issueId: null,
    source: "workflow_tool_result" as const, requestId: f.requestId, observedStatus: f.step.status,
    observedIterationIndex: f.step.iterationIndex, observedRequestId: f.step.lastDispatchRequestId,
    observedCompletedAt: f.step.completedAt, observedExecutionGeneration: f.step.executionGeneration,
    producerToken: token, patch: { startedAt: f.step.startedAt ?? new Date(), completedAt: new Date(),
      metadata: { ...f.step.metadata, result: "accepted" }, fallbackFailureSummary: "worker failed" }, ...overrides };
}

async function writeRetained(f: Awaited<ReturnType<typeof fixture>>, attemptWhere = sql`true`, data = { verdict: "pass" }) {
  const discovery = await discoverLegacyStructuralScope(db, { companyId: f.companyId, workflowRunId: f.runId });
  if (discovery.kind !== "ready") throw new Error("fixture_scope_not_ready");
  return withWorkflowToolLockScope(db, discovery.expected, (scope) => {
    const { db: _db, ...writeInput } = input(f, { data });
    return writeStructuralCompletionInTransaction(scope, { ...writeInput, mode: "retained", producerToken: token, attemptWhere });
  });
}

async function officialRows(stepRunId: string) {
  return db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowStepRunId, stepRunId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
}

describePg("retained and legacy structural completion share one transaction writer", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-retained-structural-s2-");
    db = createDb(temp.connectionString);
    configureWorkflowChildFixtures(db);
    await db.execute(sql`create table s2_structural_faults (mode text not null)`);
    await db.execute(sql`insert into s2_structural_faults values ('none')`);
    await db.execute(sql.raw(`create function s2_structural_fault() returns trigger language plpgsql as $$
      declare active_mode text;
      begin
        select mode into active_mode from s2_structural_faults limit 1;
        if active_mode = tg_argv[0] and
          (tg_table_name <> 'workflow_transition_events' or to_jsonb(new)->>'event_type' = tg_argv[1]) then
          raise exception 's2_injected_%', active_mode;
        end if;
        return new;
      end
    $$`));
    await db.execute(sql.raw("create trigger s2_fault_verdict after insert on workflow_transition_events for each row execute function s2_structural_fault('ledger', 'workflow_validation_verdict')"));
    await db.execute(sql.raw("create trigger s2_fault_transition after insert on workflow_transition_events for each row execute function s2_structural_fault('transition', 'workflow_step_status_transition')"));
    await db.execute(sql.raw("create trigger s2_fault_step after update on workflow_step_runs for each row execute function s2_structural_fault('step', '')"));
  }, 120_000);
  afterEach(async () => {
    await db.execute(sql`update s2_structural_faults set mode = 'none'`);
    for (const table of [workflowTransitionEvents, workflowStepRuns, workflowRuns, workflowDefinitions, missions, agents, companies]) {
      await db.delete(table);
    }
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  it("uses an exact conflicting official verdict for status and error", async () => {
    const f = await fixture();
    await db.insert(workflowTransitionEvents).values({ companyId: f.companyId, missionId: f.missionId,
      workflowRunId: f.runId, workflowStepRunId: f.step.id, eventType: "workflow_validation_verdict",
      layer: "workflow_validation", verdict: "request_changes", decision: "request_changes",
      reasonCode: "workflow_tool_result", idempotencyKey: `structural-gate-verdict:${f.companyId}:${f.step.id}:${f.requestId}`,
      payload: { requestId: f.requestId, verdict: "request_changes", producerToken: token } });
    const result = await atomicStructuralCompletion(input(f));
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(result).toMatchObject({ casWon: true, structuralGateRejected: true, effectiveSuccess: false });
    expect(stored).toMatchObject({ status: "failed", lastDispatchErrorSummary: "structural_gate_request_changes" });
    expect(await officialRows(f.step.id)).toHaveLength(1);
  });

  it("returns the exact official verdict when the observed step CAS loses", async () => {
    const f = await fixture();
    await db.insert(workflowTransitionEvents).values({ companyId: f.companyId, missionId: f.missionId,
      workflowRunId: f.runId, workflowStepRunId: f.step.id, eventType: "workflow_validation_verdict",
      layer: "workflow_validation", verdict: "request_changes", decision: "request_changes",
      reasonCode: "workflow_tool_result", idempotencyKey: `structural-gate-verdict:${f.companyId}:${f.step.id}:${f.requestId}`,
      payload: { requestId: f.requestId, verdict: "request_changes", producerToken: token } });
    const lost = await atomicStructuralCompletion(input(f, { data: { verdict: "pass" }, observedStatus: "failed" }));
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(lost).toMatchObject({ casWon: false, structuralGateRejected: true, effectiveSuccess: false });
    expect(stored?.status).toBe("running");
    expect(await officialRows(f.step.id)).toHaveLength(1);
  });

  it("throws when a uniqueness conflict has no exact official verdict row", async () => {
    const f = await fixture();
    await db.insert(workflowTransitionEvents).values({ companyId: f.companyId, missionId: f.missionId,
      workflowRunId: f.runId, workflowStepRunId: f.step.id, eventType: "workflow_step_status_transition",
      layer: "workflow_sync", reasonCode: "other_writer",
      idempotencyKey: `structural-gate-verdict:${f.companyId}:${f.step.id}:${f.requestId}`, payload: {} });
    await expect(atomicStructuralCompletion(input(f))).rejects.toThrow("conflict lacks exact row");
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(stored?.status).toBe("running");
    expect(await officialRows(f.step.id)).toHaveLength(0);
  });

  it("applies a fresh pass verdict and its step transition together", async () => {
    const f = await fixture();
    const result = await atomicStructuralCompletion(input(f));
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    const events = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id));
    expect(result).toMatchObject({ casWon: true, effectiveSuccess: true, structuralContractFailure: false });
    expect(stored?.status).toBe("completed");
    expect(events.map(event => event.eventType).sort()).toEqual(["workflow_step_status_transition", "workflow_validation_verdict"]);
  });

  it("holds retained completion when the exact official token conflicts", async () => {
    const f = await fixture();
    const marker = { receiptId: randomUUID(), requestId: f.requestId };
    await db.update(workflowStepRuns).set({ metadata: { toolInvocation: { retainedCompletion: marker } } })
      .where(eq(workflowStepRuns.id, f.step.id));
    await db.insert(workflowTransitionEvents).values({ companyId: f.companyId, missionId: f.missionId,
      workflowRunId: f.runId, workflowStepRunId: f.step.id, eventType: "workflow_validation_verdict",
      layer: "workflow_validation", verdict: "pass", decision: "pass", reasonCode: "workflow_tool_result",
      idempotencyKey: `structural-gate-verdict:${f.companyId}:${f.step.id}:${f.requestId}`,
      payload: { requestId: f.requestId, verdict: "pass", producerToken: { ...token, completedAt: "different" } } });
    const attemptWhere = sql`${workflowStepRuns.metadata}->'toolInvocation'->'retainedCompletion' = ${JSON.stringify(marker)}::jsonb`;
    await expect(writeRetained(f, attemptWhere)).rejects.toBeInstanceOf(StructuralCompletionAuthorityMismatch);
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(stored?.status).toBe("running");
    expect(await officialRows(f.step.id)).toHaveLength(1);
  });

  it("applies the retained original attempt predicate and rolls back its new ledger row on CAS loss", async () => {
    const f = await fixture();
    const marker = { receiptId: randomUUID(), requestId: f.requestId };
    await db.update(workflowStepRuns).set({ metadata: { toolInvocation: { retainedCompletion: marker } } })
      .where(eq(workflowStepRuns.id, f.step.id));
    await expect(writeRetained(f, eq(workflowStepRuns.status, "completed"))).rejects.toBeInstanceOf(StructuralCompletionCasLost);
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(stored?.status).toBe("running");
    expect(await officialRows(f.step.id)).toHaveLength(0);
  });

  it("keeps a staged actual receipt when the exact retained attempt CAS loses", async () => {
    const f = await fixture();
    const result = { content: "validated", data: { verdict: "pass" } };
    const actual: ToolOutcome = { kind: "result", result,
      response: { jsonrpc: "2.0", id: "s2", result } };
    const [claimed] = await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: new Date(acceptedAt),
      metadata: { ...f.step.metadata, toolQueue: { status: "claimed", claimedAt: acceptedAt },
        toolInvocation: { requestId: f.requestId, toolName: "validate", args: {} } } })
      .where(eq(workflowStepRuns.id, f.step.id)).returning();
    const workflow = { missionId: f.missionId, workflowRunId: f.runId, stepRunId: f.step.id, stepId: gate.id,
      requestId: f.requestId, executionGeneration: 4, statusTransitionVersion: claimed!.statusTransitionVersion,
      runStatus: "running" as const, stepStatus: "running" as const, acceptedAt,
      specialized: { structural: { producerToken: token, iterationIndex: f.step.iterationIndex, completedAt: null }, linkedChild: null } };
    const owner = await insertInternalToolReceipt(db, { companyId: f.companyId, tool: "validate", parameters: {},
      consumer: "workflow", workflow });
    await stageRetainedToolOutcome(db, owner, actual);
    const marker = { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
      tool: owner.tool, workflow, claim: { status: "claimed", claimedAt: acceptedAt } };
    const originalMetadata = { ...claimed!.metadata,
      toolInvocation: { ...claimed!.metadata.toolInvocation as Record<string, unknown>, retainedCompletion: marker } };
    await db.update(workflowStepRuns).set({ metadata: originalMetadata }).where(eq(workflowStepRuns.id, f.step.id));
    const attemptWhere = and(eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, gate.id),
      eq(workflowStepRuns.status, "running"), eq(workflowStepRuns.lastDispatchRequestId, f.requestId),
      eq(workflowStepRuns.executionGeneration, 4), eq(workflowStepRuns.statusTransitionVersion, claimed!.statusTransitionVersion),
      eq(workflowStepRuns.lastDispatchAcceptedAt, new Date(acceptedAt)), isNull(workflowStepRuns.lastDispatchErrorAt),
      eq(workflowStepRuns.metadata, originalMetadata),
      sql`${workflowStepRuns.metadata}->'toolInvocation'->'retainedCompletion' = ${JSON.stringify(marker)}::jsonb`);
    await db.update(workflowStepRuns).set({ metadata: { ...originalMetadata, retainedAttemptChanged: true } })
      .where(eq(workflowStepRuns.id, f.step.id));
    await expect(writeRetained(f, attemptWhere!)).rejects.toBeInstanceOf(StructuralCompletionCasLost);
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    const [receipt] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId));
    expect(stored).toMatchObject({ status: "running", metadata: { retainedAttemptChanged: true } });
    expect(receipt).toMatchObject({ status: "executing", resultStatus: null, completedAt: null });
    expect(decodeRetainedToolOutcome(receipt!.resultBody)?.actual).toEqual(actual);
    expect(await officialRows(f.step.id)).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id))).toHaveLength(0);
  });

  it.each(["ledger", "step", "transition"] as const)("rolls back all structural writes after injected %s failure", async mode => {
    const f = await fixture();
    await db.execute(sql`update s2_structural_faults set mode = ${mode}`);
    await expect(atomicStructuralCompletion(input(f))).rejects.toThrow(`s2_injected_${mode}`);
    await db.execute(sql`update s2_structural_faults set mode = 'none'`);
    const [stored] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.step.id));
    expect(stored?.status).toBe("running");
    expect(await officialRows(f.step.id)).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, f.step.id)))
      .toHaveLength(0);
  });

  it("keeps worker failure and missing structural proof as failures", async () => {
    const failed = await fixture();
    const failure = await atomicStructuralCompletion(input(failed, { success: false, data: undefined }));
    expect(failure).toMatchObject({ casWon: true, effectiveSuccess: false, structuralContractFailure: false });
    const [failedStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, failed.step.id));
    expect(failedStep).toMatchObject({ status: "failed", lastDispatchErrorSummary: "worker failed" });

    const missing = await fixture();
    const noProof = await atomicStructuralCompletion(input(missing, { producerToken: null }));
    expect(noProof).toMatchObject({ casWon: true, effectiveSuccess: false, structuralContractFailure: true });
  });
});

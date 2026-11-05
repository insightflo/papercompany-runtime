import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, approvals, companies, createDb, missions, pluginToolExecutionReceipts,
  workflowDefinitions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { insertInternalToolReceipt, stageRetainedToolOutcome, decodeRetainedToolOutcome } from "../services/plugin-tool-execution-receipt.js";
import { bindRetainedWorkflowTool, finalizeRetainedWorkflowTool, type RetainedWorkflowHooks } from "../services/workflow/retained-tool-completion.js";
import { acceptWorkflowToolResult, type WorkflowToolResultAcceptanceHooks } from "../services/workflow/workflow-tool-result-acceptance.js";
import type { ToolOutcome } from "../services/plugin-job-rpc.js";

const companyId = randomUUID(), agentId = randomUUID();
const acceptedAt = "2026-10-29T00:00:00.000Z";
const params = { query: "evidence" };
const payload = { content: "full", data: { ok: true, nested: [1, 2] } };
const actual: ToolOutcome = { kind: "result", result: payload, response: { jsonrpc: "2.0", id: 1, result: payload } };
const failureData = { content: "failed", data: { ok: false, error: "machine failure" } };
const failure: ToolOutcome = { kind: "result", result: failureData, response: { jsonrpc: "2.0", id: 2, result: failureData } };
const rpcFailure: ToolOutcome = { kind: "error", error: { code: -32000, message: "", data: { detail: "full" } },
  response: { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "", data: { detail: "full" } } } };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function hooks(): WorkflowToolResultAcceptanceHooks & RetainedWorkflowHooks {
  return { normalizeRecord: record, getMetadataRecord: (value, key) => record(record(value)[key]),
    readMetadataString: value => typeof value === "string" && value.trim() ? value.trim() : undefined,
    buildWorkflowStepRunMetadata: (step, metadata) => ({ ...record(metadata), ...(step.executionControls ? { executionControls: step.executionControls } : {}), graphWorkProductRequired: step.graphWorkProductRequired === true }),
    getWorkflowExecutionResultSnapshot: vi.fn(async () => ({ status: "snapshot" }) as never),
    syncWorkflowRunState: vi.fn(async () => ({ status: "running" }) as never),
    syncWorkflowRunStateWithOutcome: vi.fn(async () => ({ kind: "synced", result: { status: "running" } as never })) };
}

describe("retained workflow tool completion on PostgreSQL", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("retained-workflow-");
    db = createDb(temp.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Retained" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await temp.cleanup(); });

  async function seed(options: { missionless?: boolean; structural?: boolean; child?: boolean; qa?: boolean; deleteAfterUse?: boolean } = {}) {
    const missionId = options.missionless ? null : randomUUID();
    const workflowId = randomUUID(), runId = randomUUID(), stepRunId = randomUUID(), requestId = randomUUID();
    if (missionId) await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Mission", status: "active" });
    const spec = { id: "tool", name: "Tool", agentId: "", type: "tool", toolNames: ["plugin:tool"], dependencies: [],
      ...(options.structural ? { qaType: "structural" } : {}), ...(options.qa ? { toolArtifactContract: { role: "qa" } } : {}),
      ...(options.deleteAfterUse ? { executionControls: { deleteAfterUse: true } } : {}) };
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Workflow", stepsJson: [spec] });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: options.child ? "workflow-step" : "test" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId: "tool", status: "running",
      executionGeneration: 2, lastDispatchRequestId: requestId, lastDispatchAcceptedAt: new Date(acceptedAt),
      metadata: { toolQueue: { status: "claimed", claimedAt: acceptedAt }, toolInvocation: { requestId, toolName: "plugin:tool", args: params } } });
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    return { workflowId, runId, stepRunId, missionId, scope: { companyId, tool: "plugin:tool", parameters: params,
      workflow: { missionId, workflowRunId: runId, stepRunId, stepId: "tool", requestId, executionGeneration: 2, statusTransitionVersion: step.statusTransitionVersion, runStatus: "running" as const, stepStatus: "running" as const, acceptedAt } } };
  }
  async function claim(s: Awaited<ReturnType<typeof seed>>) { const decision = await bindRetainedWorkflowTool(db, s.scope);
    if (decision.kind !== "claim") throw new Error(`expected claim, got ${decision.kind}`); return decision.owner; }
  async function step(s: Awaited<ReturnType<typeof seed>>) { return (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId)))[0]; }
  async function outcome(receiptId: string) {
    const [row] = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, receiptId));
    return { row, value: decodeRetainedToolOutcome(row.resultBody) };
  }
  async function events(s: Awaited<ReturnType<typeof seed>>) { return db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId)); }
  async function expectHeld(s: Awaited<ReturnType<typeof seed>>, owner: Awaited<ReturnType<typeof claim>>, h: ReturnType<typeof hooks>,
    before: Awaited<ReturnType<typeof step>>, reason: string) {
    for (let retry = 0; retry < 2; retry++) await expect(finalizeRetainedWorkflowTool(db, owner, actual, h)).rejects.toMatchObject({ reason });
    const saved = await outcome(owner.receiptId);
    expect(saved.row.status).toBe("executing"); expect(saved.value?.actual).toEqual(actual); expect(saved.value?.disposition).toBeUndefined();
    expect(await step(s)).toEqual(before); expect(await events(s)).toHaveLength(0); expect(h.syncWorkflowRunStateWithOutcome).not.toHaveBeenCalled();
  }
  async function replacement(s: Awaited<ReturnType<typeof seed>>) {
    const [decision] = await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: s.runId, decidedAuthorityVersion: 0,
      decision: "failed", policyCause: "test", discoveryPath: "test", origin: "test" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId, type: "replacement", status: "approved", payload: {} }).returning();
    const [replacementRun] = await db.insert(workflowRuns).values({ companyId, workflowId: s.workflowId, missionId: s.missionId, triggeredBy: "test" }).returning();
    const [event] = await db.insert(workflowTransitionEvents).values({ companyId, eventType: "replacement", layer: "test" }).returning();
    await db.insert(workflowRecoveryAuthorities).values({ companyId, workflowRunId: s.runId, targetAuthorityVersion: 0, resultingAuthorityVersion: 0,
      targetDecisionId: decision.id, recoveryKind: "replacement_from_start_v1",
      requestedBy: "test", requestReference: randomUUID(), ownerDecisionEventId: event.id,
      operatorApprovalId: approval.id, replacementRunId: replacementRun.id, requestHash: "a".repeat(64), replacementContract: {} });
  }
  it("serializes concurrent binding and commits one receipt and marker", async () => {
    const s = await seed();
    const decisions = await Promise.all([bindRetainedWorkflowTool(db, s.scope), bindRetainedWorkflowTool(db, s.scope)]);
    expect(decisions.map(d => d.kind).sort()).toEqual(["claim", "held"]);
    const owner = decisions.find(d => d.kind === "claim");
    if (!owner || owner.kind !== "claim") throw new Error("claim missing");
    const receipts = await db.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.owner.receiptId));
    expect(receipts).toHaveLength(1); const before = await step(s);
    expect(record(record(before.metadata.toolInvocation).retainedCompletion)).toMatchObject({ receiptId: owner.owner.receiptId, claim: { status: "claimed", claimedAt: acceptedAt } });
  });
  it.each([
    ["null-cancelled", "invocation_corrupt"], ["scalar-cancelled", "invocation_corrupt"],
    ["array-cancelled", "invocation_corrupt"], ["incomplete-cancelled", "invocation_corrupt"],
    ["corrupt-cancelled", "marker_corrupt"], ["marker-absent", "marker_missing_or_conflicting"],
    ["cancelled-absent", "attempt_loss_unproven"], ["unknown-absent", "claim_missing"],
    ["different-marker", "marker_missing_or_conflicting"], ["contradictory-successor", "attempt_loss_unproven"],
  ] as const)("holds %s staged authority through retry", async (kind, reason) => {
    const s = await seed(), owner = await claim(s), h = hooks(); await stageRetainedToolOutcome(db, owner, actual);
    const row = await step(s), metadata = { ...row.metadata }, invocation = { ...record(metadata.toolInvocation) };
    if (kind === "null-cancelled") metadata.toolInvocation = null;
    else if (kind === "scalar-cancelled") metadata.toolInvocation = "invalid";
    else if (kind === "array-cancelled") metadata.toolInvocation = [];
    else if (kind === "incomplete-cancelled") metadata.toolInvocation = { retainedCompletion: invocation.retainedCompletion };
    else if (kind === "corrupt-cancelled") metadata.toolInvocation = { ...invocation, retainedCompletion: { version: 99 } };
    else if (kind === "different-marker") metadata.toolInvocation = { ...invocation, retainedCompletion: { ...record(invocation.retainedCompletion), receiptId: randomUUID() } };
    else { delete invocation.retainedCompletion; metadata.toolInvocation = invocation; }
    await db.update(workflowStepRuns).set({ metadata,
      ...(kind === "contradictory-successor" ? { lastDispatchRequestId: randomUUID() } : {}),
      ...(kind === "unknown-absent" ? { lastDispatchRequestId: null, lastDispatchAcceptedAt: null } : {}),
    }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (kind === "corrupt-cancelled") expect(await bindRetainedWorkflowTool(db, s.scope)).toEqual({ kind: "held" });
    if (kind.endsWith("-cancelled") || kind === "cancelled-absent") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.runId));
    await expectHeld(s, owner, h, await step(s), reason);
  });
  it("rolls back the inserted receipt if binding the marker fails", async () => {
    const s = await seed();
    await db.$client.unsafe(`CREATE FUNCTION retained_reject_bind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.stepRunId}'::uuid THEN RAISE EXCEPTION 'bind failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER retained_reject_bind BEFORE UPDATE ON workflow_step_runs FOR EACH ROW EXECUTE FUNCTION retained_reject_bind()`);
    const before = await db.select().from(pluginToolExecutionReceipts);
    try {
      await expect(bindRetainedWorkflowTool(db, s.scope)).rejects.toThrow("bind failure");
      expect(await db.select().from(pluginToolExecutionReceipts)).toEqual(before);
      expect(record((await step(s)).metadata.toolInvocation).retainedCompletion).toBeUndefined();
    } finally { await db.$client.unsafe("DROP TRIGGER retained_reject_bind ON workflow_step_runs; DROP FUNCTION retained_reject_bind()"); }
  });
  it.each([["success", actual, "completed"], ["machine failure", failure, "failed"], ["RPC failure", rpcFailure, "failed"]] as const)
  ("commits %s step, transition and applied receipt together", async (_label, result, status) => {
    const s = await seed(), owner = await claim(s), h = hooks();
    expect(await finalizeRetainedWorkflowTool(db, owner, result, h)).toMatchObject({ kind: "applied", workflow: s.scope.workflow });
    const row = await step(s), saved = await outcome(owner.receiptId);
    expect(row.status).toBe(status); expect(record(row.metadata.toolQueue).status).toBe("settled");
    expect(saved.row.status).toBe("completed"); expect(saved.value).toMatchObject({ actual: result, disposition: { kind: "applied" } });
    expect(await events(s)).toHaveLength(1); expect(h.syncWorkflowRunStateWithOutcome).toHaveBeenCalledTimes(1);
    expect(await bindRetainedWorkflowTool(db, s.scope)).toEqual({ kind: "completed" });
  });
  it("serializes a cancellation that already holds the mission lock", async () => {
    const s = await seed(), owner = await claim(s), h = hooks();
    await stageRetainedToolOutcome(db, owner, actual);
    let release!: () => void, locked!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const finalizerStarted = new Promise<void>(resolve => { started = resolve; });
    const cancellation = db.transaction(async tx => { await tx.select().from(missions).where(eq(missions.id, s.missionId!)).for("update");
      locked(); await gate; await tx.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.runId)); });
    await ready;
    let transactions = 0;
    const observedDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (callback: Parameters<typeof db.transaction>[0]) => target.transaction(async tx => { if (++transactions === 2) started(); return callback(tx); });
    } });
    const completion = finalizeRetainedWorkflowTool(observedDb, owner, actual, h);
    await finalizerStarted; release(); await cancellation;
    expect(await completion).toMatchObject({ kind: "superseded" });
    expect((await step(s)).status).toBe("running");
    expect(await events(s)).toHaveLength(0);
  });
  it("finishes under the workflow lock before a competing cancellation", async () => {
    const s = await seed(), owner = await claim(s);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const holder = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(7600829)`); ready(); await gate; });
    await locked;
    await db.$client.unsafe(`CREATE FUNCTION retained_hold_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.stepRunId}'::uuid AND NEW.status = 'completed' THEN PERFORM pg_advisory_xact_lock(7600829); END IF;
      RETURN NEW; END $$; CREATE TRIGGER retained_hold_step BEFORE UPDATE ON workflow_step_runs
      FOR EACH ROW EXECUTE FUNCTION retained_hold_step()`);
    let completion: ReturnType<typeof finalizeRetainedWorkflowTool> | undefined;
    let cancellation: Promise<unknown> | undefined;
    async function waitFor(query: string) {
      for (let attempt = 0; attempt < 2000; attempt += 1) {
        const rows = await db.$client.unsafe(query);
        if (rows[0]?.waiting) return;
      }
      throw new Error("database lock barrier not reached");
    }
    try {
      completion = finalizeRetainedWorkflowTool(db, owner, actual, hooks());
      await waitFor("select exists(select 1 from pg_locks where locktype = 'advisory' and objid = 7600829::oid and not granted) as waiting");
      cancellation = Promise.resolve(db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.runId)).returning());
      await waitFor("select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update %workflow_runs%') as waiting");
      release(); await holder;
      expect(await completion).toMatchObject({ kind: "applied" });
      await cancellation;
      expect((await step(s)).status).toBe("completed");
      expect((await outcome(owner.receiptId)).value?.disposition?.kind).toBe("applied");
      expect(await events(s)).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([holder, ...(completion ? [completion] : []), ...(cancellation ? [cancellation] : [])]);
      await db.$client.unsafe("DROP TRIGGER retained_hold_step ON workflow_step_runs; DROP FUNCTION retained_hold_step()");
    }
  });
  it.each(["cancel", "request", "generation", "version", "accepted", "replacement"] as const)
  ("preserves staged actual and the new state when %s wins", async change => {
    const s = await seed(), owner = await claim(s), h = hooks();
    await stageRetainedToolOutcome(db, owner, actual);
    if (change === "cancel") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.runId));
    if (change === "request") await db.update(workflowStepRuns).set({ lastDispatchRequestId: randomUUID() }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (change === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (change === "version") await db.update(workflowStepRuns).set({ statusTransitionVersion: s.scope.workflow.statusTransitionVersion + 1 }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (change === "accepted") await db.update(workflowStepRuns).set({ lastDispatchAcceptedAt: new Date("2026-10-30T00:00:00Z") }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (change === "replacement") await replacement(s);
    const before = await step(s);
    expect(await finalizeRetainedWorkflowTool(db, owner, actual, h)).toMatchObject({ kind: "superseded" });
    expect(await step(s)).toEqual(before);
    expect((await outcome(owner.receiptId)).value).toMatchObject({ actual, disposition: { kind: "superseded" } });
    expect(await events(s)).toHaveLength(0); expect(h.syncWorkflowRunStateWithOutcome).not.toHaveBeenCalled();
  });
  it.each(["request", "generation"] as const)("supersedes a markerless coherent %s successor", async kind => {
    const s = await seed(), owner = await claim(s), h = hooks(); await stageRetainedToolOutcome(db, owner, actual);
    const before = await step(s), metadata = { ...before.metadata }, invocation = { ...record(before.metadata.toolInvocation) };
    delete invocation.retainedCompletion;
    const requestId = kind === "request" ? randomUUID() : owner.workflow!.requestId;
    const claimedAt = "2026-10-30T00:00:00.000Z";
    await db.update(workflowStepRuns).set({
      ...(kind === "request" ? { lastDispatchRequestId: requestId } : {}),
      ...(kind === "generation" ? { executionGeneration: 3 } : {}),
      lastDispatchAcceptedAt: new Date(claimedAt), metadata: { ...metadata,
        toolQueue: { status: "claimed", claimedAt }, toolInvocation: { ...invocation, requestId },
      },
    }).where(eq(workflowStepRuns.id, s.stepRunId));
    const successor = await step(s), reason = `${kind}_changed`;
    expect(await finalizeRetainedWorkflowTool(db, owner, actual, h)).toMatchObject({ kind: "superseded", reason });
    expect(await step(s)).toEqual(successor);
    expect(await outcome(owner.receiptId)).toMatchObject({ row: { status: "completed" }, value: { actual, disposition: { kind: "superseded", reason } } });
    expect(await events(s)).toHaveLength(0); expect(h.syncWorkflowRunStateWithOutcome).not.toHaveBeenCalled();
  });
  it("rolls back step and event on receipt failure, then applies exactly once", async () => {
    const s = await seed(), owner = await claim(s), before = await step(s);
    await db.$client.unsafe(`CREATE FUNCTION retained_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${owner.receiptId}'::uuid AND NEW.status = 'completed' THEN RAISE EXCEPTION 'receipt failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER retained_reject_completion BEFORE UPDATE ON plugin_tool_execution_receipts
      FOR EACH ROW EXECUTE FUNCTION retained_reject_completion()`);
    try {
      await expect(finalizeRetainedWorkflowTool(db, owner, actual, hooks())).rejects.toThrow("receipt failure");
      expect(await step(s)).toEqual(before);
      expect(await events(s)).toHaveLength(0);
      expect(await outcome(owner.receiptId)).toMatchObject({ row: { status: "executing" }, value: { actual } });
    } finally { await db.$client.unsafe("DROP TRIGGER retained_reject_completion ON plugin_tool_execution_receipts; DROP FUNCTION retained_reject_completion()"); }
    expect(await finalizeRetainedWorkflowTool(db, owner, actual, hooks())).toMatchObject({ kind: "applied" });
    expect(await events(s)).toHaveLength(1);
  });
  it("retries only sync after commit and retains proof when deleteAfterUse removes metadata", async () => {
    const s = await seed({ missionless: true, deleteAfterUse: true }), owner = await claim(s), h = hooks();
    vi.mocked(h.syncWorkflowRunStateWithOutcome).mockRejectedValueOnce(new Error("sync failure"))
      .mockResolvedValueOnce({ kind: "busy", result: { status: "running" } as never })
      .mockResolvedValueOnce({ kind: "not-owner", result: { status: "running" } as never });
    await expect(finalizeRetainedWorkflowTool(db, owner, actual, h)).rejects.toThrow("sync failure");
    const committed = await step(s);
    expect(committed.status).toBe("completed"); expect(committed.metadata.toolInvocation).toBeUndefined(); expect(committed.metadata.toolResult).toBeUndefined();
    await db.update(workflowStepRuns).set({ executionGeneration: 99 }).where(eq(workflowStepRuns.id, s.stepRunId));
    await expect(finalizeRetainedWorkflowTool(db, owner, actual, h)).rejects.toMatchObject({ reason: "sync_busy" });
    await expect(finalizeRetainedWorkflowTool(db, owner, actual, h)).rejects.toMatchObject({ reason: "sync_not-owner" });
    expect(await finalizeRetainedWorkflowTool(db, owner, actual, h)).toMatchObject({ kind: "applied" });
    expect((await step(s)).executionGeneration).toBe(99);
    expect(await events(s)).toHaveLength(1);
    expect(h.syncWorkflowRunStateWithOutcome).toHaveBeenCalledTimes(4);
    expect((await outcome(owner.receiptId)).value?.actual).toEqual(actual);
  });
  it.each(["structural", "child", "qa"] as const)("holds the staged actual for unsupported %s authority", async kind => {
    const s = await seed({ structural: kind === "structural", child: kind === "child", qa: kind === "qa", missionless: kind === "child" }),
      before = await step(s), receipts = await db.select().from(pluginToolExecutionReceipts);
    expect(await bindRetainedWorkflowTool(db, s.scope)).toEqual({ kind: "held" });
    expect(await db.select().from(pluginToolExecutionReceipts)).toEqual(receipts); expect(await step(s)).toEqual(before); expect(await events(s)).toHaveLength(0);
    const owner = await insertInternalToolReceipt(db, { ...s.scope, consumer: "workflow" });
    await expect(finalizeRetainedWorkflowTool(db, owner, actual, hooks())).rejects.toMatchObject({
      reason: kind === "child" ? "linked_child" : "specialized_authority" });
    expect(await step(s)).toEqual(before); expect(await outcome(owner.receiptId)).toMatchObject({ row: { status: "executing" }, value: { actual } });
    expect(await events(s)).toHaveLength(0);
  });
  it("keeps malformed and unknown actuals held, and requires a root DB", async () => {
    const s = await seed(), owner = await claim(s);
    const malformed = { kind: "result", result: "not a tool result", response: { jsonrpc: "2.0", id: 3, result: "not a tool result" } } as unknown as ToolOutcome;
    await expect(finalizeRetainedWorkflowTool(db, owner, malformed, hooks())).rejects.toMatchObject({ reason: "actual_invalid" });
    expect((await outcome(owner.receiptId)).value?.actual).toEqual(malformed);
    await expect(db.transaction(tx => finalizeRetainedWorkflowTool(tx as unknown as typeof db, owner, actual, hooks())))
      .rejects.toMatchObject({ reason: "root_db_required" });
    const another = await seed(), otherOwner = await claim(another);
    await expect(finalizeRetainedWorkflowTool(db, otherOwner, { kind: "unknown" }, hooks())).rejects.toThrow();
    expect((await outcome(otherOwner.receiptId)).row.status).toBe("executing");
  });
  it("preserves the legacy terminal snapshot and explicit owner recovery", async () => {
    const s = await seed(), h = hooks();
    await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, s.stepRunId));
    const input = { companyId, stepRunId: s.stepRunId, workflowRunId: s.runId,
      stepId: "tool", requestId: s.scope.workflow.requestId, toolName: s.scope.tool, success: true };
    expect(await acceptWorkflowToolResult(db, input, h)).toEqual({ status: "snapshot" });
    expect((await step(s)).status).toBe("failed");
    await acceptWorkflowToolResult(db, { ...input, allowTerminalRecovery: true }, h);
    expect((await step(s)).status).toBe("completed");
  });
});

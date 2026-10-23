import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY, readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
const child = (mode: string) => `
  const fs = require('node:fs');
  const id = process.env.PAPERCOMPANY_TOOL_EXECUTION_ID;
  if (!id || process.env.PAPERCOMPANY_TOOL_PROGRESS_FD !== '3') process.exit(8);
  let count = 0;
  const report = () => fs.writeSync(3, JSON.stringify({version:1,executionId:id,sequence:++count,stage:'copy',unit:'items',current:count})+'\\n');
  report();
  const timer = setInterval(report, 1100);
  if ('${mode}' === 'idle') clearInterval(timer);
  setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ok:true})); }, ${mode === "success" ? 3400 : 10000});
`;
describe("real fd3 child progress", () => {
  it.each(["success", "idle", "max"])("handles %s without treating progress as output", async (mode) => {
    const scope = await progressTool(fixture.db, "builtin", {
      command: process.execPath, progress: { ...policy, maxDurationMs: mode === "max" ? 3000 : 15000 },
      env: { PAPERCOMPANY_TOOL_EXECUTION_ID: "cannot-override", PAPERCOMPANY_TOOL_PROGRESS_FD: "9" },
    });
    const result = await executeCoreWorkflowTool({ db: fixture.db, ...scope, parameters: ["-e", child(mode)] });
    expect(result.status).toBe(mode === "success" ? 200 : 500);
    if (mode === "success") expect(result.body.data).toEqual({ ok: true });
    else expect(result.body.error).toMatch(/tool_progress_(idle|max)_timeout/);
    const [row] = await fixture.reader.select().from(schema.toolExecutionHeartbeats)
      .where(eq(schema.toolExecutionHeartbeats.toolId, scope.toolId));
    expect(row.state).toBe(mode === "success" ? "succeeded" : "timed_out");
    expect(row.current).toBeGreaterThanOrEqual(mode === "idle" ? 1 : 3);
  }, 20_000);
});

type EvidenceContext = NonNullable<Parameters<typeof executeCoreWorkflowTool>[0]["progressEvidenceContext"]>;
async function agent(companyId: string) {
  const [row] = await fixture.db.insert(schema.agents).values({ companyId, name: "Progress agent" }).returning();
  return row;
}
async function world(workflow = true) {
  const base = await progressTool(fixture.db, "builtin", { command: process.execPath, progress: policy });
  const owner = await agent(base.companyId);
  await fixture.db.insert(schema.agentToolGrants).values({ companyId: base.companyId, agentId: owner.id, toolId: base.toolId, grantedBy: "test" });
  let step: typeof schema.workflowStepRuns.$inferSelect | null = null;
  if (workflow) {
    const [definition] = await fixture.db.insert(schema.workflowDefinitions).values({ companyId: base.companyId, name: "Progress" }).returning();
    const [run] = await fixture.db.insert(schema.workflowRuns).values({
      companyId: base.companyId, workflowId: definition.id, status: "running", triggeredBy: "test",
    }).returning();
    [step] = await fixture.db.insert(schema.workflowStepRuns).values({
      workflowRunId: run.id, stepId: "tool", status: "running", executionGeneration: 4, retryCount: 2, iterationIndex: 3,
    }).returning();
  }
  const runId = randomUUID();
  const [wake] = await insertWorkflowWakeRequest(fixture.db, {
    companyId: base.companyId, agentId: owner.id, source: "automation", status: "claimed", runId,
    workflowRunId: step?.workflowRunId, workflowStepRunId: step?.id, workflowExecutionGeneration: step?.executionGeneration,
    idempotencyKey: step ? "workflow-step-retry:" + step.id + ":2" : null,
  });
  const [heartbeat] = await fixture.db.insert(schema.heartbeatRuns).values({
    id: runId, companyId: base.companyId, agentId: owner.id, status: "running", startedAt: new Date(),
    wakeupRequestId: wake.id, workflowStepRunId: step?.id, workflowExecutionGeneration: step?.executionGeneration,
  }).returning();
  const context: EvidenceContext = {
    actor: { type: "agent", source: "agent_jwt", companyId: base.companyId, agentId: owner.id, runId },
    targetRunId: runId,
  };
  return { scope: { ...base, agentId: owner.id, workflowRunId: step?.workflowRunId, stepId: step?.stepId },
    owner, step, wake, heartbeat, context };
}
type World = Awaited<ReturnType<typeof world>>;
async function technicalRetry(w: World): Promise<World> {
  const runId = randomUUID();
  const [wake] = await insertWorkflowWakeRequest(fixture.db, {
    companyId: w.scope.companyId, agentId: w.owner.id, source: "automation", status: "claimed", runId,
    requestKind: "process_lost_retry", reason: "process_lost_retry", requestedByActorType: "system",
    workflowRunId: w.scope.workflowRunId, workflowStepRunId: w.step!.id, workflowExecutionGeneration: 4,
  }, w.heartbeat.id);
  const [heartbeat] = await fixture.db.insert(schema.heartbeatRuns).values({
    id: runId, companyId: w.scope.companyId, agentId: w.owner.id, status: "running", startedAt: new Date(),
    wakeupRequestId: wake.id, workflowStepRunId: w.step!.id, workflowExecutionGeneration: 4, retryOfRunId: w.heartbeat.id,
  }).returning();
  return { ...w, wake, heartbeat, context: { ...w.context, targetRunId: runId, actor: { ...w.context.actor, runId } } };
}
const evidenceChild = (fail = false) => [
  "const fs = require('node:fs'); const id = process.env.PAPERCOMPANY_TOOL_EXECUTION_ID;",
  "if (!id || process.env.PAPERCOMPANY_TOOL_PROGRESS_FD !== '3') process.exit(8);",
  // C07 plan: start/unchanged/rejected submissions are not advances; one (execution, sequence) is one fact.
  "for (const [sequence,current] of [[1,0],[1,1],[1,2],[2,1]])",
  "fs.writeSync(3,JSON.stringify({version:1,executionId:id,sequence,stage:'copy',unit:'items',current})+'\\n');",
  "console.log(JSON.stringify({ok:true})); console.error('final diagnostic');",
  fail ? "setTimeout(() => { process.exitCode=7; },100);" : "",
].join("\n");
function invoke(w: World, options: { context?: EvidenceContext; fail?: boolean } = { context: w.context }) {
  return executeCoreWorkflowTool({ db: fixture.db, ...w.scope,
    progressEvidenceContext: options.context, parameters: ["-e", evidenceChild(options.fail)] });
}
async function recorded(w: World) {
  const [tool] = await fixture.reader.select().from(schema.toolExecutionHeartbeats)
    .where(eq(schema.toolExecutionHeartbeats.toolId, w.scope.toolId));
  const audit = await fixture.reader.select().from(schema.activityLog).where(eq(schema.activityLog.entityId, tool.id));
  return { tool, audit, advanced: audit.filter(a => a.action === "tool_progress.advanced"),
    positive: audit.filter(a => a.runId !== null || a.details?.progressEvidence !== undefined) };
}
const patchHeartbeat = (w: World, values: Partial<typeof schema.heartbeatRuns.$inferInsert>) =>
  fixture.db.update(schema.heartbeatRuns).set(values).where(eq(schema.heartbeatRuns.id, w.heartbeat.id));
const patchWake = (w: World, values: Partial<typeof schema.agentWakeupRequests.$inferInsert>) =>
  fixture.db.update(schema.agentWakeupRequests).set(values).where(eq(schema.agentWakeupRequests.id, w.wake.id));
const patchProof = (w: World, values: Record<string, unknown>) =>
  patchWake(w, { payload: { ...w.wake.payload, [WORKFLOW_ATTEMPT_PROOF_KEY]: { ...readWorkflowAttemptProof(w.wake), ...values } } });

describe("C07 accepted advance attribution through core, local and real FD3", () => {
  it.each([false, true])("uses the original issued attempt once, technical retry=%s", async (retry) => {
    const root = await world(), w = retry ? await technicalRetry(root) : root;
    const result = await invoke(w);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ok: true });
    const r = await recorded(w);
    expect(r.tool).toMatchObject({ state: "succeeded", sequence: 1, current: 1 });
    expect(r.audit).toHaveLength(3);
    expect(r.advanced).toHaveLength(1);
    expect(r.positive).toEqual(r.advanced);
    expect(r.advanced[0]).toMatchObject({
      companyId: w.scope.companyId, actorType: "system", actorId: "tool-progress", runId: w.heartbeat.id,
      entityType: "tool_execution_heartbeat", entityId: r.tool.id,
      details: { sequence: 1, stageIndex: 0, current: 1, total: null, state: "active", reason: null, toolId: w.scope.toolId,
        progressEvidence: { schemaVersion: 1, companyId: w.scope.companyId, agentId: w.owner.id,
          runId: w.heartbeat.id, wakeupRequestId: w.wake.id, toolExecutionId: r.tool.id, sequence: 1, requestId: w.scope.requestId,
          workflowAttempt: { schemaVersion: 1, companyId: w.scope.companyId, agentId: w.owner.id, issueId: null, missionId: null,
            workflowRunId: w.scope.workflowRunId, stepRunId: w.step!.id, stepId: "tool", executionGeneration: 4,
            retryCount: 2, iterationIndex: 3, wakeupRequestId: w.wake.id, parentHeartbeatRunId: retry ? root.heartbeat.id : null } } },
    });
    expect(w.scope.requestId).not.toBe(w.wake.id);
    expect(w.context.targetRunId).toBe(w.heartbeat.id);
  });
  it("attributes an ordinary agent run without inventing a workflow attempt", async () => {
    const w = await world(false);
    expect((await invoke(w)).status).toBe(200);
    const r = await recorded(w);
    expect(r.positive).toHaveLength(1);
    expect(r.positive[0]).toMatchObject({ runId: w.heartbeat.id,
      details: { progressEvidence: { wakeupRequestId: w.wake.id, requestId: w.scope.requestId, workflowAttempt: null } } });
  });
  it.each(["without-context", "without-run", "different-target"] as const)(
    "preserves success and child failure with %s and no positive evidence", async (mode) => {
      for (const fail of [false, true]) {
        const w = await world();
        if (mode === "without-run") delete w.context.actor.runId;
        if (mode === "different-target") w.context.targetRunId = randomUUID();
        const result = await invoke(w, { context: mode === "without-context" ? undefined : w.context, fail });
        expect(result.status).toBe(fail ? 500 : 200);
        expect(result.body.stderr).toBe("final diagnostic");
        if (fail) {
          expect(result.body.error).toBe("tool_progress_child_failed (exit: 7)");
          expect(result.body.data).toMatchObject({ stdout: '{"ok":true}' });
        } else expect(result.body.data).toEqual({ ok: true });
        const r = await recorded(w);
        expect(r.tool).toMatchObject({ state: fail ? "failed" : "succeeded", sequence: 1, current: 1 });
        expect(r.advanced).toHaveLength(1);
        expect(r.positive).toEqual([]);
      }
    }, 20_000);
  const conflicts: Array<[string, (w: World) => unknown]> = [
    ["board-actor", w => { w.context.actor.type = "board"; }],
    ["actor-company", w => { w.context.actor.companyId = randomUUID(); }],
    ["actor-agent", w => { w.context.actor.agentId = randomUUID(); }],
    ["heartbeat-company", async w => patchHeartbeat(w, { companyId: (await progressTool(fixture.db)).companyId })],
    ["heartbeat-agent", async w => patchHeartbeat(w, { agentId: (await agent(w.scope.companyId)).id })],
    ["heartbeat-without-start", w => patchHeartbeat(w, { startedAt: null })],
    ["heartbeat-without-wake", w => patchHeartbeat(w, { wakeupRequestId: null })],
    ["wake-company", async w => patchWake(w, { companyId: (await progressTool(fixture.db)).companyId })],
    ["wake-agent", async w => patchWake(w, { agentId: (await agent(w.scope.companyId)).id })],
    ["wake-run", w => patchWake(w, { runId: randomUUID() })],
    ["wake-coalesced", w => patchWake(w, { status: "coalesced" })],
    ["wake-step", w => patchWake(w, { workflowStepRunId: randomUUID() })],
    ["heartbeat-step", w => patchHeartbeat(w, { workflowStepRunId: randomUUID() })],
    ["heartbeat-generation", w => patchHeartbeat(w, { workflowExecutionGeneration: 5 })],
    ["missing-proof", w => patchWake(w, { payload: {} })],
    ["proof-generation", w => patchProof(w, { executionGeneration: 5 })],
    ["proof-retry", w => patchProof(w, { retryCount: 3 })],
    ["proof-iteration", w => patchProof(w, { iterationIndex: 4 })],
    ["proof-parent", w => patchProof(w, { parentHeartbeatRunId: randomUUID() })],
  ];
  it.each(conflicts)("excludes %s conflicts without rejecting an accepted advance", async (_name, mutate) => {
    const w = await world();
    await mutate(w);
    const result = await invoke(w);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ok: true });
    const r = await recorded(w);
    expect(r.tool).toMatchObject({ state: "succeeded", sequence: 1, current: 1 });
    expect(r.audit).toHaveLength(3);
    expect(r.advanced).toHaveLength(1);
    expect(r.advanced[0].details).toMatchObject({ sequence: 1, current: 1, state: "active", toolId: w.scope.toolId });
    expect(r.positive).toEqual([]);
  });
  it("excludes a conflicting stored tool request while retaining ordinary acceptance", async () => {
    const w = await world();
    // Real DB corruption injection after the core chose its request; no executor/store mock.
    await fixture.db.transaction(async tx => {
      await tx.execute(sql.raw("CREATE FUNCTION c07_request_conflict() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.request_id := NEW.request_id || ''-other''; RETURN NEW; END;'"));
      await tx.execute(sql.raw("CREATE TRIGGER c07_request_conflict BEFORE INSERT ON tool_execution_heartbeats FOR EACH ROW EXECUTE FUNCTION c07_request_conflict()"));
    });
    try {
      expect((await invoke(w)).status).toBe(200);
      const r = await recorded(w);
      expect(r.tool).toMatchObject({ requestId: w.scope.requestId + "-other", state: "succeeded", sequence: 1 });
      expect(r.advanced).toHaveLength(1);
      expect(r.positive).toEqual([]);
    } finally {
      await fixture.db.transaction(async tx => {
        await tx.execute(sql.raw("DROP TRIGGER c07_request_conflict ON tool_execution_heartbeats"));
        await tx.execute(sql.raw("DROP FUNCTION c07_request_conflict()"));
      });
    }
  });
  it.each(["cancelled", "foreign-company", "missing-grant"] as const)(
    "preserves the existing %s error with or without attribution context", async (mode) => {
      const w = await world();
      if (mode === "cancelled") await fixture.db.update(schema.workflowRuns).set({ status: "cancelled" })
        .where(eq(schema.workflowRuns.id, w.scope.workflowRunId!));
      if (mode === "foreign-company") w.scope.companyId = (await progressTool(fixture.db)).companyId;
      if (mode === "missing-grant") await fixture.db.delete(schema.agentToolGrants).where(eq(schema.agentToolGrants.toolId, w.scope.toolId));
      const before = await invoke(w, {});
      const after = await invoke(w);
      expect(after).toEqual(before);
      expect(after.status).toBe(mode === "cancelled" ? 500 : 403);
      if (mode === "cancelled") expect(after.body.error).toBe("tool_progress_scope_replaced");
      const rows = await fixture.reader.select().from(schema.toolExecutionHeartbeats)
        .where(eq(schema.toolExecutionHeartbeats.toolId, w.scope.toolId));
      expect(rows).toEqual([]);
    });
});

import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, agents, agentWakeupRequests, heartbeatRuns, issues, missions, companies,
  workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { reconcileReplacementStarts } from "../services/workflow/replacement-start-reconciler.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
// No external adapter can be invoked: the legacy eager-wake boundary fails loudly.
const eager = vi.hoisted(() => vi.fn(async () => { throw new Error("eager execution forbidden"); }));
const adapter = vi.hoisted(() => vi.fn(async () => { throw new Error("external adapter forbidden"); }));
vi.mock("../adapters/index.js", () => ({ getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map() }));
vi.mock("../services/heartbeat.js", async (original) => ({
  ...await original<typeof import("../services/heartbeat.js")>(),
  heartbeatService: () => ({ wakeup: eager }),
}));
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-agent-delivery-"); db = createDb(temp.connectionString); }, 60_000);
beforeEach(() => { eager.mockClear(); adapter.mockClear(); });
afterAll(async () => { if (db) await waitForHeartbeatExecutionsToDrain(db); await db?.$client.end(); await temp?.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
async function seed() {
  const s = await seedReplacement(db); roots.push(s.tempRoot);
  await db.update(workflowDefinitions).set({ stepsJson: [{ id: "agent-root", name: "Agent root", type: "agent",
    agentId: s.mission.ownerAgentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, s.run.workflowId));
  const proposal = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id,
    decisionEventId: s.input.replacementIntent.decisionEventId, idempotencyKey: "agent-replace", metadata: {},
    externalEffects: "operator_reconciled" });
  await approveReplacement(db, s.companyId, proposal.id, s.board);
  const target = (await admitReplacement(db, { ...s.input, replacementIntent: { ...s.input.replacementIntent,
    approvalId: proposal.id, idempotencyKey: "agent-replace" } }, s.actor)).run;
  await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never);
  return { ...s, target };
}
const requests = (id: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, id));
const steps = (id: string) => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, id));
async function receipt(id: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return run.metadata?.replacementStart as Record<string, unknown>;
}
it("rolls back queue, linkage and receipt without any executable wake, then reenters the same target", async () => {
  const s = await seed();
  await db.$client.unsafe(`CREATE FUNCTION fail_agent_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${s.target.id}'::uuid AND NEW.metadata->'replacementStart'->>'deliveredAt' IS NOT NULL THEN RAISE EXCEPTION 'receipt crash'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER fail_agent_delivery BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION fail_agent_delivery()`);
  try { await expect(syncWorkflowRunState(db, s.target.id)).rejects.toThrow("receipt crash"); }
  finally { await db.$client.unsafe("DROP TRIGGER fail_agent_delivery ON workflow_runs; DROP FUNCTION fail_agent_delivery()"); }
  expect(eager).not.toHaveBeenCalled();
  expect(await requests(s.target.id)).toEqual([]); expect(await steps(s.target.id)).toEqual([]);
  expect(await db.select().from(issues).where(eq(issues.originRunId, s.target.id))).toEqual([]);
  expect((await receipt(s.target.id)).deliveredAt).toBeNull();
  await Promise.all([reconcileReplacementStarts(db), reconcileReplacementStarts(db)]);
  const [step] = await steps(s.target.id), [request] = await requests(s.target.id);
  expect(request).toMatchObject({ status: "queued", runId: null, companyId: s.companyId,
    agentId: s.mission.ownerAgentId, missionId: s.mission.id, issueId: step.issueId,
    workflowRunId: s.target.id, workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration });
  expect((await receipt(s.target.id)).agentWakeupRequestIds).toEqual([request.id]);
  await reconcileReplacementStarts(db);
  expect(await requests(s.target.id)).toEqual([request]);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, step.issueId!))).toEqual([]);
}, 30_000);
it("failed queue insertion remains pending and retries without duplicate targets or issues", async () => {
  const s = await seed();
  await db.$client.unsafe(`CREATE FUNCTION fail_agent_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.workflow_run_id='${s.target.id}'::uuid THEN RAISE EXCEPTION 'queue unavailable'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER fail_agent_queue BEFORE INSERT ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION fail_agent_queue()`);
  try {
    await expect(syncWorkflowRunState(db, s.target.id)).rejects.toThrow("queue unavailable");
    expect((await receipt(s.target.id)).deliveredAt).toBeNull();
  } finally { await db.$client.unsafe("DROP TRIGGER fail_agent_queue ON agent_wakeup_requests; DROP FUNCTION fail_agent_queue()"); }
  await reconcileReplacementStarts(db); await syncWorkflowRunState(db, s.target.id);
  expect(await requests(s.target.id)).toHaveLength(1); expect(await steps(s.target.id)).toHaveLength(1);
  expect(await db.select().from(issues).where(eq(issues.originRunId, s.target.id))).toHaveLength(1);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toHaveLength(2);
  expect(eager).not.toHaveBeenCalled();
}, 30_000);
it("disabled wake is not accepted as delivery and enabling it permits same-target reconciliation", async () => {
  const s = await seed();
  await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, s.mission.ownerAgentId));
  await expect(syncWorkflowRunState(db, s.target.id)).rejects.toThrow();
  expect((await receipt(s.target.id)).deliveredAt).toBeNull(); expect(await requests(s.target.id)).toEqual([]);
  await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, s.mission.ownerAgentId));
  await reconcileReplacementStarts(db); expect(await requests(s.target.id)).toHaveLength(1);
}, 30_000);
it("outer transaction rollback never exposes a queued request to the real heartbeat scheduler", async () => {
  const s = await seed(), observer = createDb(temp.connectionString);
  const real = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
  try {
    await expect(db.transaction(async (tx) => {
      await syncWorkflowRunState(tx as unknown as typeof db, s.target.id);
      expect(await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, s.target.id))).toHaveLength(1);
      expect(await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, s.target.id))).toEqual([]);
      await real.heartbeatService(observer).resumeQueuedRuns(s.mission.ownerAgentId);
      expect(adapter).not.toHaveBeenCalled();
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(await requests(s.target.id)).toEqual([]); expect(await steps(s.target.id)).toEqual([]);
  } finally { await observer.$client.end(); }
}, 30_000);
it("a failed native promotion remains durable and a fresh service recovers the same request once", async () => {
  const s = await seed(); await syncWorkflowRunState(db, s.target.id);
  const [request] = await requests(s.target.id), [step] = await steps(s.target.id);
  const observer = createDb(temp.connectionString);
  const observed: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { entered = r; });
  adapter.mockImplementationOnce(async () => {
    const [visible] = await observer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, step.id));
    expect(visible.issueId).toBe(request.issueId);
    const [visibleRun] = await observer.select().from(workflowRuns).where(eq(workflowRuns.id, s.target.id));
    expect((visibleRun.metadata?.replacementStart as Record<string, unknown>).agentWakeupRequestIds).toEqual([request.id]);
    observed.push(visible.issueId!); entered(); await gate;
    // Test double only: fail terminally, avoiding successful-output followup workflows.
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: "test adapter stopped", usage: null,
      provider: "test", model: "test", resultJson: null, runtimeServices: [] } as never;
  });
  try {
    const real = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
    await db.$client.unsafe(`CREATE FUNCTION fail_agent_promotion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.wakeup_request_id='${request.id}'::uuid THEN RAISE EXCEPTION 'promotion interrupted'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER fail_agent_promotion BEFORE INSERT ON heartbeat_runs FOR EACH ROW EXECUTE FUNCTION fail_agent_promotion()`);
    try {
      await expect(real.heartbeatService(db).resumeQueuedRuns(s.mission.ownerAgentId)).rejects.toThrow("promotion interrupted");
      expect(await requests(s.target.id)).toEqual([request]); expect(adapter).not.toHaveBeenCalled();
    } finally { await db.$client.unsafe("DROP TRIGGER fail_agent_promotion ON heartbeat_runs; DROP FUNCTION fail_agent_promotion()"); }
    await real.heartbeatService(db).resumeQueuedRuns(s.mission.ownerAgentId);
    await ready;
    await real.heartbeatService(db).resumeQueuedRuns(s.mission.ownerAgentId);
    expect(observed).toEqual([request.issueId]);
    expect(await requests(s.target.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, request.id))).toHaveLength(1);
  } finally {
    // Shut down only after assertions; do not permit unrelated failure recovery to run adapters.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.mission.ownerAgentId));
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
    release(); await waitForHeartbeatExecutionsToDrain(db); await observer.$client.end();
  }
}, 30_000);
it.each(["cancel", "budget"])("real native queue promotion honors %s after acceptance", async (kind) => {
  const s = await seed(); await syncWorkflowRunState(db, s.target.id);
  const [accepted] = await requests(s.target.id);
  if (kind === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
  else await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, s.companyId));
  const real = await vi.importActual<typeof import("../services/heartbeat.js")>("../services/heartbeat.js");
  await real.heartbeatService(db).resumeQueuedRuns(s.mission.ownerAgentId);
  const [refused] = await requests(s.target.id);
  expect(refused).toMatchObject({ id: accepted.id, status: "failed", runId: null });
  expect(adapter).not.toHaveBeenCalled();
}, 30_000);
it.each(["cancel", "budget"])("%s prevents acceptance and executable wake", async (kind) => {
  const s = await seed();
  if (kind === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
  else await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
  await expect(syncWorkflowRunState(db, s.target.id)).rejects.toThrow("replacement_start_ineligible");
  expect(await requests(s.target.id)).toEqual([]); expect(eager).not.toHaveBeenCalled();
});

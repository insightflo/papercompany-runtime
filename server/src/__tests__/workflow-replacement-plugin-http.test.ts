import express from "express";
import request, { type Response } from "supertest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, agents, missions, plugins, pluginEntities, workflowDefinitions, workflowRuns,
  workflowRecoveryAuthorities, workflowStepRuns, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { workflowRoutes } from "../routes/workflows.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
const adapter = vi.hoisted(() => vi.fn(async () => { throw new Error("external adapter forbidden"); }));
vi.mock("../adapters/index.js", () => ({ getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map() }));
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
const pluginId = randomUUID(), otherPluginId = randomUUID();
const worker = { call: vi.fn(async () => { throw new Error("plugin worker forbidden"); }) };
beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-plugin-replacement-http-test-secret");
  temp = await startEmbeddedPostgresTestDatabase("replacement-plugin-http-"); db = createDb(temp.connectionString);
  await db.insert(plugins).values([
    { id: pluginId, pluginKey: "insightflo.workflow-engine", packageName: "@test/workflow", version: "1", status: "ready", manifestJson: {} as never },
    { id: otherPluginId, pluginKey: "test.other", packageName: "@test/other", version: "1", status: "ready", manifestJson: {} as never },
  ]);
}, 60_000);
afterAll(async () => {
  if (db) await waitForHeartbeatExecutionsToDrain(db);
  await db?.$client.end(); await temp?.cleanup(); roots.forEach(r => rmSync(r, { recursive: true, force: true })); vi.unstubAllEnvs();
});
function app(board = false) {
  const a = express(); a.use(express.json()); a.use(actorMiddleware(db, { deploymentMode: board ? "local_trusted" : "authenticated" }));
  a.use("/api", workflowRoutes(db));
  a.use("/api", pluginRoutes(db, {} as never, undefined, undefined, undefined, { workerManager: worker as never }));
  a.use(errorHandler); return a;
}
function token(agentId: string, companyId: string, runId = randomUUID()) { return createLocalAgentJwt(agentId, companyId, "test", runId)!; }
async function seed() {
  const s = await seedReplacement(db); roots.push(s.tempRoot);
  await db.update(workflowDefinitions).set({ stepsJson: [{ id: "agent-root", name: "Agent root", type: "agent", agentId: s.actor.agentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, s.run.workflowId));
  const p = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id, decisionEventId: s.input.replacementIntent.decisionEventId,
    idempotencyKey: "http-replace", metadata: {}, externalEffects: "operator_reconciled" });
  await approveReplacement(db, s.companyId, p.id, s.board);
  await db.insert(pluginEntities).values({ pluginId, entityType: "workflow-definition", scopeKind: "company", scopeId: s.companyId,
    data: { id: s.run.workflowId, name: "must never refresh replacement", steps: [], lastScheduleError: "keep sentinel" } });
  const payload = { companyId: s.companyId, workflowId: s.run.workflowId, missionId: s.mission.id, metadata: {},
    replacementIntent: { ...s.input.replacementIntent, approvalId: p.id, idempotencyKey: "http-replace" } };
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.actor.agentId));
  return { ...s, payload, token: token(s.actor.agentId, s.companyId, heartbeat.id) };
}
function pluginPost(s: Awaited<ReturnType<typeof seed>>, variant: string, payload: Record<string, unknown> = s.payload, auth = s.token, id = pluginId, key = "start-workflow") {
  return request(app()).post(variant === "bridge" ? `/api/plugins/${id}/bridge/action` : `/api/plugins/${id}/actions/${key}`)
    .set("Authorization", `Bearer ${auth}`).send(variant === "bridge" ? { key, params: payload } : payload);
}
async function snapshot() {
  const tables = ["workflow_runs", "workflow_step_runs", "workflow_recovery_authorities", "workflow_run_definitions", "workflow_definitions", "plugin_entities", "missions", "issues", "agent_wakeup_requests", "heartbeat_runs", "activity_log"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await db.execute(sql.raw(`select * from ${table} order by ${table === "workflow_run_definitions" ? "workflow_run_id" : "id"}`));
  return result;
}
it.each(["url", "bridge"])("authenticated %s plugin and REST contention shares one target, start and queue; replay never wakes", async variant => {
  const s = await seed();
  const entities = await db.select().from(pluginEntities);
  let replies!: Promise<Response[]>;
  await db.transaction(async tx => {
    await tx.select().from(missions).where(eq(missions.id, s.mission.id)).for("update");
    replies = Promise.all([
      request(app()).post(`/api/workflows/${s.run.workflowId}/runs`).set("Authorization", `Bearer ${s.token}`).send({ missionId: s.mission.id, metadata: {}, replacementIntent: s.payload.replacementIntent }),
      pluginPost(s, variant),
    ]);
    // Both HTTP requests reach the real shared admission lock before either wins.
    await vi.waitFor(async () => {
      const blocked = await db.execute(sql`select pid from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%missions%'`);
      expect(blocked).toHaveLength(2);
    }, { timeout: 5000 });
  });
  const [rest, plugin] = await replies;
  expect(rest.status, JSON.stringify(rest.body)).toBe(201); expect(plugin.status, JSON.stringify(plugin.body)).toBe(200);
  expect(plugin.body.data.runId).toBe(rest.body.runId);
  const target = rest.body.runId;
  const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId));
  expect(authorities).toHaveLength(1); expect(authorities[0].replacementRunId).toBe(target);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toHaveLength(2);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, target));
  expect(run.status).toBe("running"); expect(run.startedAt).not.toBeNull();
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target))).toHaveLength(1);
  const queue = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target));
  expect(queue).toHaveLength(1); expect(queue[0].status).toBe("queued");
  expect(await db.select().from(pluginEntities)).toEqual(entities);
  await db.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, target));
  const before = await snapshot();
  const replay = await pluginPost(s, variant === "url" ? "bridge" : "url");
  expect(replay.status).toBe(200); expect(replay.body.data.runId).toBe(target); expect(await snapshot()).toEqual(before);
  const restReplay = await request(app()).post(`/api/workflows/${s.run.workflowId}/runs`).set("Authorization", `Bearer ${s.token}`).send({ missionId: s.mission.id, metadata: {}, replacementIntent: s.payload.replacementIntent });
  expect(restReplay.status).toBe(201); expect(restReplay.body.runId).toBe(target);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target))).toEqual(queue);
  expect(worker.call).not.toHaveBeenCalled(); expect(adapter).not.toHaveBeenCalled();
}, 30_000);
it.each(["url", "bridge"])("%s plugin admits first and REST replay keeps its execution and queue", async variant => {
  const s = await seed();
  const first = await pluginPost(s, variant);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const target = first.body.data.runId;
  const before = await snapshot();
  const replay = await request(app()).post(`/api/workflows/${s.run.workflowId}/runs`).set("Authorization", `Bearer ${s.token}`)
    .send({ missionId: s.mission.id, metadata: {}, replacementIntent: s.payload.replacementIntent });
  expect(replay.status).toBe(201); expect(replay.body.runId).toBe(target);
  const after = await snapshot();
  // Existing REST transport appends a request audit; execution state stays identical.
  delete before.activity_log; delete after.activity_log;
  expect(after).toEqual(before);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target))).toHaveLength(1);
}, 30_000);
it.each(["url", "bridge"])("board %s creation stays available but cannot spoof replacement requester", async variant => {
  const s = await seed(), before = await snapshot();
  const post = (key: string, payload: Record<string, unknown>) => request(app(true))
    .post(variant === "bridge" ? `/api/plugins/${pluginId}/bridge/action` : `/api/plugins/${pluginId}/actions/${key}`)
    .send(variant === "bridge" ? { key, params: payload } : payload);
  const rejected = await post("start-workflow", { ...s.payload, actor: s.actor, triggeredBy: "agent", child: true });
  expect(rejected.status).toBe(403); expect(rejected.body.error).toBe("replacement_requester_required");
  expect(await snapshot()).toEqual(before);
  const created = await post("create-workflow", { companyId: s.companyId, name: "board standalone", steps: [], actor: s.actor });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const workflowId = created.body.data.workflow.id;
  const started = await post("start-workflow", { companyId: s.companyId, workflowId });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, started.body.data.runId));
  expect(run.companyId).toBe(s.companyId); expect(run.triggeredBy).toBe("board");
  expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId))).toHaveLength(0);
  expect(worker.call).not.toHaveBeenCalled();
}, 30_000);
it.each(["url", "bridge"])("%s rejects invalid company, nonowner, intent, action and plugin without writes", async variant => {
  const s = await seed();
  const [other] = await db.insert(agents).values({ companyId: s.companyId, name: "not owner", role: "operator", status: "active", adapterType: "process", adapterConfig: {} }).returning();
  const before = await snapshot();
  const cases = [
    { payload: { ...s.payload, companyId: randomUUID() }, status: 403 },
    { auth: token(other.id, s.companyId), payload: { ...s.payload, actor: s.actor, triggeredBy: "board", child: true }, status: 409 },
    { payload: { ...s.payload, replacementIntent: undefined, actor: s.board, triggeredBy: "board", triggerSource: "scheduler", parentRunId: s.run.id, child: true }, status: 403 },
    { payload: { ...s.payload, replacementIntent: { ...s.payload.replacementIntent, extra: true } }, status: 400 },
    { key: "run-workflow", status: 403 }, { key: "resume-run", status: 403 }, { key: "create-workflow", status: 403 },
    { id: otherPluginId, status: 403 },
    { payload: { ...s.payload, workflowId: undefined }, status: 400 },
    { payload: { ...s.payload, replacementIntent: { ...s.payload.replacementIntent, approvalId: randomUUID() } }, status: 409 },
    { auth: "invalid-token", payload: { ...s.payload, actor: s.actor }, status: 403 },
  ];
  for (const c of cases) {
    const res = await pluginPost(s, variant, c.payload ?? s.payload, c.auth ?? s.token, c.id ?? pluginId, c.key ?? "start-workflow");
    expect(res.status, JSON.stringify(res.body)).toBe(c.status); expect(await snapshot()).toEqual(before);
  }
  await db.update(missions).set({ ownerAgentId: other.id }).where(eq(missions.id, s.mission.id));
  const reassigned = await snapshot();
  const staleOwner = await pluginPost(s, variant);
  expect(staleOwner.status).toBe(409); expect(await snapshot()).toEqual(reassigned);
  expect(worker.call).not.toHaveBeenCalled(); expect(adapter).not.toHaveBeenCalled();
}, 30_000);

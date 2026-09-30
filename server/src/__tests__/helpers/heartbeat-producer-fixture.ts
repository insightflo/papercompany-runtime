import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, instanceSettings, issues,
  workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { workProductService } from "../../services/work-products.js";
import { selectOfficialWorkProduct } from "../../services/workflow/workproduct-selector.js";

// The only execution double: never start a CLI/provider or make a network request.
const adapter = vi.hoisted(() => vi.fn());
export { adapter };
vi.mock("../../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map(),
}));
let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, root: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-producer-");
  const url = new URL(temp.connectionString);
  if (url.hostname !== "127.0.0.1" || ["54329", "5432", "55439"].includes(url.port)) throw new Error("unsafe test DB");
  db = createDb(temp.connectionString); root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-producer-"));
  await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: false } });
}, 60000);
afterAll(async () => {
  if (db) { await waitForHeartbeatExecutionsToDrain(db, 20000); await db.$client.end({ timeout: 5 }); }
  await temp?.cleanup(); if (root) await rm(root, { recursive: true, force: true });
});
export const database = () => db;
export const flag = (enabled: boolean) => db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: enabled } });
export const drain = () => waitForHeartbeatExecutionsToDrain(db, 20000);
export const stopped = { exitCode: 1, signal: null, timedOut: false, errorMessage: "isolated test stop",
  errorCode: "identity_test_stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] };
export async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const workflowRunId = randomUUID(), stepRunId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: `P${companyId.replaceAll("-", "")}` });
  const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "active", adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Isolated callback only" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).returning();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Identity",
    stepsJson: [{ id: "write", name: "Write", type: "agent", agentId, dependencies: [] }] });
  await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, status: "running", triggeredBy: "test" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write", status: "todo", assigneeAgentId: agentId,
    originKind: "workflow_execution", originRunId: workflowRunId });
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "write", issueId, status: "running",
    startedAt: new Date(Date.now() - 1000), executionGeneration: 7 });
  const dir = path.join(root, issueId); await mkdir(dir); const file = path.join(dir, "content.json"); await writeFile(file, "{}");
  const wake = (extra: Record<string, unknown> = {}, idempotencyKey?: string) => {
    const context = { issueId, ...extra };
    return heartbeatService(db).wakeup(agentId, { source: "assignment", reason: "workflow_step_runnable",
      payload: context, contextSnapshot: context, idempotencyKey });
  };
  const readStep = async () => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!;
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const register = (id: string) => workProductService(db).createForIssue(issueId, companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: id, metadata: { path: file } });
  const select = () => selectOfficialWorkProduct(db, { companyId, workflowRunId, stepId: "write", selector: { type: "document", title: "content.json" } });
  const queued = async () => {
    // Actual queue admission is held only by an existing active execution at max=1.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    await wake(); await drain();
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")));
    if (!run) throw new Error("expected actual queued heartbeat");
    const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
    return { run, request };
  };
  return { companyId, agentId, agent, issueId, workflowRunId, stepRunId, file, wake, readRun, readStep, register, select, queued };
}

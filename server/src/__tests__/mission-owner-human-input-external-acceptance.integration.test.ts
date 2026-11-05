import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const runProcess = promisify(execFile);
let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("t16a-human-input-"); db = createDb(pg.connectionString); }, 60_000);
afterAll(async () => {
  await waitForHeartbeatExecutionsToDrain(db);
  await db.$client.end({ timeout: 5 });
  await pg?.cleanup();
}, 60_000);

it("waits for a formal decision after a real loopback failure and resumes one local heartbeat", async () => {
  const companyId = randomUUID(), ownerId = randomUUID(), missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "t16a-human-input-")));
  const marker = path.join(root, "resumed.txt");
  await db.insert(companies).values({ id: companyId, name: "Human input acceptance", issuePrefix: `I${companyId.slice(0, 7)}` });
  await db.insert(agents).values({ id: ownerId, companyId, name: "owner", status: "active" });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "Decision mission", status: "active" });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner oversight", status: "in_progress",
    originKind: "mission_main_executor_oversight", assigneeAgentId: ownerId });
  // The original owner heartbeat is a fixture; the later continuation executes a real local process.
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId, status: "running" });
  await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
  function app(actor: "owner" | "board") {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor === "board"
        ? { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true }
        : { type: "agent", agentId: ownerId, companyId, runId };
      next();
    });
    server.use("/api", workflowAgentApiRoutes(db)); server.use("/api", operatorDecisionRoutes(db)); server.use(errorHandler);
    return server;
  }
  let failedRequests = 0;
  const upstream = createServer((_req, res) => { failedRequests++; res.writeHead(503); res.end("unavailable"); });
  const ownerServer = app("owner").listen(0, "127.0.0.1");
  upstream.listen(0, "127.0.0.1");
  try {
    await Promise.all([once(ownerServer, "listening"), once(upstream, "listening")]);
    const upstreamAddress = upstream.address(), ownerAddress = ownerServer.address();
    if (!upstreamAddress || typeof upstreamAddress === "string" || !ownerAddress || typeof ownerAddress === "string") throw new Error("loopback listener unavailable");
    const body = { decision: "request_input", reason: "Local dependency returned HTTP 503",
      nextAction: "Continue after a formal decision", evidence: "http://127.0.0.1/dependency" };
    const worker = `const failed = await fetch(${JSON.stringify(`http://127.0.0.1:${upstreamAddress.port}/`)});
if (failed.status !== 503) throw Error('expected 503');
const submitted = await fetch(${JSON.stringify(`http://127.0.0.1:${ownerAddress.port}/api/issues/${issueId}/owner-recovery/decision`)},
  {method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}});
if (submitted.status !== 201) throw Error('decision submit status ' + submitted.status);`;
    await runProcess(process.execPath, ["--input-type=module", "-e", worker], { cwd: root, timeout: 30_000 });
    expect(failedRequests).toBe(1);
    const cards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.status).toBe("pending");
    expect(card.requestKey).toBe(`moi1:${card.sourceId}`);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, ownerId))).toHaveLength(0);
    await db.update(agents).set({ status: "idle", adapterType: "process", adapterConfig: {
      command: process.execPath, cwd: root,
      args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'resumed\\n')`],
    } }).where(eq(agents.id, ownerId));
    await db.update(heartbeatRuns).set({ status: "completed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const resolved = await request(app("board")).post(`/api/operator-decisions/${card.id}/resolve`)
      .send({ actionId: "approve", selectedOptionIds: ["approve"], comment: "Proceed" });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data.decision.status).toBe("resolved");
    const continuationWorker = operatorDecisionContinuationWorker(db, { wakeup: heartbeatService(db).wakeup,
      workerId: `t16a-human-input:${card.id}` });
    expect(await continuationWorker.pollOnce(new Date())).toBe(1);
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("resumed\n"), { timeout: 60_000 });
    await waitForHeartbeatExecutionsToDrain(db);
    const [continuation] = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, card.id));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, continuation!.idempotencyKey!));
    const [resumed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
    expect(wake).toMatchObject({ companyId, agentId: ownerId });
    expect(resumed).toMatchObject({ companyId, agentId: ownerId, status: "succeeded" });
    expect(await continuationWorker.pollOnce(new Date())).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("resumed\n");
    console.info("T16A_M07_EVIDENCE", JSON.stringify({ companyId, missionId, issueId, cardId: card.id,
      wakeId: wake!.id, resumedRunId: resumed!.id, dependencyStatus: 503 }));
  } finally {
    await Promise.all([new Promise<void>((resolve, reject) => upstream.close(e => e ? reject(e) : resolve())),
      new Promise<void>((resolve, reject) => ownerServer.close(e => e ? reject(e) : resolve()))]);
    try { await waitForHeartbeatExecutionsToDrain(db); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}, 120_000);

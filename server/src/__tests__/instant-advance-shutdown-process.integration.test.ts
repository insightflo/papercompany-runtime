import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startRuntimeShutdownProcessFixture } from "./helpers/runtime-shutdown-process-fixture.js";
import { runtimeShutdownScenario } from "./helpers/runtime-shutdown-producer.js";

let f: Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;
beforeAll(async () => { f = await startRuntimeShutdownProcessFixture({ parentWorkflowAdmission: true }); }, 120_000);
afterAll(async () => { await f?.cleanup(); });
const env = { HEARTBEAT_SCHEDULER_ENABLED: "true", WORKFLOW_NATIVE_SCHEDULER_ENABLED: "false",
  PAPERCLIP_WORKFLOW_INSTANT_ADVANCE: "1" };
const hasAdvance = (logs: string, workflowRunId: string) => logs.split("\n")
  .some((line) => line.includes("advance start") && line.includes(workflowRunId));

it("allows instant advance normally, stops it after SIGTERM, and resumes the durable workflow once", async () => {
  const instantFile = fileURLToPath(new URL("../services/workflow/instant-advance.ts", import.meta.url));
  const sourceSha256 = createHash("sha256").update(await readFile(instantFile)).digest("hex");
  const control = await runtimeShutdownScenario(f, "instant-control", false, { deferProducer: true });
  await f.writeGate(control.gateFile);
  const controlServer = await f.startServer(undefined, env);
  try {
    const run = await control.nativeProducer.waitStarted();
    const produced = await control.nativeProducer.waitProduced();
    expect(produced.agentId).toBe(run.agentId);
    expect(produced.companyId).toBe(run.companyId);
    expect(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(produced.pid)], { encoding: "utf8" }).trim()))
      .toBe(controlServer.child.pid);
    await control.nativeProducer.register(run.id);
    await control.nativeProducer.release();
    await f.waitFor(async () => {
      const current = await control.nativeProducer.heartbeatRun();
      if (current?.status === "failed") throw new Error(`control heartbeat failed: ${current.errorCode} ${current.error}`);
      return current?.status === "succeeded" && hasAdvance(controlServer.logs(), control.runId) ? true : null;
    }, "control heartbeat and instant advance", 45_000);
    f.recordEvidence("instant-positive-control", controlServer, { runId: run.id, workflowRunId: control.runId,
      producerPid: produced.pid, sourceSha256 });
  } finally {
    await control.nativeProducer.release();
    controlServer.signal("SIGTERM");
    expect((await controlServer.waitExit()).code).toBe(0);
  }
  await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, control.nativeProducer.seed.agentId));

  const target = await runtimeShutdownScenario(f, "instant-shutdown", false, { deferProducer: true });
  const server = await f.startServer(undefined, env);
  try {
    const run = await target.nativeProducer.waitStarted();
    const produced = await target.nativeProducer.waitProduced();
    expect(produced.agentId).toBe(run.agentId);
    expect(produced.companyId).toBe(run.companyId);
    expect(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(produced.pid)], { encoding: "utf8" }).trim()))
      .toBe(server.child.pid);
    await target.nativeProducer.register(run.id);
    server.signal("SIGTERM");
    await f.waitFor(async () => server.logs().includes("Server shutting down") ? true : null, "shutdown signal entry");
    await target.nativeProducer.release();
    expect((await server.waitExit()).code).toBe(0);
    const [finished] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(finished).toMatchObject({ status: "succeeded", contextSnapshot: { workflowRunId: target.runId } });
    expect(hasAdvance(server.logs(), target.runId)).toBe(false);
    expect(await f.events(target.eventsFile)).toEqual([]);
    const pending = await target.qaStep();
    expect(pending.lastDispatchAcceptedAt).toBeNull();
    f.recordEvidence("instant-stopped", server, { runId: run.id, workflowRunId: target.runId,
      stepRunId: pending.id, requestId: pending.lastDispatchRequestId, producerPid: produced.pid, sourceSha256 });
  } finally {
    await target.nativeProducer.release();
  }

  const pending = await target.qaStep();
  await f.writeGate(target.gateFile);
  const restarted = await f.startServer(undefined, { PAPERCLIP_WORKFLOW_INSTANT_ADVANCE: "1" });
  try {
    await f.waitFor(async () => (await target.qaStep()).status === "completed" ? true : null, "QA completion after restart", 90_000);
    const starts = (await f.events(target.eventsFile)).filter((row) => row.event === "started");
    expect(starts).toHaveLength(1);
    expect(starts[0].identity.workflowRunId).toBe(target.runId);
    if (pending.lastDispatchRequestId) expect(starts[0].identity.requestId).toBe(pending.lastDispatchRequestId);
    f.recordEvidence("instant-restart", restarted, { workflowRunId: target.runId, requestId: pending.lastDispatchRequestId,
      starts: starts.length, sourceSha256 });
  } finally {
    restarted.signal("SIGTERM");
    expect((await restarted.waitExit()).code).toBe(0);
  }
}, 240_000);

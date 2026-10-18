import { spawn } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { missions, workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { fixture, database } from "./helpers/qa-receipt-fixture.js";
import type { ArtifactRoot } from "../services/workflow/artifact-files.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { assertQaReceiptScope, readQaReceiptBytes, verifyQaArtifact } from "../services/workflow/qa-artifact-receipt.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import * as writer from "../services/workflow/artifact-writer.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
// The fixture's external QA producer is a machine-contract test double.
// These tests do not establish production content quality or live mission completion.
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function peer() {
  const connection = await database().$client.reserve();
  return { db: drizzle(connection, { schema: database()._.fullSchema }), close: () => connection.release() };
}
async function step(f: Fixture, db: Db) {
  const [value] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  return value;
}
async function prepare(f: Fixture, db: Db = database()) {
  const value = await prepareQaArtifactRequest({ db, companyId: f.companyId, workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: "qa", requestId: f.requestId,
    parameters: { content: f.content, assetsDir: f.assetsDir, section: "tech-blog" } });
  if (!value) throw new Error("QA fixture requires an artifact contract");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function pausePreparations(count: number) {
  const original = writer.createArtifactDirectory, tasks: Promise<unknown>[] = [];
  const gates = Array.from({ length: count }, () => ({ entered: deferred<ArtifactRoot>(), release: deferred<void>() }));
  let slot = 0;
  const spy = vi.spyOn(writer, "createArtifactDirectory").mockImplementation(async (...args) => {
    const gate = gates[slot++];
    try {
      const root = await original(...args);
      if (gate) { gate.entered.resolve(root); await gate.release.promise; }
      return root;
    } catch (error) { gate?.entered.reject(error); throw error; }
  });
  return { gates,
    start<T>(task: Promise<T>) { tasks.push(task); void task.catch(() => undefined); return task; },
    async close() {
      gates.forEach(g => g.release.resolve(undefined));
      await Promise.allSettled(tasks); spy.mockRestore();
    } };
}
async function finiteFault(f: Fixture, kind: string) {
  const file = path.join(path.dirname(f.content), "finite-write-fault.cjs");
  await writeFile(file, `
const fs = require('node:fs'), write = fs.writeFileSync, sync = fs.fsyncSync;
const kind = ${JSON.stringify(kind)};
const fail = () => { throw Object.assign(Error('finite_C03'), {code: 'EIO'}); };
fs.writeFileSync = function(fd, data, ...rest) {
  const hit = (kind === 'content' && process.cwd().endsWith('/input'))
    || (kind === 'asset' && process.cwd().endsWith('/input/assets'));
  if (hit && typeof fd === 'number' && Buffer.isBuffer(data)) {
    write.call(fs, fd, data.subarray(0, Math.min(3, data.length)), ...rest); fail();
  }
  return write.call(fs, fd, data, ...rest);
};
fs.fsyncSync = function(fd) {
  if (kind === 'directory-sync' && process.cwd().includes('/attempts/') && fs.fstatSync(fd).isDirectory()) fail();
  return sync.call(fs, fd);
};`);
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let armed = true;
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    if (armed && Array.isArray(args) && args[0] === "-e" && String(args[1]).includes("node.directories")) {
      armed = false;
      return actual.spawn(command, args, { ...options,
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(file)}` } });
    }
    return actual.spawn(command, args as readonly string[], options);
  });
  return () => vi.mocked(spawn).mockImplementation(actual.spawn);
}

it.each(["content", "asset", "directory-sync"])("retries the same database/generation/request after finite %s failure", async kind => {
  const f = await fixture(), other = await peer(), restore = await finiteFault(f, kind);
  try {
    await expect(prepare(f)).rejects.toThrow("finite_C03");
    expect((await step(f, other.db)).metadata.toolArtifactRequest).toBeUndefined();
    restore();
    const ready = await prepare(f);
    const persisted = await step(f, other.db);
    expect(persisted.executionGeneration).toBe(2);
    expect(persisted.lastDispatchRequestId).toBe(f.requestId);
    expect(persisted.metadata.toolArtifactRequest).toEqual(ready.snapshot);
    expect(await readFile(String(ready.parameters.content))).toEqual(await readFile(f.content));
    expect(await readFile(path.join(String(ready.parameters.assetsDir), "hero.png"))).toEqual(await readFile(path.join(f.assetsDir, "hero.png")));
    const envelope = JSON.parse(ready.inputBytes.toString("utf8"));
    expect(Buffer.from(envelope.content.base64, "base64")).toEqual(await readFile(f.content));
    expect(Buffer.from(envelope.assets[0].base64, "base64")).toEqual(await readFile(path.join(f.assetsDir, "hero.png")));
    expect((await readdir(path.dirname(ready.snapshot.outputRoot))).length).toBeGreaterThanOrEqual(2);
  } finally { restore(); other.close(); }
}, 30000);

it("converges concurrent preparation on the first authority and preserves its result and receipt", async () => {
  const f = await fixture(), other = await peer(), held = pausePreparations(2);
  try {
    const first = held.start(prepare(f));
    const candidateA = await held.gates[0].entered.promise;
    const second = held.start(prepare(f, other.db));
    const candidateB = await held.gates[1].entered.promise;
    expect(candidateA.path).not.toBe(candidateB.path);
    // This independent connection must remain writable while filesystem preparation is paused.
    await other.db.update(workflowStepRuns).set({ metadata: sql`${workflowStepRuns.metadata} || '{"unrelated":"preserved"}'::jsonb` })
      .where(eq(workflowStepRuns.id, f.qaId));
    held.gates[0].release.resolve(undefined);
    const authority = await first;
    const result = await held.start(f.invoke());
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const receipt = result.toolArtifactReceipt!;
    const resultPath = path.join(receipt.outputRoot, receipt.relativePath), saved = await readFile(resultPath);
    const before = await step(f, other.db);
    held.gates[1].release.resolve(undefined);
    const follower = await second;
    expect(authority.snapshot.outputRoot).toBe(candidateA.path);
    expect(follower.snapshot).toEqual(authority.snapshot);
    expect(follower.parameters.content).toBe(path.join(candidateA.path, "input/content.json"));
    expect(String(follower.parameters.content)).not.toContain(candidateB.path);
    expect(Buffer.from(JSON.parse(follower.inputBytes.toString()).content.base64, "base64"))
      .toEqual(await readFile(path.join(candidateA.path, "input/content.json")));
    const after = await step(f, other.db);
    expect(after.metadata.toolArtifactRequest).toEqual(before.metadata.toolArtifactRequest);
    expect(after.metadata.unrelated).toBe("preserved");
    const scope = { run: { id: f.runId, companyId: f.companyId, missionId: f.missionId }, stepRun: after };
    expect(assertQaReceiptScope(receipt, scope, f.requestId)).toEqual(receipt);
    expect((await verifyQaArtifact(follower, { id: f.toolId, name: "local-qa" }, receipt.toolDeployment)).receipt).toEqual(receipt);
    const writes = await Promise.allSettled([
      writer.writeArtifactFile(follower.snapshot.root, receipt.relativePath, saved),
      writer.writeArtifactFile(follower.snapshot.root, receipt.relativePath, Buffer.concat([saved, Buffer.from(" ")])),
    ]);
    expect(writes.map(value => value.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(resultPath)).toEqual(saved);
    await completeWorkflowToolStepFromResult(database(), { companyId: f.companyId, workflowRunId: f.runId,
      stepRunId: f.qaId, stepId: "qa", requestId: f.requestId, toolName: "local-qa", success: true,
      toolArtifactReceipt: receipt, data: result.body.data });
    expect((await readQaReceiptBytes(other.db, { companyId: f.companyId, workflowRunId: f.runId, stepId: "qa" })).receipt).toEqual(receipt);
  } finally { await held.close(); other.close(); }
}, 30000);

it("rejects another input for the same concurrent request without replacing the first snapshot", async () => {
  const f = await fixture(), other = await peer(), held = pausePreparations(2), original = await readFile(f.content);
  try {
    const first = held.start(prepare(f)); await held.gates[0].entered.promise;
    const changed = JSON.parse(original.toString()); changed.title = "Different input";
    await writeFile(f.content, JSON.stringify(changed));
    const second = held.start(prepare(f, other.db)); await held.gates[1].entered.promise;
    held.gates[0].release.resolve(undefined); const authority = await first;
    held.gates[1].release.resolve(undefined);
    await expect(second).rejects.toThrow("qa_artifact_request_conflict");
    expect((await step(f, other.db)).metadata.toolArtifactRequest).toEqual(authority.snapshot);
    expect(await readFile(String(authority.parameters.content))).toEqual(original);
  } finally { await held.close(); other.close(); }
}, 30000);

it.each(["generation", "retry", "iteration", "dispatch", "mission", "run", "step", "pin", "contract"])(
  "rechecks %s after storage and before snapshot commitment", async kind => {
    const f = await fixture(), other = await peer(), held = pausePreparations(1);
    try {
      const pending = held.start(prepare(f)); await held.gates[0].entered.promise;
      if (kind === "generation") await other.db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, f.qaId));
      if (kind === "retry") await other.db.update(workflowStepRuns).set({ retryCount: 1 }).where(eq(workflowStepRuns.id, f.qaId));
      if (kind === "iteration") await other.db.update(workflowStepRuns).set({ iterationIndex: 1 }).where(eq(workflowStepRuns.id, f.qaId));
      if (kind === "dispatch") await other.db.update(workflowStepRuns).set({ lastDispatchRequestId: "other" }).where(eq(workflowStepRuns.id, f.qaId));
      if (kind === "mission") await other.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.missionId));
      if (kind === "run") await other.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, f.runId));
      if (kind === "step") await other.db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.qaId));
      if (kind === "pin") await other.db.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: 99 })
        .where(eq(workflowStepOutputBindings.consumerStepRunId, f.qaId));
      if (kind === "contract") await other.db.update(workflowStepRuns).set({ metadata:
        sql`jsonb_set(${workflowStepRuns.metadata}, '{artifactExecution,contractHash}', ${JSON.stringify("0".repeat(64))}::jsonb)` })
        .where(eq(workflowStepRuns.id, f.qaId));
      held.gates[0].release.resolve(undefined);
      await expect(pending).rejects.toThrow();
      expect((await step(f, other.db)).metadata.toolArtifactRequest).toBeUndefined();
    } finally { await held.close(); other.close(); }
  }, 30000,
);
it.each(["content", "asset"])("rejects damaged authoritative %s bytes without replacing the snapshot", async kind => {
  const f = await fixture(), other = await peer();
  try {
    const authority = await prepare(f);
    const file = kind === "content" ? String(authority.parameters.content)
      : path.join(String(authority.parameters.assetsDir), "hero.png");
    await chmod(path.dirname(file), 0o700); await chmod(file, 0o600); await writeFile(file, "damaged");
    await expect(prepare(f)).rejects.toThrow("qa_artifact_input_changed");
    expect((await step(f, other.db)).metadata.toolArtifactRequest).toEqual(authority.snapshot);
    expect(await readFile(file, "utf8")).toBe("damaged");
  } finally { other.close(); }
}, 30000);

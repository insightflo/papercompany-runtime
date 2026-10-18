import { expect, it, vi } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { activityLog, issues, toolDefinitions, toolExecutionHeartbeats, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";
import { completeWorkflowToolStepFromResult, syncWorkflowRunState, type WorkflowStep } from "../services/workflow/dag-engine.js";
import { executeQaByteTool } from "../services/workflow/qa-byte-transport.js";
import { executeLocalToolWithProgress } from "../services/workflow/local-tool-progress-executor.js";

// Keep real child/FD, verifier, completion and rework DB paths; seal unrelated agent execution.
const { wakeup } = vi.hoisted(() => ({ wakeup: vi.fn(async () => null) }));
vi.mock("../services/heartbeat.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/heartbeat.js")>(),
  heartbeatService: () => ({ wakeup }),
}));
vi.mock("../services/issue-assignment-wakeup.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
    actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup } }) };
});

const progressPolicy = { version: 1 as const, idleTimeoutMs: 5000, maxDurationMs: 15000,
  stages: [{ key: "qa", unit: "items" as const }] };


it("progress-enabled QA uses stdin bytes and FD4 while FD3 remains progress-only", async () => {
  const f = await fixture();
  const [tool] = await database().select().from(toolDefinitions).where(eq(toolDefinitions.companyId, f.companyId));
  await database().update(toolDefinitions).set({ adapterConfig: { ...tool.adapterConfig,
    progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000, stages: [{ key: "qa", unit: "items" }] } } })
    .where(eq(toolDefinitions.id, tool.id));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.body.content).toBe('not JSON; stdout is diagnostic only');
});

it("stdout cannot replace the required machine result channel", async () => {
  const f = await fixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  await writeFile(script, `import fs from 'node:fs';fs.readFileSync(0);console.log(JSON.stringify({ok:true,schemaVersion:'manual-onboarding.qa.v1'}));`);

  const result = await f.invoke();
  expect(result.status).toBe(500); expect(result.body.error).toContain('qa_result_transport_missing');
  expect(result.toolArtifactReceipt).toBeUndefined();
});

it("runner receives verified-byte FD result but refuses persistence through a swapped root", async () => {
  const f = await fixture();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  await writeFile(script, `import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
if(process.env.PAPERCOMPANY_QA_INPUT!=='stdin-v1') throw Error('transport_required');
const v=JSON.parse(fs.readFileSync(0,'utf8')), h=b=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from(v.content.base64,'base64');if(h(source)!==v.content.sha256)throw Error('wrong_bytes');
const root=path.dirname(a.out), outside=root+'-outside';fs.mkdirSync(outside);fs.renameSync(root,root+'-old');fs.symlinkSync(outside,root);
const q={schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:'tech-blog',ok:true,checkedAt:new Date().toISOString(),checks:[{id:'fixture',ok:true,detail:null}],artifactPath:a.out,contentSha256:h(source),assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
fs.writeFileSync(4,JSON.stringify(q));console.log('diagnostic only');`);

  const r=await f.invoke();
  // Root changed after spawn: fail closed, and never write through the replacement.
  expect(r.status).toBe(500);
  expect(r.body.error).not.toContain('transport_required');
  expect(r.body.error).toContain('artifact_root_replaced');
  const { workflowStepRuns } = await import('@paperclipai/db');
  const [step]=await database().select().from(workflowStepRuns).where(eq(workflowStepRuns.id,f.qaId));
  const output=(step.metadata.toolArtifactRequest as {outputRoot:string}).outputRoot;
  await expect(readFile(path.join(output+'-outside','qa-result.json'))).rejects.toThrow();
});

type Kind = "negative" | "negative-zero" | "pass" | "positive-exit1" | "wrong-input" | "wrong-type"
  | "malformed" | "missing" | "stdout-only" | "crash" | "exit2" | "signal" | "timeout"
  | "overflow" | "output-overflow" | "bad-progress" | "runtime-pass-zero" | "runtime-pass-exit1";

async function invokeCase(progress: boolean, kind: Kind) {
  const f = await fixture(), db = database();
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  const steps = (definition.stepsJson as WorkflowStep[]).map(step => step.id === "write"
    ? { ...step, graphWorkProductRequired: true, conditionalDependencies: [
      { stepId: "qa", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] }
    : { ...step, qaType: "action" as const });
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition.id));
  await db.update(workflowStepRuns).set({ completedAt: new Date(Date.now() - 1000) }).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  const [producer] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write")));
  await db.update(issues).set({ assigneeAgentId: steps[0].agentId }).where(eq(issues.id, producer.issueId!));
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  if (kind.startsWith("runtime-pass-")) {
    const content = JSON.parse(await readFile(f.content, "utf8"));
    await writeFile(f.content, JSON.stringify({ ...content, summary: "see http://example.com/insecure" }));
  }
  const original = await readFile(script, "utf8");
  const emission = `
const kind=${JSON.stringify(kind)}, progress=${JSON.stringify(progress)};
writeFileSync(new URL(import.meta.url+'.ran'),kind);
console.log('qa_artifact_verdict_failed');
if(progress)writeFileSync(3,JSON.stringify({version:1,executionId:process.env.PAPERCOMPANY_TOOL_EXECUTION_ID,
 sequence:1,stage:'qa',unit:'items',current:1})+String.fromCharCode(10));
q.ok=q.checks[0].ok=(kind==='pass'||kind==='positive-exit1'||kind.startsWith('runtime-pass-'));
q.checks[0].detail='x'.repeat(256*1024);
if(kind==='overflow')q.checks[0].detail='x'.repeat(1024*1024+1);
if(kind==='wrong-input')q.contentSha256='0'.repeat(64);
if(kind==='wrong-type')q.ok='false';
process.exitCode=kind==='pass'||kind==='negative-zero'||kind==='runtime-pass-zero'?0:kind==='exit2'?2:1;
const payload=Buffer.from(kind==='malformed'?'{bad}':JSON.stringify(q));
if(kind==='stdout-only')console.log(JSON.stringify(q));
else if(kind!=='missing'&&kind!=='crash'){
 writeFileSync(4,payload.subarray(0,-1));
 writeFileSync(4,payload.subarray(-1));
}
if(kind==='output-overflow')writeFileSync(1,Buffer.alloc(10*1024*1024+1,120));
if(kind==='bad-progress')writeFileSync(3,'{bad}'+String.fromCharCode(10));
if(kind==='signal')process.kill(process.pid,'SIGTERM');
if(kind==='timeout')setInterval(()=>{},1000);
`;
  expect(original).toContain("writeFileSync(4,JSON.stringify(q));");
  await writeFile(script, original.replace("writeFileSync(4,JSON.stringify(q));", emission));
  await db.update(toolDefinitions).set({ adapterConfig: { ...f.adapterConfig, timeoutMs: kind === "timeout" ? 1000 : 15000,
    ...(progress ? { progress: kind === "timeout" ? { ...progressPolicy, idleTimeoutMs: 1000, maxDurationMs: 1000 } : progressPolicy } : {}) } })
    .where(eq(toolDefinitions.id, f.toolId));
  const result = await f.invoke();
  expect(await readFile(script + ".ran", "utf8")).toBe(kind);
  return { f, producer, result };
}

// C01 defines the oracle: current negative evidence costs one producer iteration;
// process/transport/contract failures cost zero, and positive exit-one is never success.
const cases: Kind[] = ["negative", "negative-zero", "pass", "positive-exit1", "wrong-input", "wrong-type",
  "malformed", "missing", "stdout-only", "crash", "exit2", "signal", "timeout", "overflow", "output-overflow", "runtime-pass-zero", "runtime-pass-exit1"];
it.each([false, true].flatMap(progress => cases.map(kind => ({ progress, kind }))))
  ("real QA exit/FD result reaches completion and bounded rework ($progress, $kind)", async ({ progress, kind }) => {
    const { f, producer: before, result } = await invokeCase(progress, kind), db = database();
    const rejection = kind === "negative" || kind === "negative-zero" || kind === "runtime-pass-zero";
    expect(result.status, JSON.stringify(result.body).slice(0, 1000)).toBe(kind === "pass" ? 200 : 500);
    if (rejection) {
      if (kind === "runtime-pass-zero") expect(result.body.error).toMatch(/^qa_artifact_runtime_checks_failed:https-links /);
      else expect(result.body.error).toBe("qa_artifact_verdict_failed");
      if (kind === "negative") expect(result.body.data).toMatchObject({ exitCode: 1 });
    } else if (kind !== "pass") {
      expect(result.body.error).not.toMatch(/^qa_artifact_(verdict_failed|runtime_checks_failed:)/);
    }
    expect(!!result.toolArtifactReceipt).toBe(kind === "pass");
    if (progress) {
      const [heartbeat] = await db.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.toolId, f.toolId));
      expect(heartbeat.state).toBe(kind === "pass" || kind === "negative-zero" || kind === "runtime-pass-zero" ? "succeeded"
        : kind === "timeout" ? "timed_out" : "failed");
    }
    await completeWorkflowToolStepFromResult(db, { companyId: f.companyId, workflowRunId: f.runId,
      stepRunId: f.qaId, stepId: "qa", requestId: f.requestId, toolName: "local-qa",
      success: result.status === 200, data: result.body.data, stdout: result.body.content,
      error: result.body.error, stderr: result.body.stderr, toolArtifactReceipt: result.toolArtifactReceipt });
    const read = async () => {
      const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, f.runId));
      return { producer: rows.find(row => row.stepId === "write")!, qa: rows.find(row => row.id === f.qaId)! };
    };
    const after = await read();
    expect(after.producer.iterationIndex).toBe(before.iterationIndex + (rejection ? 1 : 0));
    if (rejection) {
      expect(["pending", "running"]).toContain(after.producer.status);
      expect(after.producer.metadata.attempts).toHaveLength(1);
      expect(after.qa.status).toBe("pending");
      expect(after.qa.lastDispatchRequestId).toBeNull();
      expect(after.qa.metadata.toolArtifactReceipt).toBeUndefined();
    } else {
      expect(after.producer.metadata.attempts).toEqual(before.metadata.attempts);
      expect(after.qa.status).toBe(kind === "pass" ? "completed" : "failed");
    }
    const resets = await db.select().from(activityLog).where(and(eq(activityLog.entityId, before.id),
      eq(activityLog.action, "workflow.rework_reset")));
    expect(resets).toHaveLength(rejection ? 1 : 0);
    await syncWorkflowRunState(db, f.runId);
    expect((await read()).producer.iterationIndex).toBe(after.producer.iterationIndex);
  }, 20000);

it("valid negative FD4 bytes cannot override malformed progress or consume rework", async () => {
  const { f, producer, result } = await invokeCase(true, "bad-progress"), db = database();
  expect(result.status).toBe(500);
  expect(result.body.error).toContain("tool_progress_protocol_error");
  await completeWorkflowToolStepFromResult(db, { companyId: f.companyId, stepRunId: f.qaId,
    requestId: f.requestId, success: false, error: result.body.error });
  const [after] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producer.id));
  expect(after.iterationIndex).toBe(producer.iterationIndex);
  expect(after.metadata.attempts).toEqual(producer.metadata.attempts);
});

// Transport alone never treats bytes as content authority. The opt-in belongs to the QA caller,
// so publication/non-QA users retain nonzero failure even with a populated result channel.
it.each([false, true])("non-QA result transport retains exit-one failure (progress=%s)", async progress => {
  const f = await fixture(), db = database();
  const [tool] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, f.toolId));
  const args = ["-e", "const fs=require('node:fs');fs.readFileSync(0);fs.writeFileSync(4,'negative');process.exitCode=1;"];
  const input = { executable: process.execPath, args, cwd: f.adapterConfig.workingDirectory, env: process.env,
    inputBytes: Buffer.from("{}"), qaResult: true };
  const error = await (progress ? executeLocalToolWithProgress({ ...input, db, policy: progressPolicy,
    scope: { companyId: f.companyId, toolId: tool.id, requestId: f.requestId, adapterType: "builtin" } })
    : executeQaByteTool({ ...input, timeoutMs: 5000 })).then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: 1 });
});

it.each([false, true])("QA opt-in drains exit-one candidate bytes before returning (progress=%s)", async progress => {
  const f = await fixture(), db = database(), payload = "x".repeat(256 * 1024) + "last byte";
  const input = { executable: process.execPath,
    args: ["-e", "const fs=require('node:fs');fs.readFileSync(0);fs.writeFileSync(4,'x'.repeat(256*1024));fs.writeFileSync(4,'last byte');process.exitCode=1;"],
    cwd: f.adapterConfig.workingDirectory, env: process.env, inputBytes: Buffer.from("{}"),
    qaResult: true, acceptQaExit1: true };
  const result = await (progress ? executeLocalToolWithProgress({ ...input, db, policy: progressPolicy,
    scope: { companyId: f.companyId, toolId: f.toolId, requestId: f.requestId, adapterType: "builtin" } })
    : executeQaByteTool({ ...input, timeoutMs: 5000 }));
  expect(result.exitCode).toBe(1);
  expect(result.qaResultBytes?.toString()).toBe(payload);
});

import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { captureArtifactRoot, digest } from "../services/workflow/artifact-files.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { verifyQaArtifact } from "../services/workflow/qa-artifact-receipt.js";
import { deriveMechanicalQaRejection } from "../services/workflow/control-flow/edge-condition.js";
import { persistFailedToolDispatch } from "../services/workflow/tool-dispatch-failure.js";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";

// C01: only a negative result for the current, intact input authorizes content rework.
// Invalid contracts/results/bytes and diagnostic text must remain execution failures.
const qaStep = { id: "qa", name: "QA", type: "tool" as const, agentId: "", qaType: "action" as const, dependencies: [] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const reworkFor = (message: string) => deriveMechanicalQaRejection({
  step: qaStep, run: { issueId: null, status: "failed", lastDispatchErrorSummary: message },
});
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

// This fixture supplies an already pinned request; the DB/real-child boundary is exercised below.
async function receiptFixture(html = false, sourceText?: string) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-rejection-contract-")));
  roots.push(dir);
  await mkdir(path.join(dir, "input", "assets"), { recursive: true });
  await mkdir(path.join(dir, "input", "ancillary"), { recursive: true });
  const source = Buffer.from(sourceText ?? (html ? "<h1>Ready</h1>" : '{"title":"Ready"}'));
  const file = html ? "page.html" : "content.json";
  const assetBytes = Buffer.from("image"), ancillaryBytes = Buffer.from('{"checked":true}');
  const asset = { fileName: "hero.png", sha256: digest(assetBytes), byteSize: assetBytes.length };
  const ancillary = { fileName: "capture.json", sha256: digest(ancillaryBytes), byteSize: ancillaryBytes.length };
  await writeFile(path.join(dir, "input", file), source);
  await writeFile(path.join(dir, "input", "assets", asset.fileName), assetBytes);
  await writeFile(path.join(dir, "input", "ancillary", ancillary.fileName), ancillaryBytes);
  const contract = { role: "qa" as const, resultAdapter: "generic" as const, resultSchemaVersion: "workflow.qa-result.v1",
    resultFileName: "inspection.json", inputParams: {}, deploymentFiles: ["inspect.mjs"], inputEnvelopeVersion: "input.v1" };
  const companyId = randomUUID(), missionId = randomUUID(), workflowRunId = randomUUID(), stepRunId = randomUUID();
  const snapshot = { root: await captureArtifactRoot(dir), outputRoot: dir, outputRootHash: "a".repeat(64),
    companyId, missionId, workflowRunId, stepRunId, stepId: "qa", executionGeneration: 0, retryCount: 0, iterationIndex: 0,
    requestId: "request", artifactExecution: freezeArtifactAttempt({ adapterConfig: { artifactContract: contract },
      step: {}, executionGeneration: 0, requestId: "request" })!,
    input: { workProductId: randomUUID(), path: path.join(dir, file), sha256: digest(source), byteSize: source.length,
      assetsRoot: "", assetManifest: [asset], producer: { schemaVersion: "workflow.work-product-producer.v1" as const,
        companyId, missionId, workflowRunId, stepRunId, stepId: "write", executionGeneration: 0, retryCount: 0,
        iterationIndex: 0, heartbeatRunId: randomUUID() },
      ...(html ? { mode: "html" as const, htmlManifest: { path: path.join(dir, "html-input.json"),
        sha256: "b".repeat(64), byteSize: 1 }, ancillaryManifest: [ancillary] } : {}) } };
  const raw = { schemaVersion: contract.resultSchemaVersion, ok: false, checks: [{ id: "plugin", ok: false }],
    inputDigest: { sha256: digest(source), mode: html ? "html" : "content" },
    assetManifest: [{ ...asset }], ancillaryManifest: html ? [{ ...ancillary }] : undefined };
  const writeResult = () => writeFile(path.join(dir, contract.resultFileName), JSON.stringify(raw));
  const verify = () => verifyQaArtifact({ snapshot }, { id: randomUUID(), name: "inspect" },
    [{ fileName: "inspect.mjs", sha256: "c".repeat(64), byteSize: 1 }]);
  return { dir, file, snapshot, raw, writeResult, verify };
}

it.each([false, true])("valid current negative results remain content rejections (html=%s)", async html => {
  const f = await receiptFixture(html);
  await f.writeResult();
  const error = await failure(f.verify());
  expect(error.message).toBe("qa_artifact_verdict_failed");
  expect(reworkFor(error.message)).toBe(true);
});

it("a failed plugin check remains a rejection even when the top-level verdict is positive", async () => {
  const f = await receiptFixture();
  f.raw.ok = true;
  await f.writeResult();
  expect((await failure(f.verify())).message).toBe("qa_artifact_verdict_failed");
});

it.each(["mode", "input-hash", "asset-hash", "asset-size", "ancillary-hash", "result-schema",
  "ok-type", "check-type", "contract-hash", "contract-scope", "receipt-scope", "captured-input",
  "captured-size", "captured-asset", "captured-ancillary", "missing-input", "invalid-content-json"])(
  "a negative result with invalid %s cannot authorize rework", async fault => {
    const f = await receiptFixture(fault !== "invalid-content-json");
    switch (fault) {
      case "mode": f.raw.inputDigest.mode = "content"; break;
      case "input-hash": f.raw.inputDigest.sha256 = "0".repeat(64); break;
      case "asset-hash": f.raw.assetManifest[0].sha256 = "0".repeat(64); break;
      case "asset-size": f.raw.assetManifest[0].byteSize++; break;
      case "ancillary-hash": f.raw.ancillaryManifest![0].sha256 = "0".repeat(64); break;
      case "result-schema": f.raw.schemaVersion = "other.v1"; break;
      case "ok-type": Object.assign(f.raw, { ok: "false" }); break;
      case "check-type": Object.assign(f.raw.checks[0], { ok: "false" }); break;
      case "contract-hash": f.snapshot.artifactExecution.contractHash = "0".repeat(64); break;
      case "contract-scope": f.snapshot.artifactExecution.requestId = "other"; break;
      case "receipt-scope": Object.assign(f.snapshot, { companyId: "not-a-company-id" }); break;
      case "captured-input": await writeFile(path.join(f.dir, "input", f.file), "changed"); break;
      case "captured-size": f.snapshot.input.byteSize++; break;
      case "captured-asset": await writeFile(path.join(f.dir, "input", "assets", "hero.png"), "changed"); break;
      case "captured-ancillary": await writeFile(path.join(f.dir, "input", "ancillary", "capture.json"), "changed"); break;
      case "missing-input": await rm(path.join(f.dir, "input", f.file)); break;
      case "invalid-content-json": {
        const bytes = Buffer.from("{invalid json");
        await writeFile(path.join(f.dir, "input", f.file), bytes);
        f.snapshot.input.sha256 = f.raw.inputDigest.sha256 = digest(bytes);
        f.snapshot.input.byteSize = bytes.length;
        break;
      }
    }
    await f.writeResult();
    const error = await failure(f.verify());
    expect(reworkFor(error.message), error.message).toBe(false);
  });

it.each([false, true])("valid passes retain byte receipts and separated checks (html=%s)", async html => {
  const f = await receiptFixture(html);
  f.raw.ok = f.raw.checks[0].ok = true;
  await f.writeResult();
  const { receipt, qa } = await f.verify();
  expect(qa.ok).toBe(true);
  expect(receipt.sha256).toBe(digest(JSON.stringify(f.raw)));
  expect(receipt.schemaVersion).toBe("workflow.tool-artifact.v2");
  if (receipt.schemaVersion !== "workflow.tool-artifact.v2") throw new Error("expected v2 receipt");
  expect(receipt.pluginChecks).toEqual([{ id: "plugin", ok: true }]);
  expect(receipt.runtimeChecks).toContainEqual({ id: "provenance", ok: true, severity: "error" });
});

it("runtime content rejection keeps its existing actionable summary", async () => {
  const f = await receiptFixture(false, '{"text":"see http://example.com/insecure"}');
  f.raw.ok = f.raw.checks[0].ok = true;
  await f.writeResult();
  const error = await failure(f.verify());
  expect(error.message).toBe("qa_artifact_runtime_checks_failed:https-links insecure links: http://example.com/insecure");
  expect(reworkFor(error.message)).toBe(true);
});

type Kind = "reject" | "wrong-input" | "wrong-type" | "stdout-only" | "crash";
async function invokeFailure(progress: boolean, kind: Kind) {
  const f = await fixture(), db = database();
  const script = path.join(f.adapterConfig.workingDirectory, f.adapterConfig.artifactContract.deploymentFiles[0]);
  // Explicit machine-contract producer double. It exits zero for a negative verdict in C01-1;
  // valid negative exit-one transport and full rework execution belong to C01-2.
  await writeFile(script, `import fs from 'node:fs';
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const q={schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:null,
ok:${kind === "wrong-type" ? "'false'" : "false"},checks:[{id:'plugin',ok:false}],
checkedAt:new Date().toISOString(),artifactPath:'',
contentSha256:${kind === "wrong-input" ? "'0'.repeat(64)" : "v.content.sha256"},
assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))};
if(${JSON.stringify(kind)}==='crash'){
 console.log('qa_artifact_verdict_failed');console.error('qa_artifact_verdict_failed');process.exitCode=1;
}else if(${JSON.stringify(kind)}==='stdout-only'){
 console.log(JSON.stringify(q));console.error('qa_artifact_verdict_failed');
}else{fs.writeFileSync(4,JSON.stringify(q));console.log('qa_artifact_verdict_failed');}
`);
  if (progress) await db.update(toolDefinitions).set({ adapterConfig: { ...f.adapterConfig,
    progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000, stages: [{ key: "qa", unit: "items" }] } } })
    .where(eq(toolDefinitions.id, f.toolId));
  const result = await f.invoke();
  expect(result.status, JSON.stringify(result.body)).toBe(500);
  expect(result.toolArtifactReceipt).toBeUndefined();
  expect(result.body.error).toBeTruthy();
  const [running] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await persistFailedToolDispatch({ db, step: qaStep, stepRun: running, now: new Date(),
    requestId: f.requestId, toolName: "local-qa", args: {}, error: new Error(result.body.error) }, running.metadata);
  const [failed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(failed.status).toBe("failed");
  expect(failed.lastDispatchErrorSummary).toBe(result.body.error);
  expect(failed.iterationIndex).toBe(running.iterationIndex);
  return { result, failed };
}

it.each([false, true])("the verifier rejection reaches the persisted rework consumer (progress=%s)", async progress => {
  const { result, failed } = await invokeFailure(progress, "reject");
  expect(result.body.error).toBe("qa_artifact_verdict_failed");
  expect(deriveMechanicalQaRejection({ step: qaStep, run: failed })).toBe(true);
});

it.each([
  [false, "wrong-input"], [true, "wrong-input"], [false, "wrong-type"], [true, "wrong-type"],
  [false, "stdout-only"], [true, "stdout-only"], [false, "crash"], [true, "crash"],
] as const)("invalid results/diagnostics never derive rework (progress=%s, kind=%s)", async (progress, kind) => {
  const { failed } = await invokeFailure(progress, kind);
  expect(deriveMechanicalQaRejection({ step: qaStep, run: failed })).toBe(false);
});

import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import type { ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { freezeArtifactAttempt } from "../../services/workflow/artifact-contract-runtime.js";
import { prepareQaArtifactRequest } from "../../services/workflow/qa-artifact-request.js";
import { resolveWorkflowToolStepArgs } from "../../services/workflow/tool-step-args.js";
import { writeArtifactFile } from "../../services/workflow/artifact-writer.js";
import type { QaCorrectionToolConsumptionProof } from "../../services/workflow/qa-artifact-receipt.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, issueC02, issueNextC02,
  type C02Case } from "./c02-fixture.js";

export { commitBuffers, commitFacts, createCommitSourceHarness, issueC02 };

export async function currentConsumptionStep(c: C02Case) {
  const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
  if (!step) throw Error("consumption QA step missing");
  return step;
}

/** Small assembly from the accepted request test: real dispatch freeze, selector and request writer. */
export async function prepareConsumptionRequest(c: C02Case) {
  const { s } = c, current = await currentConsumptionStep(c);
  const [run] = await c.peer.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
  const [definition] = await c.peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  const workflowSteps = definition!.stepsJson as Parameters<typeof resolveWorkflowToolStepArgs>[0]["workflowSteps"];
  const qa = workflowSteps.find(step => step.id === current.stepId)!;
  const requestId = "c02-tool:" + randomUUID();
  const frozen = freezeArtifactAttempt({ adapterConfig: { artifactContract: s.request.artifactExecution.contract },
    step: qa, executionGeneration: current.executionGeneration, requestId });
  if (!frozen) throw Error("real frozen QA required");
  await c.peer.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId,
    metadata: { ...current.metadata, artifactExecution: frozen } }).where(eq(workflowStepRuns.id, current.id));
  await c.peer.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: s.producer.executionGeneration })
    .where(eq(workflowStepOutputBindings.id, s.f.bindingId));
  const toolArgs = s.mode === "html"
    ? { html: "{$steps.produce.workProductPath}", manifest: "{$steps.produce.workProductDir}/bundle-index.json" }
    : { content: "{$steps.produce.workProductPath}",
      ...(s.mode === "content-only" ? {} : { assets: "{$steps.produce.siblingAssetsDir}" }) };
  const parameters = await resolveWorkflowToolStepArgs({ db: s.db, run: run!, consumerStepRunId: current.id,
    workflowSteps, step: { ...qa, toolArgs } });
  const request = await prepareQaArtifactRequest({ db: s.db, companyId: s.p.companyId,
    workflowRunId: s.p.workflowRunId, stepRunId: current.id, stepId: current.stepId,
    requestId, artifactExecution: frozen, parameters });
  if (!request) throw Error("actual correction request required");
  return request;
}
export type ConsumptionRequest = Awaited<ReturnType<typeof prepareConsumptionRequest>>;

/** Independent C03 fixture bytes define QA digests; the receipt implementation is not an oracle. */
export async function writeConsumptionQaResult(c: C02Case, request: ConsumptionRequest, text = "new") {
  const files = commitBuffers(c.s.mode, text), facts = commitFacts(files);
  const result = { schemaVersion: "workflow.qa-result.v1", ok: true,
    checks: [{ id: "fixture-byte-qa", ok: true }],
    inputDigest: { mode: c.s.mode === "html" ? "html" : "content",
      sha256: facts.find(file => file.role === "main")!.sha256 },
    assetManifest: facts.filter(file => file.role === "asset").map(file => ({
      fileName: path.posix.relative("assets", file.relativePath), sha256: file.sha256, byteSize: file.byteSize })),
    ...(c.s.mode === "html" ? { ancillaryManifest: [{ fileName: "research",
      sha256: facts.find(file => file.relativePath === "source-notes.txt")!.sha256,
      byteSize: files.get("source-notes.txt")!.length }] } : {}) };
  const bytes = Buffer.from(JSON.stringify(result));
  await writeArtifactFile(request.snapshot.root, request.snapshot.artifactExecution.contract.resultFileName, bytes);
  return { result, bytes, facts, files };
}

/** Reader input ONLY: this deliberately bypasses the future atomic completion/proof writer. */
export async function seedConsumptionProof(c: C02Case, request: ConsumptionRequest, receipt: ToolArtifactReceipt) {
  if (receipt.schemaVersion !== "workflow.tool-artifact.v2" || receipt.role !== "qa") throw Error("v2 reader input required");
  const s = request.snapshot, at = new Date(), before = await currentConsumptionStep(c);
  const [completed] = await c.peer.update(workflowStepRuns).set({ status: "completed", completedAt: at,
    metadata: { ...before.metadata, toolArtifactReceipt: receipt } }).where(eq(workflowStepRuns.id, before.id)).returning();
  if (!completed) throw Error("reader input completion missing");
  const proof: QaCorrectionToolConsumptionProof = {
    schemaVersion: "workflow.qa-correction.tool-consumption-proof.v1",
    ref: c.ref, followupEventId: c.followupRow.id,
    request: {
      companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId,
      stepRunId: s.stepRunId, stepId: s.stepId, executionGeneration: s.executionGeneration,
      retryCount: s.retryCount, iterationIndex: s.iterationIndex, requestId: s.requestId,
      outputRoot: s.outputRoot, outputRootHash: s.outputRootHash, input: s.input,
      artifactExecution: s.artifactExecution, qaCorrectionFollowup: c.ref,
    },
    receipt: { ...receipt, role: "qa" }, completedAt: at.toISOString(),
    statusTransitionVersion: completed.statusTransitionVersion,
  };
  const [row] = await c.peer.insert(workflowTransitionEvents).values({
    companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId,
    workflowStepRunId: s.stepRunId, issueId: c.followup.target.issueId, executionGeneration: s.executionGeneration,
    layer: "workflow_validation", eventType: "qa_correction_tool_consumption_proof",
    idempotencyKey: "qa-correction-tool-proof:" + s.requestId, toStatus: "completed",
    // Different counter on purpose: finalizationVersion is NOT the completed step's transition version.
    finalizationVersion: completed.statusTransitionVersion + 17, payload: proof, createdAt: at,
  }).returning();
  if (!row) throw Error("reader input proof missing");
  return { row, proof, completed, lookup: { ref: c.ref, proofEventId: row.id,
    stepRunId: s.stepRunId, requestId: s.requestId, sha256: receipt.sha256 } };
}

/** Actual C03 C issuance followed by a new frozen request, not a forged historical row. */
export async function prepareSuccessorConsumption(b: C02Case) {
  await b.peer.update(workflowStepRuns).set({ status: "failed", lastDispatchRequestId: b.s.request.requestId,
    metadata: { artifactExecution: b.s.request.artifactExecution, toolArtifactRequest: b.s.request } })
    .where(eq(workflowStepRuns.id, b.s.f.qa.id));
  const c = await issueNextC02(b), request = await prepareConsumptionRequest(c);
  return { c, request };
}

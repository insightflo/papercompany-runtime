import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issues, workflowDefinitions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { toolArtifactReceiptSchema, type ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { freezeArtifactAttempt } from "../../services/workflow/artifact-contract-runtime.js";
import { prepareQaArtifactRequest } from "../../services/workflow/qa-artifact-request.js";
import { resolveWorkflowToolStepArgs } from "../../services/workflow/tool-step-args.js";
import { writeArtifactFile } from "../../services/workflow/artifact-writer.js";
import { verifyQaArtifact, type QaCorrectionToolConsumptionProof } from "../../services/workflow/qa-artifact-receipt.js";
import { qaCorrectionConsumptionSchema, qaCorrectionConsumptionKey,
  type QaCorrectionConsumption } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { claimHeartbeatWithRecoveryGuard } from "../../services/heartbeat-recovery-guard.js";
import { insertWorkflowWakeRequest } from "../../services/heartbeat-workflow-wake.js";
import { producerAttemptDetail } from "../../services/work-products/producer-attempt.js";
import { commitDbState } from "../qa-correction-commit-fixture.js";
import { createClaimFixture } from "./c02-claim-race-fixture.js";
import { correctionRows } from "./c02-delivery-fixture.js";
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

/** Isolate quality attachment bytes with the harness, and restore the suite's original environment on close. */
export async function createConsumptionHarness() {
  const owned = await createCommitSourceHarness();
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "consumption-storage"));
  return { ...owned, close: async () => {
    try { await owned.close(); } finally { vi.unstubAllEnvs(); }
  } };
}

export const consumptionTool = { id: "af9d3918-b6c9-4ddd-927f-0a783a22f487", name: "byte-qa-fixture" };
export const consumptionDeployment = [{ fileName: "qa.mjs", sha256: "cd".repeat(32), byteSize: 3 }];

/** Reuse only the existing real request/bytes/verifier/reader-seed assembly; assertions remain in the suite. */
export async function prepareProvedConsumption(owned: Awaited<ReturnType<typeof createCommitSourceHarness>>) {
  const c = await issueC02(owned), request = await prepareConsumptionRequest(c);
  await writeConsumptionQaResult(c, request);
  const { receipt } = await verifyQaArtifact(request, consumptionTool, consumptionDeployment);
  const seed = await seedConsumptionProof(c, request, receipt);
  return { c, request, receipt, seed };
}

export const consumptionState = (c: C02Case) => commitDbState({ ...c.s, db: c.peer });

/** Reader input, deliberately separate from any atomic public verdict/tool completion writer. */
export async function seedV2Consumption(c: C02Case,
  evidence: Extract<QaCorrectionConsumption, { schemaVersion: "workflow.qa-correction.consumption.v2" }>["evidence"],
  actor?: typeof heartbeatRuns.$inferSelect) {
  const t = c.followup.target, at = new Date();
  const consumed = qaCorrectionConsumptionSchema.parse({ schemaVersion: "workflow.qa-correction.consumption.v2",
    ref: c.ref, followupEventId: c.followupRow.id, followup: c.followup, consumedAt: at.toISOString(), evidence });
  const [row] = await c.peer.insert(workflowTransitionEvents).values({
    companyId: c.ref.companyId, missionId: c.s.p.missionId, workflowRunId: c.ref.workflowRunId,
    workflowStepRunId: t.stepRunId, issueId: t.issueId, executionGeneration: t.executionGeneration,
    layer: "workflow_validation", eventType: "qa_correction_followup_consumed",
    idempotencyKey: qaCorrectionConsumptionKey(c.ref.requestId), payload: consumed, createdAt: at,
    heartbeatRunId: actor?.id ?? null, wakeupRequestId: actor?.wakeupRequestId ?? null,
  }).returning();
  if (!row) throw Error("v2 reader input missing");
  return { row, consumed };
}

/** A separately admitted ordinary retry is a valid attempt, but is not this correction's delivery root. */
async function otherConsumptionRoot(c: C02Case, root: typeof heartbeatRuns.$inferSelect) {
  const t = c.followup.target;
  const [wake] = await insertWorkflowWakeRequest(c.peer, {
    companyId: c.ref.companyId, agentId: root.agentId, issueId: t.issueId, missionId: c.s.p.missionId,
    workflowRunId: c.ref.workflowRunId, workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration,
    source: "automation", status: "admitted", requestedByActorType: "system",
    idempotencyKey: "workflow-step-retry:" + t.stepRunId + ":" + t.retryCount, requestKind: "workflow_step_runnable",
  });
  const [queued] = await c.peer.insert(heartbeatRuns).values({
    companyId: root.companyId, agentId: root.agentId, issueId: root.issueId, wakeupRequestId: wake!.id,
    workflowStepRunId: t.stepRunId, workflowExecutionGeneration: t.executionGeneration, status: "queued",
  }).returning();
  if (!queued) throw Error("ordinary retry input missing");
  await c.peer.update(agentWakeupRequests).set({ runId: queued.id }).where(eq(agentWakeupRequests.id, wake!.id));
  const actor = await claimHeartbeatWithRecoveryGuard(c.peer, queued, new Date());
  if (!actor) throw Error("ordinary retry public claim missing");
  return actor;
}

/** Actual delivery, public claims and supported enqueue APIs; no adapter/provider execution is asserted. */
export async function prepareVerdictConsumption(owned: Awaited<ReturnType<typeof createCommitSourceHarness>>,
  kind: "self" | "process_lost_retry" | "adapter_fallback" | "other-root") {
  const fixtures = createClaimFixture(owned, db => db, [], []), w = await fixtures.world(true);
  const queuedRoot = (await correctionRows(w.c)).heartbeats[0]!;
  const root = await claimHeartbeatWithRecoveryGuard(owned.db, queuedRoot, new Date());
  if (!root) throw Error("real delivery public claim missing");
  let actor = root;
  if (kind === "other-root") actor = await otherConsumptionRoot(w.c, root);
  else if (kind !== "self") {
    const queued = await fixtures.retry(w, root, kind);
    const child = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
    if (!child) throw Error("real technical child public claim missing");
    actor = child;
  }
  const c = w.c, t = c.followup.target;
  const detail = await producerAttemptDetail(c.peer, actor, {
    id: t.stepRunId, workflowRunId: c.ref.workflowRunId, stepId: t.stepId, issueId: t.issueId,
    executionGeneration: t.executionGeneration, retryCount: t.retryCount, iterationIndex: t.iterationIndex,
  });
  const [issue] = await c.peer.select().from(issues).where(eq(issues.id, t.issueId));
  if (!issue) throw Error("actual verdict issue missing");
  const result = await recordWorkflowValidationVerdict({ db: c.peer, issue, source: "workflow_api",
    verdict: "pass", heartbeatRunId: actor.id });
  if (!result.satisfied) throw Error("official verdict missing");
  const [verdict] = await c.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.heartbeatRunId, actor.id), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
  if (!verdict) throw Error("official verdict event missing");
  const delivered = (await correctionRows(c)).receipts[0]!;
  const seed = await seedV2Consumption(c, { kind: "workflow_verdict", eventId: verdict.id, deliveryEventId: delivered.id }, actor);
  return { c, root, actor, detail, verdict, ...seed };
}

/** Legacy v1 HTML accepted a nonempty assets root; changing this would be a new admission rule. */
export async function legacyHtmlConsumptionInput(c: C02Case) {
  const step = await currentConsumptionStep(c), receipt = toolArtifactReceiptSchema.parse(step.metadata.toolArtifactReceipt);
  const request = step.metadata.toolArtifactRequest as ConsumptionRequest["snapshot"];
  const input = { ...receipt.input, assetsRoot: "/legacy-html-assets" };
  await c.peer.update(workflowStepRuns).set({ metadata: { ...step.metadata,
    toolArtifactRequest: { ...request, input }, toolArtifactReceipt: { ...receipt, input } } })
    .where(eq(workflowStepRuns.id, step.id));
}

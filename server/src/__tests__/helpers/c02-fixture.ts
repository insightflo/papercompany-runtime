import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, qualityActions, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { hashContract } from "../../services/quality/contract.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../../services/workflow/control-flow/qa-correction-commit.js";
import { parseQaCorrectionEventPayload, qaCorrectionDeliverySchema, qaCorrectionConsumptionSchema,
  qaCorrectionDeliveryKey, qaCorrectionConsumptionKey,
  type QaCorrectionConsumption } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { appendQaVerdict } from "./qa-correction-fixture.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, hideCommitDeclaration,
  makeCommitSource, type CommitSourceCase, type CommitSourceMode } from "../qa-correction-commit-fixture.js";

export { commitBuffers, commitFacts, createCommitSourceHarness };

/** Positive B/C always exercise the accepted C03 writer; expectations come from fixture bytes and peer SQL. */
async function issue(s: CommitSourceCase, peer: Db) {
  const prepared = await beginQaCorrection(s.db, s.p);
  if (prepared.status !== "prepared") throw Error("real C02 preparation required: " + prepared.status);
  s.p = prepared.preparation;
  const measured = await measureQaCorrectionSources(s.db, {
    preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
  const stored = await storeQaCorrection(s.db, measured), result = await commitQaCorrection(s.db, stored);
  if (result.status !== "committed") throw Error("real C02 issuance required: " + result.status);
  const [appliedRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.appliedEventId));
  if (!appliedRow) throw Error("peer cannot see committed application");
  const applied = parseQaCorrectionEventPayload("qa_remediation_applied", appliedRow.payload);
  const [followupRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, applied.followupEventIds[0]!));
  if (!followupRow) throw Error("peer cannot see committed followup");
  const followup = parseQaCorrectionEventPayload("qa_correction_followup_requested", followupRow.payload);
  return { s, peer, stored, appliedRow, applied, followupRow, followup,
    ref: { companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
      appliedEventId: appliedRow.id, requestId: followup.requestId } };
}
export type C02Case = Awaited<ReturnType<typeof issue>>;

export async function issueC02(owned: Awaited<ReturnType<typeof createCommitSourceHarness>>,
  options: { quality?: boolean; legacy?: boolean; mode?: CommitSourceMode } = {}) {
  const s = await makeCommitSource(owned.db, owned.root, options.mode ?? "html", options.legacy, options.quality);
  // Distinguishing nonzero TARGET counters; this is controlled QA input, not stage10 ancestry/claim evidence.
  s.f.qa.retryCount = 1; s.f.qa.iterationIndex = 2;
  for (const v of s.p.authority.verdicts) { v.qa.retryCount = 1; v.qa.iterationIndex = 2; }
  for (const b of s.p.bindings) { b.consumer.retryCount = 1; b.consumer.iterationIndex = 2; }
  s.request.retryCount = 1; s.request.iterationIndex = 2;
  await s.db.update(workflowStepRuns).set({ retryCount: 1, iterationIndex: 2,
    metadata: { artifactExecution: s.request.artifactExecution, toolArtifactRequest: s.request } }).where(eq(workflowStepRuns.id, s.f.qa.id));
  if (options.legacy) await hideCommitDeclaration(s);
  if (s.p.authority.kind === "quality_current_output") {
    const a = s.p.authority, [row] = await s.db.select().from(qualityActions).where(eq(qualityActions.id, a.actionId));
    const retryEnvelope = { ...row!.retryEnvelope, maxExecutorAttempts: 1 };
    a.retryEnvelopeHash = hashContract(retryEnvelope);
    await s.db.update(qualityActions).set({ retryEnvelope }).where(eq(qualityActions.id, a.actionId));
  }
  return issue(s, owned.connect());
}

export async function issueNextC02(previous: C02Case) {
  const { s, peer } = previous, r = previous.stored.revisions[0]!, files = commitBuffers(s.mode, "new");
  const request = structuredClone(s.request);
  request.input.workProductId = r.workProductId; request.input.path = path.join(r.root, r.mainRelativePath);
  request.input.sha256 = commitFacts(files).find(f => f.role === "main")!.sha256;
  request.input.byteSize = files.get("report.html")!.length;
  if (request.input.mode === "html") request.input.htmlManifest = { path: path.join(r.root, "bundle-index.json"),
    sha256: commitFacts(files).find(f => f.relativePath === "bundle-index.json")!.sha256,
    byteSize: files.get("bundle-index.json")!.length };
  else request.input.assetsRoot = r.assetsRelativeRoot === null ? "" : path.join(r.root, r.assetsRelativeRoot!);
  await s.db.update(workflowStepRuns).set({ metadata: { artifactExecution: request.artifactExecution,
    toolArtifactRequest: request } }).where(eq(workflowStepRuns.id, s.f.qa.id));
  const remediations = { items: [{ op: "string_replace" as const, file: request.input.path, find: "new", replace: "final" }] };
  const verdict = await appendQaVerdict(s.db, s.f, "request_changes", remediations), now = new Date();
  await s.db.update(heartbeatRuns).set({ createdAt: now }).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
  await s.db.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
  const p = structuredClone(s.p); p.correctionId = randomUUID(); p.preparedAt = now.toISOString();
  p.authority.verdicts = [verdict];
  p.sources = [{ productId: r.workProductId, provenance: { kind: "prior_correction", appliedEventId: previous.ref.appliedEventId } }];
  p.bindings.forEach(b => { b.expectedProductId = r.workProductId; });
  return issue({ ...s, p, files, text: "new", productId: r.workProductId, file: request.input.path,
    directory: r.root, request }, peer);
}

/**
 * Reader INPUT ONLY: durable schema/relations, deliberately not stage12/13 atomic writers or byte QA.
 * The verdict branch uses the existing official writer; the tool branch seeds a stored receipt.
 */
export async function storeC02ConsumptionInput(c: C02Case, kind: "workflow_verdict" | "tool_qa") {
  const { s, peer, ref, followup, followupRow } = c, t = followup.target, at = new Date();
  const common = { companyId: ref.companyId, missionId: s.p.missionId, workflowRunId: ref.workflowRunId,
    workflowStepRunId: t.stepRunId, issueId: t.issueId, executionGeneration: t.executionGeneration,
    layer: "workflow_validation", createdAt: at };
  let evidence: QaCorrectionConsumption["evidence"], heartbeatRunId: string | null = null, wakeupRequestId: string | null = null;
  if (kind === "workflow_verdict") {
    const [original] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    wakeupRequestId = randomUUID(); heartbeatRunId = randomUUID();
    await peer.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId: ref.companyId, agentId: original!.agentId,
      issueId: t.issueId, missionId: s.p.missionId, workflowRunId: ref.workflowRunId, workflowStepRunId: t.stepRunId,
      workflowExecutionGeneration: t.executionGeneration, source: "workflow.dispatch", status: "admitted",
      payload: { qaCorrectionFollowup: ref } });
    await peer.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: ref.companyId, agentId: original!.agentId,
      issueId: t.issueId, wakeupRequestId, workflowStepRunId: t.stepRunId,
      workflowExecutionGeneration: t.executionGeneration, status: "running", createdAt: at });
    await peer.update(agentWakeupRequests).set({ runId: heartbeatRunId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    const delivery = qaCorrectionDeliverySchema.parse({ schemaVersion: "workflow.qa-correction.delivery.v1",
      ref, followupEventId: followupRow.id, wakeupRequestId, heartbeatRunId, deliveredAt: at.toISOString() });
    const [delivered] = await peer.insert(workflowTransitionEvents).values({ ...common, heartbeatRunId, wakeupRequestId,
      eventType: "qa_correction_followup_delivered", idempotencyKey: qaCorrectionDeliveryKey(ref.requestId), payload: delivery }).returning();
    const [issueRow] = await peer.select().from(issues).where(eq(issues.id, t.issueId));
    await recordWorkflowValidationVerdict({ db: peer, issue: issueRow!, source: "workflow_api",
      verdict: "pass", heartbeatRunId });
    const [verdict] = await peer.update(workflowTransitionEvents).set({ createdAt: at }).where(
      eq(workflowTransitionEvents.idempotencyKey,
        "workflow-validation-verdict:" + ref.companyId + ":" + t.issueId + ":" + t.stepRunId + ":run:" + heartbeatRunId)).returning();
    if (!verdict) throw Error("official verdict input missing");
    evidence = { kind, eventId: verdict.id, deliveryEventId: delivered!.id };
  } else {
    const r = c.stored.revisions[0]!, facts = commitFacts(commitBuffers(s.mode, "new"));
    const request = structuredClone(s.request), requestId = "tool-qa:opaque:" + randomUUID();
    request.requestId = requestId; request.artifactExecution.requestId = requestId;
    request.input.workProductId = r.workProductId; request.input.path = path.join(r.root, r.mainRelativePath);
    request.input.sha256 = facts.find(f => f.role === "main")!.sha256;
    request.input.byteSize = facts.find(f => f.role === "main")!.byteSize;
    request.qaCorrectionFollowup = ref;
    // This branch uses content-only cases; a DB receipt is not evidence of file verification.
    const receipt = toolArtifactReceiptSchema.parse({ schemaVersion: "workflow.tool-artifact.v2", role: "qa",
      companyId: ref.companyId, missionId: s.p.missionId, workflowRunId: ref.workflowRunId,
      stepRunId: t.stepRunId, stepId: t.stepId, executionGeneration: t.executionGeneration,
      retryCount: t.retryCount, iterationIndex: t.iterationIndex, requestId,
      outputRoot: request.outputRoot, outputRootHash: request.outputRootHash, input: request.input,
      relativePath: "qa.json", resultSchema: "workflow.qa-result.v1", sha256: "ab".repeat(32), byteSize: 3,
      toolId: randomUUID(), toolName: "reader-input", toolDeployment: [{ fileName: "qa.mjs", sha256: "cd".repeat(32), byteSize: 3 }],
      contractHash: request.artifactExecution.contractHash, qaConfigHash: request.artifactExecution.qaConfigHash });
    await peer.update(workflowStepRuns).set({ status: "completed", completedAt: at, lastDispatchRequestId: requestId,
      metadata: { artifactExecution: request.artifactExecution, toolArtifactRequest: request, toolArtifactReceipt: receipt } })
      .where(eq(workflowStepRuns.id, t.stepRunId));
    evidence = { kind, stepRunId: t.stepRunId, requestId, sha256: receipt.sha256 };
  }
  const consumed = qaCorrectionConsumptionSchema.parse({ schemaVersion: "workflow.qa-correction.consumption.v1",
    ref, followupEventId: followupRow.id, followup, consumedAt: at.toISOString(), evidence });
  const [row] = await peer.insert(workflowTransitionEvents).values({ ...common, heartbeatRunId, wakeupRequestId,
    eventType: "qa_correction_followup_consumed", idempotencyKey: qaCorrectionConsumptionKey(ref.requestId), payload: consumed }).returning();
  return { row: row!, consumed, heartbeatRunId, wakeupRequestId };
}

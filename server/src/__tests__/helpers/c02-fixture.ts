import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, qualityActions, workflowDefinitions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { hashContract } from "../../services/quality/contract.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { readIssuedQaCorrection } from "../../services/workflow/control-flow/qa-correction-reader.js";
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
  const input = await prepareNextC02Input(previous);
  return issue(input, previous.peer);
}

/** Prepare a fresh QA authority over registered B bytes; issuance remains with the caller. */
export async function prepareNextC02Input(previous: C02Case): Promise<CommitSourceCase> {
  const { s, peer } = previous, prior = await readIssuedQaCorrection(peer, previous.ref);
  if (prior.preparation.authority.kind !== "workflow_qa") throw Error("workflow QA preparation required");
  const revision = prior.applied.revisions[0]!, files = commitBuffers(s.mode, "new"), facts = commitFacts(files);
  if (facts.length !== revision.files.length || facts.some(file => !revision.files.some(stored =>
    stored.relativePath === file.relativePath && stored.role === file.role
      && stored.sha256 === file.sha256 && stored.byteSize === file.byteSize))) {
    throw Error("registered B bytes must match the next correction input");
  }
  const p = structuredClone(prior.preparation), file = path.join(revision.root, revision.mainRelativePath);
  p.correctionId = randomUUID();
  const stepId = "qa-" + p.correctionId;
  const [origin] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
  const [run] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
  if (!origin || !run) throw Error("existing QA origin and workflow run required");
  const [definition] = await peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  if (!definition) throw Error("existing workflow definition required");
  await peer.update(workflowDefinitions).set({ stepsJson: [...definition.stepsJson, {
    id: stepId, name: "QA next correction", type: "agent", agentId: origin.agentId, dependencies: [p.producer.stepId],
    workProductSelectors: { [p.producer.stepId]: { type: "artifact", title: "report" } },
  }] }).where(eq(workflowDefinitions.id, definition.id));
  const [issue] = await peer.insert(issues).values({ companyId: p.companyId, missionId: p.missionId,
    title: "[QA] Next correction", status: "todo", assigneeAgentId: origin.agentId,
    originKind: "workflow_execution", originRunId: p.workflowRunId }).returning();
  if (!issue) throw Error("fresh QA issue required");
  const [qa] = await peer.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId,
    stepId, issueId: issue.id, status: "failed" }).returning();
  if (!qa) throw Error("fresh QA step required");
  const [binding] = await peer.insert(workflowStepOutputBindings).values({ companyId: p.companyId,
    workflowRunId: p.workflowRunId, consumerStepRunId: qa.id, referencedStepId: p.producer.stepId,
    sourceExecutionGeneration: p.producer.executionGeneration, workProductId: revision.workProductId }).returning();
  if (!binding) throw Error("fresh QA binding required");
  const remediations = { items: [{ op: "string_replace" as const, file, find: "new", replace: "final" }] };
  const f = { ...s.f, qa, bindingId: binding.id, remediations, preparation: p };
  const verdict = await appendQaVerdict(peer, f, "request_changes", remediations), now = new Date();
  const [heartbeat] = await peer.update(heartbeatRuns).set({ createdAt: now })
    .where(eq(heartbeatRuns.id, verdict.heartbeatRunId)).returning();
  if (!heartbeat?.wakeupRequestId) throw Error("fresh official QA heartbeat and wake required");
  await peer.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
  await peer.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
  p.preparedAt = now.toISOString();
  p.authority = { kind: "workflow_qa", verdicts: [verdict], toolEvidence: null };
  p.sources = [{ productId: revision.workProductId,
    provenance: { kind: "prior_correction", appliedEventId: previous.ref.appliedEventId } }];
  // Describe the existing B pins without moving them before the caller commits C.
  p.bindings = [...p.bindings.map(existing => ({ ...existing, expectedProductId: revision.workProductId })),
    { bindingId: binding.id, consumer: verdict.qa,
      referencedStepId: p.producer.stepId, expectedProductId: revision.workProductId }];
  return { ...s, p, f: { ...f, verdictHeartbeatId: heartbeat.id, verdictWakeId: heartbeat.wakeupRequestId },
    productId: revision.workProductId, file, directory: revision.root, text: "new", files };
}

/**
 * Reader INPUT ONLY: durable schema/relations, deliberately not stage12/13 atomic writers or byte QA.
 * The verdict branch uses the existing official writer; the tool branch seeds a stored receipt.
 */
type ConsumptionInputCase = Pick<C02Case, "s" | "peer" | "ref" | "followup" | "followupRow">
  & { stored: Pick<C02Case["applied"], "revisions"> };
export async function storeC02ConsumptionInput(c: ConsumptionInputCase, kind: "workflow_verdict" | "tool_qa") {
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
    request.input.assetManifest = facts.filter(f => f.role === "asset").map(f => ({
      fileName: path.posix.relative("assets", f.relativePath), sha256: f.sha256, byteSize: f.byteSize }));
    if (request.input.mode === "html") {
      const manifest = facts.find(f => f.relativePath === "bundle-index.json")!;
      const notes = facts.find(f => f.relativePath === "source-notes.txt")!;
      request.input.htmlManifest = { path: path.join(r.root, manifest.relativePath),
        sha256: manifest.sha256, byteSize: manifest.byteSize };
      // Independent fixture bundle declares source-notes.txt as research; never derive it from a reader.
      request.input.ancillaryManifest = [{ fileName: "research", sha256: notes.sha256, byteSize: notes.byteSize }];
    }
    request.qaCorrectionFollowup = ref;
    // A stored DB receipt is not evidence of file verification.
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

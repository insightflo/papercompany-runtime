import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { issueWorkProducts, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { linkPreparedQaCorrectionUseEvidence } from "../../quality/qa-correction-use-evidence.js";
import { QaCorrectionReadError, readQaCorrectionScope, readQaCorrectionVerdict,
  requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { readQaCorrectionCommitBindings, replaceQaCorrectionCommitBindings } from "./qa-correction-binding.js";
import { assertQaCorrectionCommitCurrent, inspectQaCorrectionCommitCandidate,
  qaCorrectionCommitDetails, rereadQaCorrectionCommitSources } from "./qa-correction-commit-validation.js";
import { assertQaCorrectionEventLinks, qaCorrectionAppliedKey, qaCorrectionAppliedSchema,
  qaCorrectionFollowupKey, qaCorrectionFollowupSchema,
  type QaCorrectionAttempt, type QaCorrectionPreparation } from "./qa-correction-contract.js";
import { withCurrentQaCorrectionPreparation, type BeginQaCorrectionResult } from "./qa-correction-prepare.js";
import { prepareQaCorrectionCommitQualityUse } from "./qa-correction-quality-use.js";
import { readIssuedQaCorrection, type IssuedQaCorrection } from "./qa-correction-reader.js";
import { computeDefectSignature } from "./knowledge-draft-capture.js";
import { remediationIdempotencyKey } from "./qa-remediation-contract.js";
import type { StoredCorrection } from "./qa-correction-storage.js";

type Stop = Extract<BeginQaCorrectionResult,
  { status: "waiting" | "not_applicable" | "requalification_required" }>;
export type CommitQaCorrectionResult =
  | { status: "committed"; appliedEventId: string; proof: IssuedQaCorrection }
  | { status: "existing"; appliedEventId: string; proof: IssuedQaCorrection; authority: "history_only" }
  | { status: "stopped"; result: Stop };

function stopped(result: BeginQaCorrectionResult): CommitQaCorrectionResult {
  if (result.status === "already_applied") return { status: "existing", authority: "history_only",
    appliedEventId: result.appliedEventId, proof: result.proof };
  if (result.status === "waiting" || result.status === "not_applicable"
    || result.status === "requalification_required") return { status: "stopped", result };
  throw new QaCorrectionReadError("record");
}
function eventScope(p: QaCorrectionPreparation, target: QaCorrectionAttempt, at: Date) {
  return { companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
    workflowStepRunId: target.stepRunId, issueId: target.issueId,
    executionGeneration: target.executionGeneration, layer: "workflow_validation", createdAt: at };
}
async function lockedTargets(tx: QaCorrectionDb, p: QaCorrectionPreparation) {
  const { run, mission } = await readQaCorrectionScope(tx, p, true);
  requireQaCorrection(!["completed", "cancelled"].includes(mission.status)
    && !["completed", "cancelled", "aborted", "failed", "timed-out"].includes(run.status ?? ""), "scope");
  const targets: QaCorrectionAttempt[] = [];
  for (const verdict of p.authority.verdicts) {
    const { qa } = await readQaCorrectionVerdict(tx, p, verdict, true);
    const target = { stepRunId: qa.id, stepId: qa.stepId, issueId: qa.issueId!,
      executionGeneration: qa.executionGeneration, retryCount: qa.retryCount, iterationIndex: qa.iterationIndex };
    requireQaCorrection(isDeepStrictEqual(target, verdict.qa), "attempt");
    targets.push(target);
  }
  return targets;
}

/** C03/C12: immutable files first, then one DB-only issuance. This does not dispatch QA. */
export async function commitQaCorrection(db: Db, stored: StoredCorrection): Promise<CommitQaCorrectionResult> {
  requireQaCorrection(!is(db, PgTransaction), "record");
  // inspect performs its strict detached snapshot synchronously, before this first await.
  const inspection = await inspectQaCorrectionCommitCandidate(db, stored);
  if (inspection.status === "stopped") return stopped(inspection.result);
  const validation = inspection.token, d = qaCorrectionCommitDetails(validation), p = d.preparation;
  const handle = { preparationEventId: d.measured.preparationEventId,
    preparationHash: d.measured.preparationHash, preparation: p };
  // Capture even undeclared consumers under the existing locks. A concurrent winner remains
  // an actual already_applied stop, rather than becoming a binding-read exception between stages.
  const observed = await withCurrentQaCorrectionPreparation(db, handle, async tx => {
    await assertQaCorrectionCommitCurrent(tx, validation);
    return { effect: "noop", value: await readQaCorrectionCommitBindings(tx, p) };
  });
  if (observed.status === "stopped") return stopped(observed.result);
  const appliedEventId = randomUUID();
  let quality: Awaited<ReturnType<typeof prepareQaCorrectionCommitQualityUse>> = null;
  try {
    quality = await prepareQaCorrectionCommitQualityUse(validation, appliedEventId);
    await rereadQaCorrectionCommitSources(validation);
    const completed = await withCurrentQaCorrectionPreparation(db, handle, async tx => {
      const targets = await lockedTargets(tx, p);
      await assertQaCorrectionCommitCurrent(tx, validation); // Last new-issuance current check.
      const use = quality ? await linkPreparedQaCorrectionUseEvidence(tx, {
        token: quality.token, expected: quality.binding,
      }) : null;
      const appliedAt = use?.verifiedAt ?? new Date().toISOString(), at = new Date(appliedAt);
      requireQaCorrection(at.getTime() >= Date.parse(d.measured.sourceMeasured.measuredAt), "record");
      for (const revision of d.stored.revisions) {
        // assertCurrent just compared these complete source rows while their locks were held.
        const source = d.current.observation.sources.find(s => s.product.id === revision.sourceProductId)!.product;
        const main = path.join(revision.root, revision.mainRelativePath);
        const inserted = await tx.insert(issueWorkProducts).values({
          id: revision.workProductId, companyId: source.companyId, issueId: source.issueId,
          projectId: source.projectId, type: source.type, title: source.title,
          provider: "local_file", status: "active", url: null, externalId: main,
          metadata: { path: main, qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1",
            appliedEventId, revisionId: revision.revisionId } },
          createdByRunId: null, sourceExecutionGeneration: null, executionWorkspaceId: null,
          runtimeServiceId: null, reviewState: "none", healthStatus: "unknown", summary: null,
          isPrimary: false, createdAt: at, updatedAt: at,
        }).returning({ id: issueWorkProducts.id });
        requireQaCorrection(inserted.length === 1, "source");
        const archived = await tx.update(issueWorkProducts).set({ status: "archived", isPrimary: false, updatedAt: at })
          .where(and(eq(issueWorkProducts.companyId, p.companyId), eq(issueWorkProducts.id, source.id),
            eq(issueWorkProducts.status, "active"))).returning({ id: issueWorkProducts.id });
        requireQaCorrection(archived.length === 1, "source");
        if (source.isPrimary) {
          const promoted = await tx.update(issueWorkProducts).set({ isPrimary: true })
            .where(and(eq(issueWorkProducts.companyId, p.companyId), eq(issueWorkProducts.id, revision.workProductId),
              eq(issueWorkProducts.isPrimary, false))).returning({ id: issueWorkProducts.id });
          requireQaCorrection(promoted.length === 1, "source");
        }
      }
      const bindingChanges = await replaceQaCorrectionCommitBindings(tx, p, observed.value, d.stored.revisions, at);
      const followups = targets.map(target => {
        const selected = p.bindings.filter(b => b.consumer.stepRunId === target.stepRunId).map(b => b.expectedProductId);
        const revisions = selected.length ? d.stored.revisions.filter(r => selected.includes(r.sourceProductId)) : d.stored.revisions;
        return { eventId: randomUUID(), payload: qaCorrectionFollowupSchema.parse({
          schemaVersion: "workflow.qa-correction.followup.v1", requestId: randomUUID(), correctionId: p.correctionId,
          appliedEventId, operation: "recheck", target, dispatchAuthorityVersion: p.dispatchAuthorityVersion,
          revisionIds: revisions.map(r => r.revisionId),
        }) };
      });
      const applied = qaCorrectionAppliedSchema.parse({ schemaVersion: "workflow.qa-correction.applied.v1",
        correctionId: p.correctionId, preparationEventId: handle.preparationEventId, preparationHash: handle.preparationHash,
        sourceMeasuredEventId: d.measured.sourceMeasuredEventId, sourceMeasuredHash: d.measured.sourceMeasuredHash,
        revisions: d.stored.revisions, bindingChanges, qualityUseEvidenceRefId: use?.evidenceRefId ?? null,
        followupEventIds: followups.map(f => f.eventId), appliedAt });
      assertQaCorrectionEventLinks({ preparation: p,
        sourceMeasured: { eventId: d.measured.sourceMeasuredEventId, payload: d.measured.sourceMeasured },
        applied: { eventId: appliedEventId, payload: applied }, followups });
      await tx.insert(workflowTransitionEvents).values({ ...eventScope(p, p.producer, at), id: appliedEventId,
        eventType: "qa_remediation_applied", idempotencyKey: qaCorrectionAppliedKey(p.correctionId), payload: applied });
      for (const f of followups) await tx.insert(workflowTransitionEvents).values({
        ...eventScope(p, f.payload.target, at), id: f.eventId, eventType: "qa_correction_followup_requested",
        idempotencyKey: qaCorrectionFollowupKey(p.correctionId, f.payload.target), payload: f.payload,
      });
      // Preserve legacy structured audit consumers without invoking their in-place file writer.
      for (const [index, verdict] of p.authority.verdicts.entries()) {
        const items = d.current.remediations[index]!.items;
        await tx.insert(workflowTransitionEvents).values({ ...eventScope(p, verdict.qa, at),
          heartbeatRunId: verdict.heartbeatRunId, eventType: "qa_remediation_applied",
          decision: "mechanical_remediation_applied", verdict: "request_changes", reason: "workflow_api",
          reasonCode: "qa_remediation", idempotencyKey: remediationIdempotencyKey(p.companyId, verdict.qa.stepRunId, verdict.eventId),
          payload: { kind: "qa_remediation_applied", outcome: "applied", producerStepId: p.producer.stepId,
            producerStepRunId: p.producer.stepRunId, producerIteration: p.producer.iterationIndex,
            qaStepId: verdict.qa.stepId, sourceVerdictEventId: verdict.eventId, appliedAt, items,
            signatures: items.map(item => computeDefectSignature(item.find, item.replace)) },
        });
      }
      // History checks actual rows, including our use receipt, without consuming new permission.
      const proof = await readIssuedQaCorrection(tx, { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId });
      return { effect: "write", value: { status: "committed", appliedEventId, proof } as const };
    });
    return completed.status === "stopped" ? stopped(completed.result) : completed.value;
  } finally {
    quality?.discard(); // Consumed tokens are never restored, including after transaction rollback.
  }
}

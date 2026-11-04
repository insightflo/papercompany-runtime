import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, heartbeatRuns, issueWorkProducts, issues, missions, qualityActions,
  qualityEvidenceRefs, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { hashContract } from "../services/quality/contract.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { prepareQaRemediationReservation, buildQaRemediationPreparationCandidate } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import {
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation,
  type QaRemediationPreparation, type QaRemediationPreparationScope,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash, type QaRemediationQualityBinding } from "../services/workflow/control-flow/qa-remediation-quality-binding.js";
import { writeQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-writer.js";
import { readQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-reader.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createQaCorrectionTestDb, seedQaCorrection } from "./helpers/qa-correction-fixture.js";

const BEFORE = "old flawed draft\n";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const tempDirs: string[] = [];
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;

interface World {
  companyId: string; missionId: string; runId: string; file: string;
  producer: typeof workflowStepRuns.$inferSelect; qa: typeof workflowStepRuns.$inferSelect;
}

async function seedQualifiedWorld(db: Db): Promise<World> {
  const companyId = randomUUID(), authorId = randomUUID(), verifierId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Quality preparation", issuePrefix: `QP${companyId.slice(0, 8)}` });
  await db.insert(agents).values([{ id: authorId, companyId, name: "Producer" }, { id: verifierId, companyId, name: "Verifier" }]);
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-quality-preparation-")));
  tempDirs.push(dir);
  const file = path.join(dir, "report.md");
  await writeFile(file, BEFORE, "utf8");
  const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, title: "Quality preparation", ownerAgentId: authorId, status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Quality preparation", stepsJson: [
    { id: "produce", name: "Produce", agentId: authorId, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
    { id: "qa-check", name: "QA", agentId: verifierId, dependencies: ["produce"] },
  ] });
  await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  const [producerIssue] = await db.insert(issues).values({ companyId, missionId, title: "Produce", status: "done", originKind: "workflow_execution" }).returning();
  const [qaIssue] = await db.insert(issues).values({ companyId, missionId, title: "[QA] Check", status: "todo", originKind: "workflow_execution" }).returning();
  const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "produce",
    issueId: producerIssue!.id, status: "completed", completedAt: new Date(Date.now() - 2000) }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "qa-check",
    issueId: qaIssue!.id, status: "failed" }).returning();
  const producerHeartbeatId = randomUUID();
  await admittedProducer(db, { companyId, agentId: authorId, issueId: producerIssue!.id,
    stepRunId: producer!.id, heartbeatId: producerHeartbeatId });
  const wakeId = randomUUID(), qaHeartbeatId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId: verifierId,
    source: "workflow.dispatch", workflowStepRunId: qa!.id });
  await db.insert(heartbeatRuns).values({ id: qaHeartbeatId, companyId,
    agentId: verifierId, issueId: qaIssue!.id, wakeupRequestId: wakeId, status: "succeeded" });
  const items = [{ op: "string_replace" as const, file, find: "flawed", replace: "polished" }];
  await recordWorkflowValidationVerdict({ db, issue: qaIssue!, source: "workflow_api", verdict: "request_changes",
    heartbeatRunId: qaHeartbeatId, remediations: { items } });
  await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue!.id, type: "file",
    provider: "local_file", title: "report", status: "active", metadata: { path: file } });
  return { companyId, missionId, runId, file, producer: producer!, qa: qa! };
}

const requestFor = (w: World) => ({ companyId: w.companyId, missionId: w.missionId, workflowRunId: w.runId,
  producerStepRunId: w.producer.id, qaStepRunIds: [w.qa.id] });
const prepRows = async (db: Db, runId: string) => db.select().from(workflowTransitionEvents)
  .where(and(eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, "qa_remediation_prepared")));

function withBinding(base: QaRemediationPreparation, binding: QaRemediationQualityBinding): QaRemediationPreparation {
  return parseQaRemediationPreparation({ ...base, schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, qualityBinding: binding });
}

function scopeFor(p: QaRemediationPreparation, qualityBinding?: QaRemediationPreparationScope["qualityBinding"]): QaRemediationPreparationScope {
  return { companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
    dispatchAuthorityVersion: p.dispatchAuthorityVersion, producer: p.producer,
    verdicts: p.verdicts.map(({ eventId, heartbeatRunId, qa, remediationsHash }) => ({ eventId, heartbeatRunId, qa, remediationsHash })),
    ...(qualityBinding ? { qualityBinding } : {}),
  };
}

describe("Quality preparation transaction writer", () => {
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120_000);
  afterAll(async () => { for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }); await owned?.close(); }, 120_000);

  it("returns an unstored qualification candidate; transaction rollback and exact conflict re-read preserve one v2 row", async () => {
    const w = await seedQualifiedWorld(owned.db);
    const candidate = await owned.db.transaction(tx => buildQaRemediationPreparationCandidate(tx, requestFor(w)));
    expect(candidate.outcome).toBe("candidate");
    if (candidate.outcome !== "candidate") return;
    expect(await prepRows(owned.db, w.runId)).toHaveLength(0);

    const rollback = new Error("intentional isolated rollback");
    await expect(owned.db.transaction(async tx => {
      const saved = await writeQaRemediationPreparation(tx, candidate.preparation, candidate.scope);
      expect(saved.outcome).toBe("prepared");
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await prepRows(owned.db, w.runId)).toHaveLength(0);
    expect(await readFile(w.file, "utf8")).toBe(BEFORE);

    const first = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, candidate.preparation, candidate.scope));
    expect(first.outcome).toBe("prepared");
    if (first.outcome !== "prepared") return;
    const retry = parseQaRemediationPreparation({ ...candidate.preparation,
      preparationId: randomUUID(), preparedAt: new Date(Date.now() + 5000).toISOString() });
    const existing = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, retry, candidate.scope));
    expect(existing.outcome).toBe("existing");
    if (existing.outcome !== "existing") return;
    expect(existing.preparationEventId).toBe(first.preparationEventId);
    expect(existing.preparation).toEqual(first.preparation);
    expect(await prepRows(owned.db, w.runId)).toHaveLength(1);
    expect(await readFile(w.file, "utf8")).toBe(BEFORE);
  });

  it("stores strict v3 identity without issuing use/wake authority and holds conflicting bindings or source/verdict/authority", async () => {
    const fixture = await seedQaCorrection(owned.db, "identity", true);
    const authority = fixture.preparation.authority;
    if (authority.kind !== "quality_current_output") throw new Error("quality fixture did not bind a Quality action");
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, authority.actionId));
    if (!action) throw new Error("quality action fixture missing");
    const file = fixture.remediations.items[0]!.file;
    const base = parseQaRemediationPreparation({
      schemaVersion: "workflow.qa-remediation.prepare.v2", preparationId: randomUUID(),
      companyId: fixture.preparation.companyId, missionId: fixture.preparation.missionId,
      workflowRunId: fixture.preparation.workflowRunId, dispatchAuthorityVersion: fixture.preparation.dispatchAuthorityVersion,
      producer: fixture.preparation.producer,
      verdicts: authority.verdicts.map(v => ({ ...v, items: fixture.remediations.items,
        remediationsHash: hashQaCorrectionPayload(fixture.remediations.items) })),
      files: [{ path: file, beforeSha256: sha("old"), afterSha256: sha("new"), beforeByteSize: 3, afterByteSize: 3 }],
      preparedAt: new Date().toISOString(),
    });
    const binding: QaRemediationQualityBinding = {
      kind: "quality_current_output", actionId: authority.actionId, groupId: authority.groupId,
      policyVersionId: authority.policyVersionId, intentKey: authority.intentKey,
      targetHash: authority.targetHash, effectHash: authority.effectHash, retryEnvelopeHash: authority.retryEnvelopeHash,
      source: authority.source, sourceAttemptHash: hashContract(authority.source), canonicalBinding: action.canonicalBinding as QaRemediationQualityBinding["canonicalBinding"],
      reviewItemId: authority.reviewItemId, verifierRunId: authority.verifierRunId, verifierEpoch: authority.verifierEpoch,
      fileHashes: base.files.map(f => ({ file: f.path, before: sha("old"), after: f.afterSha256 })),
      uploadedEvidence: { provider: "local_disk", objectKey: `quality/${authority.actionId}/evidence.json`,
        contentType: "application/json", byteSize: 128, sha256: sha("uploaded body"), originalFilename: "evidence.json" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const preparation = withBinding(base, binding);
    const scope = scopeFor(preparation, { actionId: binding.actionId, bindingHash: qaRemediationQualityBindingHash(binding) });
    const wakeCount = (await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, preparation.companyId))).length;
    const useCount = (await owned.db.select({ id: qualityEvidenceRefs.id }).from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.companyId, preparation.companyId))).length;

    const stored = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, preparation, scope));
    expect(stored.outcome).toBe("prepared");
    const [row] = await prepRows(owned.db, preparation.workflowRunId);
    expect(row!.payload).toEqual(preparation);
    expect((await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, preparation.companyId))).length).toBe(wakeCount);
    expect((await owned.db.select({ id: qualityEvidenceRefs.id }).from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.companyId, preparation.companyId))).length).toBe(useCount);
    expect((await owned.db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.workflowRunId, preparation.workflowRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_completed")))).length).toBe(0);

    const workflowScope = scopeFor(preparation);
    const workflowRead = await owned.db.transaction(tx => readQaRemediationPreparation(tx as unknown as Db, workflowScope));
    expect(workflowRead.status).toBe("invalid");
    if (workflowRead.status === "invalid") expect(workflowRead.invalidRows[0]!.detail).toContain("quality_binding_scope");
    const workflowWrite = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, preparation, workflowScope));
    expect(workflowWrite).toMatchObject({ outcome: "held", reason: "unresolved_conflict" });
    expect(await prepRows(owned.db, preparation.workflowRunId)).toHaveLength(1);

    await expect(prepareQaRemediationReservation(owned.db, {
      companyId: preparation.companyId, missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
      producerStepRunId: preparation.producer.stepRunId, qaStepRunIds: [preparation.verdicts[0]!.qa.stepRunId],
      qualityActionId: binding.actionId,
    })).rejects.toMatchObject({ reason: "quality_root_required" });

    const variants: QaRemediationPreparation[] = [];
    const otherActionId = randomUUID();
    variants.push(withBinding(base, { ...binding, actionId: otherActionId,
      canonicalBinding: { ...binding.canonicalBinding, actionId: otherActionId } }));
    const changedSource = { ...binding.source, issueId: randomUUID() };
    variants.push(parseQaRemediationPreparation({ ...preparation, preparationId: randomUUID(), producer: { ...preparation.producer, issueId: changedSource.issueId },
      qualityBinding: { ...binding, source: changedSource, sourceAttemptHash: hashContract(changedSource) } }));
    const changedAuthoritySource = { ...binding.source, workflow: { ...binding.source.workflow,
      dispatchAuthorityVersion: preparation.dispatchAuthorityVersion + 1 } };
    variants.push(parseQaRemediationPreparation({ ...preparation, preparationId: randomUUID(), dispatchAuthorityVersion: preparation.dispatchAuthorityVersion + 1,
      qualityBinding: { ...binding, source: changedAuthoritySource, sourceAttemptHash: hashContract(changedAuthoritySource) } }));
    const changedItems = [{ ...fixture.remediations.items[0]!, replace: "different correction" }];
    variants.push(parseQaRemediationPreparation({ ...preparation, preparationId: randomUUID(), verdicts: preparation.verdicts.map(v => ({
      ...v, items: changedItems, remediationsHash: hashQaCorrectionPayload(changedItems),
    })) }));

    for (const variant of variants) {
      const variantBinding = variant.qualityBinding;
      if (!variantBinding) throw new Error("variant lost Quality binding");
      const result = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, variant,
        scopeFor(variant, { actionId: variantBinding.actionId, bindingHash: qaRemediationQualityBindingHash(variantBinding) })));
      expect(result).toMatchObject({ outcome: "held", reason: "unresolved_conflict" });
    }
    expect(await prepRows(owned.db, preparation.workflowRunId)).toHaveLength(1);
  });
});

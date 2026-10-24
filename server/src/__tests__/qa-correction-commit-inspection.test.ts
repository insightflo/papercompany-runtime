import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, assets, heartbeatRuns, issueAttachments, issues, issueWorkProducts,
  missions, qualityActions, workflowDefinitions, workflowRuns, workflowStepOutputBindings,
  workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import * as artifactFiles from "../services/workflow/artifact-files.js";
import * as artifactWriter from "../services/workflow/artifact-writer.js";
import * as sourceBytes from "../services/workflow/control-flow/qa-correction-source-bytes.js";
import * as storage from "../storage/index.js";
import { QaCorrectionReadError } from "../services/workflow/control-flow/qa-correction-authority.js";
import { beginQaCorrection, withCurrentQaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection, type StoredCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { assertQaCorrectionCommitCurrent, inspectQaCorrectionCommitCandidate, qaCorrectionCommitDetails, rereadQaCorrectionCommitSources,
  validateQaCorrectionCommitCandidate, type ValidatedQaCorrectionCandidate } from "../services/workflow/control-flow/qa-correction-commit-validation.js";
import { hashQaCorrectionPayload, qaCorrectionAppliedKey, qaCorrectionFollowupKey,
  type QaCorrectionApplied, type QaCorrectionFollowup } from "../services/workflow/control-flow/qa-correction-contract.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { remediationIdempotencyKey } from "../services/workflow/control-flow/qa-remediation-contract.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { appendQaVerdict, attempt } from "./helpers/qa-correction-fixture.js";
import { commitBuffers, commitDbState, createCommitSourceHarness,
  makeCommitSource, type CommitSourceCase } from "./qa-correction-commit-fixture.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
// C03 adopted return contract: only actual already_applied carries history; errors stay errors.
// Historical tail inserts below are reader INPUT ONLY, never evidence of the future atomic writer.
describe("C03 structured commit candidate inspection", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => { owned = await createCommitSourceHarness(); }, 120000);
  afterAll(async () => { await owned?.close(); }, 120000);
  async function secondQa(s: CommitSourceCase) {
    const p = s.p, [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [hb] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    const [issue] = await owned.db.insert(issues).values({ companyId: p.companyId, missionId: p.missionId,
      title: "[QA] Second", status: "todo", originKind: "workflow_execution" }).returning();
    const [qa] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId,
      stepId: "qa-2", issueId: issue!.id, status: "failed" }).returning();
    await owned.db.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson,
      { id: "qa-2", name: "Second QA", agentId: hb!.agentId, dependencies: ["produce"] }] })
      .where(eq(workflowDefinitions.id, definition!.id));
    const wakeId = randomUUID(), heartbeatId = randomUUID();
    await owned.db.insert(agentWakeupRequests).values({ id: wakeId, companyId: p.companyId,
      agentId: hb!.agentId, source: "workflow.dispatch", workflowStepRunId: qa!.id });
    await owned.db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: p.companyId,
      agentId: hb!.agentId, issueId: issue!.id, wakeupRequestId: wakeId, status: "succeeded" });
    const remediations = { items: [{ op: "string_replace" as const, file: s.file, find: "Draft", replace: "Reviewed" }] };
    await recordWorkflowValidationVerdict({ db: owned.db, issue: issue!, source: "workflow_api",
      verdict: "request_changes", heartbeatRunId: heartbeatId, remediations });
    const [event] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId));
    p.authority.verdicts.push({ eventId: event!.id, heartbeatRunId: heartbeatId,
      qa: attempt(qa!), remediationsHash: hashQaCorrectionPayload(remediations.items) });
  }
  async function stage(quality = false, subset = false) {
    const s = await makeCommitSource(owned.db, owned.root, "content-only", false, quality);
    if (subset) await secondQa(s);
    const prepared = await beginQaCorrection(owned.db, s.p);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw Error("actual preparation required");
    s.p = prepared.preparation;
    const measured = await measureQaCorrectionSources(owned.db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    return { s, stored: await storeQaCorrection(owned.db, measured) };
  }
  async function state(s: CommitSourceCase) {
    const id = s.p.companyId;
    return { ...await commitDbState(s),
      actions: await s.db.select().from(qualityActions).where(eq(qualityActions.companyId, id)).orderBy(qualityActions.id),
      assets: await s.db.select().from(assets).where(eq(assets.companyId, id)).orderBy(assets.id),
      attachments: await s.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, id)).orderBy(issueAttachments.id) };
  }
  async function files(s: CommitSourceCase, stored: StoredCorrection) {
    const names = new Set([s.directory, s.file, ...stored.revisions.flatMap(r =>
      [r.root, ...r.files.map(f => path.join(r.root, f.relativePath))])]);
    return Promise.all([...names].sort().map(async file => {
      const st = await lstat(file);
      return { file, mode: st.mode, dev: st.dev, ino: st.ino, bytes: st.isFile() ? await readFile(file) : null };
    }));
  }
  function noIo() {
    const spies = [vi.spyOn(sourceBytes, "readQaCorrectionSourceBytes"),
      vi.spyOn(artifactFiles, "captureArtifactRoot"), vi.spyOn(artifactFiles, "readArtifactBytes"),
      vi.spyOn(artifactWriter, "createArtifactDirectory"), vi.spyOn(storage, "getStorageService")];
    onTestFinished(() => spies.forEach(spy => spy.mockRestore()));
    return () => { for (const spy of spies) expect(spy).not.toHaveBeenCalled(); };
  }
  async function unchanged(s: CommitSourceCase, stored: StoredCorrection, run: () => Promise<void>) {
    const before = await state(s), bytes = await files(s, stored), assertNoIo = noIo();
    await run(); assertNoIo();
    expect(await state(s)).toEqual(before); expect(await files(s, stored)).toEqual(bytes);
  }
  async function historyTail(tx: Tx, s: CommitSourceCase, stored: StoredCorrection) {
    const p = s.p, appliedId = randomUUID(), followupId = randomUUID();
    const at = new Date(Math.max(Date.now(), Date.parse(stored.sourceMeasured.measuredAt)));
    const applied: QaCorrectionApplied = { schemaVersion: "workflow.qa-correction.applied.v1",
      correctionId: p.correctionId, preparationEventId: stored.preparationEventId, preparationHash: stored.preparationHash,
      sourceMeasuredEventId: stored.sourceMeasuredEventId, sourceMeasuredHash: stored.sourceMeasuredHash,
      revisions: structuredClone(stored.revisions), bindingChanges: p.bindings.map(b => ({
        bindingId: b.bindingId, fromProductId: b.expectedProductId,
        toProductId: stored.revisions.find(r => r.sourceProductId === b.expectedProductId)!.workProductId })),
      qualityUseEvidenceRefId: null, followupEventIds: [followupId], appliedAt: at.toISOString() };
    const followup: QaCorrectionFollowup = { schemaVersion: "workflow.qa-correction.followup.v1", requestId: randomUUID(),
      correctionId: p.correctionId, appliedEventId: appliedId, operation: "recheck", target: p.authority.verdicts[0]!.qa,
      dispatchAuthorityVersion: p.dispatchAuthorityVersion, revisionIds: applied.revisions.map(r => r.revisionId) };
    // Reuse real prepare/measure/store. Insert ONLY the controlled historical tail, no duplicate receipts.
    const common = { companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
      layer: "workflow_validation", createdAt: at };
    await tx.insert(workflowTransitionEvents).values([
      { ...common, id: appliedId, workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId,
        executionGeneration: p.producer.executionGeneration, eventType: "qa_remediation_applied",
        idempotencyKey: qaCorrectionAppliedKey(p.correctionId), payload: applied },
      { ...common, id: followupId, workflowStepRunId: followup.target.stepRunId, issueId: followup.target.issueId,
        executionGeneration: followup.target.executionGeneration, eventType: "qa_correction_followup_requested",
        idempotencyKey: qaCorrectionFollowupKey(p.correctionId, followup.target), payload: followup } ]);
    for (const r of applied.revisions) {
      const file = path.join(r.root, r.mainRelativePath);
      await tx.insert(issueWorkProducts).values({ id: r.workProductId, companyId: p.companyId, issueId: p.producer.issueId,
        type: "artifact", provider: "local_file", title: "report", status: "active", externalId: file,
        metadata: { path: file, qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1",
          appliedEventId: appliedId, revisionId: r.revisionId } }, createdAt: at });
      await tx.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, r.sourceProductId));
    }
    for (const b of applied.bindingChanges) await tx.update(workflowStepOutputBindings)
      .set({ workProductId: b.toProductId, resolvedAt: at }).where(eq(workflowStepOutputBindings.id, b.bindingId));
    const scope = { companyId: p.companyId, workflowRunId: p.workflowRunId, appliedEventId: appliedId };
    return { scope, proof: await readIssuedQaCorrection(tx, scope) };
  }
  it.each(["inspect", "validate"] as const)("preserves the observed history race contract: %s", async mode => {
    const { s, stored } = await stage(), waiter = owned.connect(), observer = owned.connect();
    const before = await state(s), bytes = await files(s, stored);
    const assertNoIo = noIo();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let tail: Awaited<ReturnType<typeof historyTail>> | undefined, baseline: Awaited<ReturnType<typeof state>> | undefined;
    try {
      await owned.db.transaction(async tx => {
        await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, s.p.missionId)).for("no key update");
        const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        const applied = await tx.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, s.p.companyId),
          eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(s.p.correctionId))));
        expect(applied).toEqual([]);
        pending = Promise.allSettled([mode === "inspect" ? inspectQaCorrectionCommitCandidate(waiter, stored)
          : validateQaCorrectionCommitCandidate(waiter, stored)]);
        const deadline = Date.now() + 6000;
        for (;;) {
          const rows = await observer.execute(sql`SELECT query FROM pg_stat_activity WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock' AND ${Number(holder!.pid)} = ANY(pg_blocking_pids(pid))`);
          if (rows.some(row => /from "missions".*for no key update/i.test(String(row.query)))) break;
          if (Date.now() >= deadline) throw Error("actual mission lock wait not observed");
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        // Reaching this real lock proves the initial appliedHistory SELECT returned no row.
        // Nothing writes history until AFTER that observation; no sleeps establish ordering.
        tail = await historyTail(tx, s, stored);
        baseline = await state({ ...s, db: tx as unknown as Db });
      });
      const [settled] = await pending!;
      const history = tail!;
      expect(await readIssuedQaCorrection(owned.db, history.scope)).toEqual(history.proof);
      const expected = { status: "stopped", result: { status: "already_applied", authority: "history_only",
        preparationEventId: stored.preparationEventId, preparationHash: stored.preparationHash,
        preparation: s.p, appliedEventId: history.scope.appliedEventId, proof: history.proof } };
      if (mode === "inspect") expect(settled).toEqual({ status: "fulfilled", value: expected });
      else {
        expect(settled!.status).toBe("rejected");
        if (settled!.status === "rejected") {
          expect(settled!.reason).toBeInstanceOf(QaCorrectionReadError);
          expect(settled!.reason).toMatchObject({ reason: "stale" });
        }
      }
      expect(await inspectQaCorrectionCommitCandidate(owned.db, stored)).toEqual(expected);
      await expect(validateQaCorrectionCommitCandidate(owned.db, stored)).rejects.toMatchObject({ reason: "stale" });
      assertNoIo(); expect(await state(s)).toEqual(baseline); expect(await files(s, stored)).toEqual(bytes);
      expect(baseline!.usage).toEqual(before.usage); expect(baseline!.groups).toEqual(before.groups);
      expect(baseline!.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
      expect(baseline!.events.filter(e => e.eventType === "qa_correction_source_measured")).toHaveLength(1);
    } finally { await pending; }
  }, 20000);
  it.each(["preparation_id", "preparation_hash", "preparation_body", "measurement_id", "measurement_hash", "measurement_body", "measurement_record"] as const)(
    "rejects forged %s before accepting even genuine history", async fault => {
      const { s, stored } = await stage();
      await owned.db.transaction(tx => historyTail(tx, s, stored));
      expect(await inspectQaCorrectionCommitCandidate(owned.db, stored)).toMatchObject({
        status: "stopped", result: { status: "already_applied", authority: "history_only" } });
      await expect(validateQaCorrectionCommitCandidate(owned.db, stored)).rejects.toMatchObject({ reason: "stale" });
      const changed = structuredClone(stored);
      if (fault === "preparation_body") {
        const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, stored.preparationEventId));
        await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, bindings: [] } })
          .where(eq(workflowTransitionEvents.id, stored.preparationEventId));
      }
      if (fault === "measurement_record") await owned.db.update(workflowTransitionEvents)
        .set({ payload: { ...stored.sourceMeasured, measuredAt: new Date(0).toISOString() } })
        .where(eq(workflowTransitionEvents.id, stored.sourceMeasuredEventId));
      if (fault === "preparation_id") changed.preparationEventId = changed.sourceMeasured.preparationEventId = randomUUID();
      if (fault === "preparation_hash") changed.preparationHash = changed.sourceMeasured.preparationHash = "ff".repeat(32);
      if (fault === "measurement_id") changed.sourceMeasuredEventId = randomUUID();
      if (fault === "measurement_body") changed.sourceMeasured.measuredAt = new Date(0).toISOString();
      changed.sourceMeasuredHash = fault === "measurement_hash" ? "ff".repeat(32) : hashQaCorrectionPayload(changed.sourceMeasured);
      await unchanged(s, stored, async () => {
        await expect(inspectQaCorrectionCommitCandidate(owned.db, changed)).rejects.toMatchObject({ reason: "record" });
      });
    }, 20000);
  it.each(["waiting", "not_applicable", "requalification_required"] as const)("preserves the actual %s stop without IO or +1", async status => {
    const { s, stored } = await stage(true, status === "requalification_required"), p = s.p, v = p.authority.verdicts[0]!;
    for (let i = 0; i < (status === "not_applicable" ? 3 : 1); i++) {
      const sourceVerdictEventId = status === "not_applicable" ? randomUUID() : v.eventId;
      await owned.db.insert(workflowTransitionEvents).values({ companyId: p.companyId, missionId: p.missionId,
        workflowRunId: p.workflowRunId, workflowStepRunId: v.qa.stepRunId, issueId: v.qa.issueId, heartbeatRunId: v.heartbeatRunId,
        eventType: "qa_remediation_applied", layer: "workflow_validation", reason: "workflow_api", verdict: "request_changes",
        idempotencyKey: remediationIdempotencyKey(p.companyId, v.qa.stepRunId, sourceVerdictEventId),
        payload: { kind: "qa_remediation_applied", outcome: status === "not_applicable" ? "write_failed" : "applied",
          producerStepId: p.producer.stepId, producerStepRunId: p.producer.stepRunId, producerIteration: p.producer.iterationIndex,
          qaStepId: v.qa.stepId, sourceVerdictEventId, items: s.f.remediations.items, appliedAt: new Date().toISOString() } });
    }
    const result = status === "waiting" ? { status, detail: "all rejected qa verdicts already remediated; awaiting fresh QA verdict" }
      : status === "not_applicable" ? { status, detail: "qa " + v.qa.stepId + " remediation attempt cap exhausted" }
      : { status, reason: "qa_subset_already_applied", remainingVerdicts: p.authority.verdicts.slice(1), appliedQaStepRunIds: [v.qa.stepRunId] };
    const baseline = await state(s);
    expect(baseline.usage[0]!.executionAttempts).toBe(1); expect(baseline.groups[0]!.usage.executionAttempts).toBe(1);
    await unchanged(s, stored, async () => {
      expect(await inspectQaCorrectionCommitCandidate(owned.db, stored)).toEqual({ status: "stopped", result });
      await expect(validateQaCorrectionCommitCandidate(owned.db, stored)).rejects.toMatchObject({ reason: "stale" });
    }); // The existing noop/stop rollback is allowed; no new persistent effects or reservations are.
  }, 20000);
  it("snapshots before the first await and retains real opaque-token getter and reread connections", async () => {
    const { s, stored } = await stage(), before = await state(s), bytes = await files(s, stored);
    expect(await readFile(stored.outputs[0]!.mainPath)).toEqual(commitBuffers("content-only", "new").get("report.html"));
    const input = structuredClone(stored), pending = inspectQaCorrectionCommitCandidate(owned.db, input);
    input.sourceMeasuredEventId = randomUUID(); input.revisions[0]!.root = "/mutated-after-call";
    const result = await pending;
    expect(result.status).toBe("validated");
    if (result.status !== "validated") throw Error("validated token required");
    expect(Object.isFrozen(result.token)).toBe(true);
    expect(qaCorrectionCommitDetails(result.token).stored).toEqual(stored);
    const detached = qaCorrectionCommitDetails(result.token); detached.stored.outputs[0]!.mainPath = "/detached";
    expect(qaCorrectionCommitDetails(result.token).stored).toEqual(stored);
    await rereadQaCorrectionCommitSources(result.token);
    const d = qaCorrectionCommitDetails(result.token);
    const current = await withCurrentQaCorrectionPreparation(owned.db, {
      preparationEventId: d.measured.preparationEventId, preparationHash: d.measured.preparationHash,
      preparation: d.preparation }, async tx => {
      await assertQaCorrectionCommitCurrent(tx, result.token); return { effect: "noop", value: null };
    });
    expect(current.status).toBe("current");
    const wrapperToken = await validateQaCorrectionCommitCandidate(owned.db, stored);
    expect(qaCorrectionCommitDetails(wrapperToken).stored).toEqual(stored);
    for (const forged of [{}, structuredClone(result.token)]) {
      expect(() => qaCorrectionCommitDetails(forged as ValidatedQaCorrectionCandidate)).toThrow("qa_correction_record");
      await expect(rereadQaCorrectionCommitSources(forged as ValidatedQaCorrectionCandidate)).rejects.toMatchObject({ reason: "record" });
    }
    expect(await state(s)).toEqual(before); expect(await files(s, stored)).toEqual(bytes);
  }, 20000);
  it("rejects external transactions before reading candidates or files", async () => {
    const { s, stored } = await stage();
    await unchanged(s, stored, async () => {
      await owned.db.transaction(async tx => {
        await expect(inspectQaCorrectionCommitCandidate(tx as unknown as Db, stored)).rejects.toMatchObject({ reason: "record" });
        await expect(validateQaCorrectionCommitCandidate(tx as unknown as Db, stored)).rejects.toMatchObject({ reason: "record" });
      });
    });
  }, 20000);
  it("propagates current-validation and actual DB errors instead of returning history success", async () => {
    const { s, stored } = await stage();
    await appendQaVerdict(owned.db, s.f, "pass");
    const disconnected = owned.connect(); await disconnected.$client.end();
    await unchanged(s, stored, async () => {
      await expect(inspectQaCorrectionCommitCandidate(owned.db, stored)).rejects.toMatchObject({ reason: "stale" });
      await expect(inspectQaCorrectionCommitCandidate(disconnected, stored)).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
    });
  }, 20000);
});

import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { approvals, assets, issueAttachments, issueWorkProducts, missions, qualityActions, qualityActionGroups,
  qualityPolicyUsage, qualityPolicyVersions, workflowRuns, workflowStepOutputBindings, workflowStepRuns,
  workflowTerminalDecisions, workflowRecoveryAuthorities, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import * as validation from "../services/workflow/control-flow/qa-correction-commit-validation.js";
import * as qualityUse from "../services/workflow/control-flow/qa-correction-quality-use.js";
import * as reader from "../services/workflow/control-flow/qa-correction-reader.js";
import { linkPreparedQaCorrectionUseEvidence } from "../services/quality/qa-correction-use-evidence.js";
import { lockQualityAttemptBudget } from "../services/quality/retry-budget.js";
import { remediationIdempotencyKey } from "../services/workflow/control-flow/qa-remediation-contract.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { commitDbState, commitFileState, createCommitSourceHarness, makeCommitSource, type CommitSourceCase } from "./qa-correction-commit-fixture.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
// C03/C12, adopted plan §8: independent connections, observed lock waits and actual issued rows.
describe("C03 commit races and rollback", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness(); vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "quality-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);
  async function stage(quality = false, extra = false) {
    const s = await makeCommitSource(owned.db, owned.root, "content-only", false, quality);
    await s.db.update(issueWorkProducts).set({ isPrimary: true }).where(eq(issueWorkProducts.id, s.productId));
    if (extra) {
      const [pin] = await s.db.insert(workflowStepOutputBindings).values({ companyId: s.p.companyId,
        workflowRunId: s.p.workflowRunId, consumerStepRunId: s.p.producer.stepRunId,
        referencedStepId: s.p.producer.stepId, workProductId: s.productId }).returning();
      s.p.bindings.push({ bindingId: pin!.id, consumer: s.p.producer,
        referencedStepId: s.p.producer.stepId, expectedProductId: s.productId });
    }
    const p = await beginQaCorrection(s.db, s.p);
    if (p.status !== "prepared") throw Error("actual preparation required");
    s.p = p.preparation;
    const measured = await measureQaCorrectionSources(s.db, { preparationEventId: p.preparationEventId, preparationHash: p.preparationHash });
    return { s, measured, stored: await storeQaCorrection(s.db, measured) };
  }
  async function state(s: CommitSourceCase) {
    const id = s.p.companyId;
    return { ...await commitDbState(s),
      assets: await s.db.select().from(assets).where(eq(assets.companyId, id)).orderBy(assets.id),
      attachments: await s.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, id)).orderBy(issueAttachments.id),
      actions: await s.db.select().from(qualityActions).where(eq(qualityActions.companyId, id)).orderBy(qualityActions.id) };
  }
  async function waits(observer: Db, pid: number, count = 1) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await observer.execute(sql`SELECT query FROM pg_stat_activity WHERE datname = current_database()
        AND state = 'active' AND wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(pid))`);
      if (rows.length >= count) return;
      if (Date.now() >= deadline) throw Error("actual lock wait not observed");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  it("races two separately stored candidates through the real writer, issuing exactly one", async () => {
    const { s, measured, stored } = await stage(true), other = await storeQaCorrection(owned.connect(), measured);
    expect(other.revisions[0]!.workProductId).not.toBe(stored.revisions[0]!.workProductId);
    const before = await state(s), both = gate(), real = validation.rereadQaCorrectionCommitSources;
    let arrived = 0;
    vi.spyOn(validation, "rereadQaCorrectionCommitSources").mockImplementation(async token => {
      await real(token); if (++arrived === 2) both.release(); await both.promise;
    });
    const results = await Promise.all([commitQaCorrection(owned.connect(), stored), commitQaCorrection(owned.connect(), other)]);
    const winner = results.find(r => r.status === "committed"), loser = results.find(r => r.status === "existing");
    expect(winner?.status).toBe("committed"); expect(loser?.status).toBe("existing");
    if (!winner || winner.status !== "committed") throw Error("one real winner required");
    expect(loser).toEqual({ ...winner, status: "existing", authority: "history_only" });
    const after = await state(s);
    expect(after.products).toHaveLength(before.products.length + 1);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(after.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1);
    expect(after.usage).toEqual(before.usage); expect(after.groups).toEqual(before.groups);
  }, 20000);
  it("preserves the winner when the loser already passed its initial historical lookup", async () => {
    const { s, measured, stored } = await stage(), other = await storeQaCorrection(owned.connect(), measured);
    const ready = gate(), release = gate(), real = validation.rereadQaCorrectionCommitSources, observer = owned.connect();
    vi.spyOn(validation, "rereadQaCorrectionCommitSources").mockImplementationOnce(async token => {
      await real(token); ready.release(); await release.promise;
    });
    const first = Promise.allSettled([commitQaCorrection(owned.connect(), stored)]); await ready.promise;
    let second: ReturnType<typeof first.then> | undefined;
    try {
      await owned.db.transaction(async tx => {
        await tx.select().from(missions).where(eq(missions.id, s.p.missionId)).for("no key update");
        const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); release.release();
        await waits(observer, Number(holder!.pid));
        second = Promise.allSettled([commitQaCorrection(owned.connect(), other)]) as never;
        await waits(observer, Number(holder!.pid), 2);
      });
      const [a] = await first, [b] = await (second as unknown as typeof first);
      expect(a.status).toBe("fulfilled"); expect(b.status).toBe("fulfilled");
      if (a.status !== "fulfilled" || b.status !== "fulfilled" || a.value.status !== "committed") throw Error("real issuance required");
      expect(b.value).toEqual({ ...a.value, status: "existing", authority: "history_only" });
      expect((await state(s)).products).toHaveLength(2);
    } finally { release.release(); await first; if (second) await second; }
  }, 20000);
  async function trigger(table: string, operation: string, predicate: string, body = "RAISE EXCEPTION 'c03_injected';") {
    const name = "c03_" + randomUUID().replaceAll("-", "");
    await owned.db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $c03$
      BEGIN IF ${predicate} THEN ${body} END IF; RETURN NEW; END; $c03$`));
    await owned.db.execute(sql.raw(`CREATE TRIGGER ${name} ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    return async () => {
      await owned.db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
      await owned.db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    };
  }
  it.each(["B", "A", "partial_CAS", "use", "applied", "followup", "history"] as const)(
    "rolls back every additional effect after %s failure and permits fresh validation/token retry", async fault => {
      const { s, stored } = await stage(true, true), before = await state(s), bytes = await commitFileState(s);
      const prepared: NonNullable<Awaited<ReturnType<typeof qualityUse.prepareQaCorrectionCommitQualityUse>>>[] = [];
      const realPrepare = qualityUse.prepareQaCorrectionCommitQualityUse;
      vi.spyOn(qualityUse, "prepareQaCorrectionCommitQualityUse").mockImplementation(async (...args) => {
        const token = await realPrepare(...args); if (token) prepared.push(token); return token;
      });
      let remove = async () => {};
      const originalRead = reader.readIssuedQaCorrection;
      const readSpy = fault === "history" ? vi.spyOn(reader, "readIssuedQaCorrection").mockImplementation(async (db, scope) => {
        const proof = await originalRead(db, scope); expect(is(db, PgTransaction)).toBe(true);
        expect(proof.applied.revisions[0]!.workProductId).toBe(stored.revisions[0]!.workProductId);
        throw Error("c03_history_injected");
      }) : null;
      const company = `NEW.company_id = '${s.p.companyId}'::uuid`;
      if (fault === "B") remove = await trigger("issue_work_products", "AFTER INSERT", company);
      if (fault === "A") remove = await trigger("issue_work_products", "AFTER UPDATE", company + " AND NEW.status = 'archived'");
      if (fault === "use") remove = await trigger("quality_evidence_refs", "AFTER INSERT", company);
      if (fault === "applied") remove = await trigger("workflow_transition_events", "AFTER INSERT", company + " AND NEW.idempotency_key LIKE 'qa-correction-applied:%'");
      if (fault === "followup") remove = await trigger("workflow_transition_events", "AFTER INSERT", company + " AND NEW.event_type = 'qa_correction_followup_requested'");
      if (fault === "partial_CAS") remove = await trigger("workflow_step_output_bindings", "BEFORE UPDATE",
        `NEW.id = '${s.p.bindings[1]!.bindingId}'::uuid`,
        `IF NOT EXISTS (SELECT 1 FROM workflow_step_output_bindings WHERE id = '${s.f.bindingId}'::uuid
          AND work_product_id = '${stored.revisions[0]!.workProductId}'::uuid) THEN RAISE EXCEPTION 'first_cas_missing'; END IF; RETURN NULL;`);
      try { await expect(commitQaCorrection(owned.connect(), stored)).rejects.toThrow(); }
      finally { await remove(); readSpy?.mockRestore(); }
      expect(await state(s)).toEqual(before); expect(await commitFileState(s)).toEqual(bytes);
      expect(prepared).toHaveLength(1);
      await owned.db.transaction(async tx => {
        await expect(linkPreparedQaCorrectionUseEvidence(tx, { token: prepared[0]!.token, expected: prepared[0]!.binding }))
          .rejects.toThrow("quality_evidence_token_invalid");
      });
      const retried = await commitQaCorrection(owned.connect(), stored);
      expect(retried.status).toBe("committed"); expect(prepared).toHaveLength(2);
      expect(prepared[1]!.token).not.toBe(prepared[0]!.token);
      expect((await state(s)).usage).toEqual(before.usage); expect((await state(s)).groups).toEqual(before.groups);
    }, 20000);
  async function invalidate(tx: Tx, s: CommitSourceCase, fault: string) {
    const p = s.p, a = p.authority;
    if (a.kind !== "quality_current_output") throw Error("quality authority required");
    if (fault === "cancel") await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, p.missionId));
    if (fault === "terminal") await tx.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, p.workflowRunId));
    if (fault === "authority") await tx.update(workflowRuns).set({ dispatchAuthorityVersion: p.dispatchAuthorityVersion + 1 }).where(eq(workflowRuns.id, p.workflowRunId));
    if (["generation", "retry", "iteration"].includes(fault)) {
      const qa = p.authority.verdicts[0]!.qa;
      await tx.update(workflowStepRuns).set(fault === "generation" ? { executionGeneration: qa.executionGeneration + 1 }
        : fault === "retry" ? { retryCount: qa.retryCount + 1 } : { iterationIndex: qa.iterationIndex + 1 }).where(eq(workflowStepRuns.id, qa.stepRunId));
    }
    if (fault === "binding") await tx.update(workflowStepOutputBindings).set({ referencedStepId: "foreign-reference" }).where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    if (fault === "binding_generation") await tx.update(workflowStepOutputBindings).set({ sourceExecutionGeneration: p.producer.executionGeneration }).where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    if (fault === "binding_time") await tx.execute(sql`UPDATE workflow_step_output_bindings SET resolved_at = resolved_at + interval '1 microsecond' WHERE id = ${s.f.bindingId}`);
    if (fault === "qa") await appendQaVerdict(tx as unknown as Db, s.f, "pass");
    if (fault === "deadline") await tx.update(qualityActionGroups).set({ deadlineAt: new Date(0) }).where(eq(qualityActionGroups.id, a.groupId));
    if (fault === "policy") await tx.update(qualityPolicyVersions).set({ disabledAt: new Date() }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (fault === "budget") await tx.update(qualityPolicyUsage).set({ chargedCostCents: 1000000 }).where(eq(qualityPolicyUsage.companyId, p.companyId));
    if (fault === "quality_cancel") await tx.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, a.actionId));
    if (fault === "replacement") {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
      const [replacement] = await tx.insert(workflowRuns).values({ companyId: p.companyId, missionId: p.missionId,
        workflowId: run!.workflowId, status: "running", triggeredBy: "test" }).returning();
      const [decision] = await tx.insert(workflowTerminalDecisions).values({ companyId: p.companyId,
        workflowRunId: p.workflowRunId, decidedAuthorityVersion: 0, decision: "failed", policyCause: "test", discoveryPath: "test", origin: "test" }).returning();
      const [approval] = await tx.insert(approvals).values({ companyId: p.companyId, type: "replacement", status: "approved", payload: {} }).returning();
      await tx.insert(workflowRecoveryAuthorities).values({ companyId: p.companyId, workflowRunId: p.workflowRunId,
        targetAuthorityVersion: 0, resultingAuthorityVersion: 0, targetDecisionId: decision!.id,
        recoveryKind: "replacement_from_start_v1", requestedBy: "test", ownerDecisionEventId: p.authority.verdicts[0]!.eventId,
        operatorApprovalId: approval!.id, replacementRunId: replacement!.id, requestHash: "ab".repeat(32),
        requestReference: randomUUID(), replacementContract: {} });
    }
  }
  it.each(["cancel", "terminal", "authority", "generation", "retry", "iteration", "binding", "binding_generation",
    "binding_time", "qa", "deadline", "policy", "budget", "quality_cancel", "replacement"])(
    "rechecks %s after outside IO, while competing for the final real locks", async fault => {
      const { s, stored } = await stage(true), ready = gate(), release = gate(), observer = owned.connect();
      const real = validation.rereadQaCorrectionCommitSources;
      vi.spyOn(validation, "rereadQaCorrectionCommitSources").mockImplementationOnce(async token => {
        await real(token); ready.release(); await release.promise;
      });
      const pending = Promise.allSettled([commitQaCorrection(owned.connect(), stored)]); await ready.promise;
      let before: Awaited<ReturnType<typeof state>> | undefined;
      try {
        await owned.db.transaction(async tx => {
          const a = s.p.authority;
          if (a.kind !== "quality_current_output") throw Error("quality fixture");
          await lockQualityAttemptBudget(tx, { companyId: s.p.companyId, actionId: a.actionId, now: new Date() });
          await tx.select().from(missions).where(eq(missions.id, s.p.missionId)).for("no key update");
          await invalidate(tx, s, fault);
          before = await state({ ...s, db: tx as unknown as Db });
          const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          release.release(); await waits(observer, Number(holder!.pid));
        });
        const [result] = await pending;
        expect(result.status).toBe("rejected"); expect(await state(s)).toEqual(before);
      } finally { release.release(); await pending; }
    }, 20000);
  it.each(["waiting", "not_applicable"] as const)("preserves the real %s stop without issuing", async status => {
    const { s, stored } = await stage(), v = s.p.authority.verdicts[0]!;
    for (let i = 0; i < (status === "waiting" ? 1 : 3); i++) {
      const sourceVerdictEventId = status === "waiting" ? v.eventId : randomUUID();
      await s.db.insert(workflowTransitionEvents).values({ companyId: s.p.companyId, missionId: s.p.missionId,
        workflowRunId: s.p.workflowRunId, workflowStepRunId: v.qa.stepRunId, issueId: v.qa.issueId,
        heartbeatRunId: v.heartbeatRunId, eventType: "qa_remediation_applied", layer: "workflow_validation", reason: "workflow_api", verdict: "request_changes",
        idempotencyKey: remediationIdempotencyKey(s.p.companyId, v.qa.stepRunId, sourceVerdictEventId),
        payload: { kind: "qa_remediation_applied", outcome: status === "waiting" ? "applied" : "write_failed",
          producerStepId: s.p.producer.stepId, producerStepRunId: s.p.producer.stepRunId, producerIteration: s.p.producer.iterationIndex,
          qaStepId: v.qa.stepId, sourceVerdictEventId, items: s.f.remediations.items, appliedAt: new Date().toISOString() } });
    }
    const inspected = await validation.inspectQaCorrectionCommitCandidate(s.db, stored), before = await state(s);
    if (inspected.status !== "stopped") throw Error("actual stop required");
    expect(await commitQaCorrection(s.db, stored)).toEqual(inspected); expect(await state(s)).toEqual(before);
  }, 20000);
});

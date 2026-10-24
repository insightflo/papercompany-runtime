import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, issues, missions, qualityActionGroups, qualityActions, qualityEvidenceRefs,
  qualityPolicyUsage, qualityPolicyVersions, workflowDefinitions, workflowRuns, workflowStepOutputBindings,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { readQaCorrectionQuality } from "../services/workflow/control-flow/qa-correction-authority.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { remediationIdempotencyKey } from "../services/workflow/control-flow/qa-remediation-contract.js";
import { hashContract } from "../services/quality/contract.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import {
  appendQaVerdict, attempt, createQaCorrectionTestDb, issueQaCorrectionFixture, seedQaCorrection, type CorrectionFixture,
} from "./helpers/qa-correction-fixture.js";
// Oracle: revision 15 C03/C12. Single reservation, current authority and the existing per-QA cap of 3.
// Fixture paths deliberately have no files. No fixture-inserted prepare substitutes for first issuance.
describe("QA correction prepare issuance", () => {
  let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120000);
  afterAll(async () => { await owned?.close(); }, 120000);
  const quality = (f: CorrectionFixture) => {
    if (f.preparation.authority.kind !== "quality_current_output") throw new Error("quality fixture required");
    return f.preparation.authority;
  };
  const pointer = (r: { preparationEventId: string; preparationHash: string }) =>
    ({ preparationEventId: r.preparationEventId, preparationHash: r.preparationHash });
  async function state(f: CorrectionFixture) {
    const companyId = f.preparation.companyId;
    return {
      events: await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)).orderBy(asc(workflowTransitionEvents.id)),
      usage: await owned.db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, companyId)).orderBy(asc(qualityPolicyUsage.id)),
      groups: await owned.db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, companyId)).orderBy(asc(qualityActionGroups.id)),
      receipts: await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, companyId)).orderBy(asc(qualityEvidenceRefs.id)),
      wakes: await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).orderBy(asc(agentWakeupRequests.id)),
      bindings: await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.companyId, companyId)).orderBy(asc(workflowStepOutputBindings.id)),
    };
  }
  async function prepare(f: CorrectionFixture) {
    const result = await beginQaCorrection(owned.db, f.preparation);
    if (result.status !== "prepared") throw new Error("expected actual first preparation: " + result.status);
    return result;
  }
  async function envelope(f: CorrectionFixture, patch: Record<string, unknown>) {
    const a = quality(f), [row] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, a.actionId));
    const retryEnvelope = { ...row!.retryEnvelope, ...patch };
    await owned.db.update(qualityActions).set({ retryEnvelope }).where(eq(qualityActions.id, a.actionId));
    a.retryEnvelopeHash = hashContract(retryEnvelope);
  }
  async function fresh(f: CorrectionFixture, verdict: "pass" | "request_changes" = "request_changes") {
    const v = await appendQaVerdict(owned.db, f, verdict), at = new Date(), a = f.preparation.authority;
    const heartbeatPatch = a.kind === "quality_current_output" && verdict === "request_changes" ? { createdAt: at, executionEpoch: a.verifierEpoch, workflowStepRunId: v.qa.stepRunId, workflowExecutionGeneration: v.qa.executionGeneration } : { createdAt: at };
    await owned.db.update(heartbeatRuns).set(heartbeatPatch).where(eq(heartbeatRuns.id, v.heartbeatRunId));
    await owned.db.update(workflowTransitionEvents).set({ createdAt: at }).where(eq(workflowTransitionEvents.id, v.eventId));
    if (a.kind === "quality_current_output" && verdict === "request_changes") a.verifierRunId = v.heartbeatRunId; return v;
  }
  async function legacy(f: CorrectionFixture, outcome: "applied" | "write_failed" | "incomplete", same = false, qa = f.qa) {
    const p = f.preparation, v = p.authority.verdicts.find(v => v.qa.stepRunId === qa.id)!;
    const sourceVerdictEventId = same ? v.eventId : randomUUID();
    await owned.db.insert(workflowTransitionEvents).values({ companyId: p.companyId, missionId: p.missionId,
      workflowRunId: p.workflowRunId, workflowStepRunId: qa.id, issueId: qa.issueId, heartbeatRunId: v.heartbeatRunId,
      eventType: "qa_remediation_applied", layer: "workflow_validation", reason: "workflow_api", verdict: "request_changes",
      idempotencyKey: remediationIdempotencyKey(p.companyId, qa.id, sourceVerdictEventId),
      payload: outcome === "incomplete" ? { kind: "qa_remediation_applied", outcome: "applied" } : {
        kind: "qa_remediation_applied", outcome, producerStepId: p.producer.stepId, producerStepRunId: p.producer.stepRunId,
        producerIteration: p.producer.iterationIndex, qaStepId: qa.stepId, sourceVerdictEventId,
        items: f.remediations.items, appliedAt: new Date().toISOString(),
      } });
  }
  async function secondQa(f: CorrectionFixture) {
    const p = f.preparation, [run] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    const [hb] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.verdictHeartbeatId));
    const [issue] = await owned.db.insert(issues).values({ companyId: p.companyId, missionId: p.missionId, title: "[QA] Second", status: "todo", originKind: "workflow_execution" }).returning();
    const [qa] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId, stepId: "qa-2", issueId: issue!.id, status: "failed" }).returning();
    await owned.db.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson,
      { id: "qa-2", name: "QA second", agentId: hb!.agentId, dependencies: ["produce"] }] }).where(eq(workflowDefinitions.id, definition!.id));
    const wakeId = randomUUID(), heartbeatId = randomUUID();
    await owned.db.insert(agentWakeupRequests).values({ id: wakeId, companyId: p.companyId, agentId: hb!.agentId, source: "workflow.dispatch", workflowStepRunId: qa!.id });
    await owned.db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: p.companyId, agentId: hb!.agentId,
      issueId: issue!.id, wakeupRequestId: wakeId, status: "succeeded" });
    await recordWorkflowValidationVerdict({ db: owned.db, issue: issue!, source: "workflow_api", verdict: "request_changes", heartbeatRunId: heartbeatId, remediations: f.remediations });
    const [event] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId));
    p.authority.verdicts.push({ eventId: event!.id, heartbeatRunId: heartbeatId, qa: attempt(qa!), remediationsHash: hashQaCorrectionPayload(f.remediations.items) });
    return qa!;
  }
  it.each(["registered_legacy", "identity", "sealed"] as const)("issues %s before any file read and reserves once", async mode => {
    const f = await seedQaCorrection(owned.db, mode, true), before = await state(f), result = await prepare(f);
    expect(result.preparationEventId).toBe(f.preparation.correctionId);
    expect(result.preparationHash).toBe(hashQaCorrectionPayload(result.preparation));
    const after = await state(f), rows = after.events.filter(e => e.eventType === "qa_correction_prepared");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.preparationEventId, payload: result.preparation, createdAt: new Date(result.preparation.preparedAt) });
    expect(after.usage).toHaveLength(1); expect(after.usage[0]!.executionAttempts).toBe(1);
    expect(after.groups[0]!.usage.executionAttempts).toBe(1);
    expect(after.receipts).toEqual(before.receipts); expect(after.wakes).toEqual(before.wakes); expect(after.bindings).toEqual(before.bindings);
    const resumed = await beginQaCorrection(owned.db, { ...f.preparation, correctionId: randomUUID(), preparedAt: "2000-01-01T00:00:00Z" });
    expect(resumed).toEqual({ ...result, status: "existing" }); expect(await state(f)).toEqual(after);
  });
  it("converges two actual connections while both are observed waiting on DB locks", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true), controller = await owned.db.$client.reserve();
    const observer = await owned.connect().$client.reserve(), clients = [owned.connect(), owned.connect()];
    let jobs: Promise<PromiseSettledResult<Awaited<ReturnType<typeof beginQaCorrection>>>[]> | undefined, held = false;
    try {
      await controller.unsafe("CREATE FUNCTION public.qa_prepare_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73005,1); RETURN NEW; END $$");
      await controller.unsafe("CREATE TRIGGER qa_prepare_test_gate BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_correction_prepared') EXECUTE FUNCTION public.qa_prepare_test_gate()");
      await controller.unsafe("SELECT pg_advisory_lock(73005,1)"); held = true;
      const [holder] = await controller.unsafe("SELECT pg_backend_pid() AS pid");
      jobs = Promise.allSettled(clients.map((db, i) => beginQaCorrection(db, { ...f.preparation,
        correctionId: i ? randomUUID() : f.preparation.correctionId, preparedAt: i ? "2000-01-01T00:00:00Z" : f.preparation.preparedAt })));
      const deadline = Date.now() + 6000;
      for (;;) {
        const rows = await observer.unsafe("SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND datname = current_database()");
        const reachesHolder = (pid: number, seen = new Set<number>()): boolean => {
          if (pid === Number(holder!.pid)) return true;
          if (seen.has(pid)) return false;
          const row = rows.find(r => Number(r.pid) === pid);
          return !!row && (row.blockers as number[]).some(next => reachesHolder(Number(next), new Set(seen).add(pid)));
        };
        const waiting = rows.filter(r => reachesHolder(Number(r.pid)));
        if (waiting.length === 2 && new Set(waiting.map(r => r.pid)).size === 2
          && waiting.some(r => /quality_policy_usage/.test(String(r.query)))
          && waiting.some(r => /workflow_transition_events/.test(String(r.query)))) break;
        if (Date.now() >= deadline) throw new Error("two real DB lock waits not observed");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await controller.unsafe("SELECT pg_advisory_unlock(73005,1)"); held = false;
      const settled = await jobs;
      expect(settled.every(r => r.status === "fulfilled")).toBe(true);
      const results = settled.map(r => { if (r.status === "rejected") throw r.reason; return r.value; });
      expect(results.map(r => r.status).sort()).toEqual(["existing", "prepared"]);
      const [a, b] = results;
      if (!a || !b || !("preparation" in a) || !("preparation" in b)) throw new Error("missing issuance");
      expect(pointer(a)).toEqual(pointer(b)); expect(a.preparation).toEqual(b.preparation);
      const after = await state(f);
      expect(after.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
      expect(after.usage[0]!.executionAttempts).toBe(1); expect(after.groups[0]!.usage.executionAttempts).toBe(1);
    } finally {
      if (held) await controller.unsafe("SELECT pg_advisory_unlock(73005,1)");
      try { await jobs; } finally {
        await controller.unsafe("DROP TRIGGER IF EXISTS qa_prepare_test_gate ON workflow_transition_events");
        await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_prepare_test_gate()");
        controller.release(); observer.release();
      }
    }
  }, 20000);
  it.each(["sources", "bindings"] as const)("rejects changed %s at the same preparation key", async kind => {
    const f = await seedQaCorrection(owned.db, "identity", true); await prepare(f);
    const changed = structuredClone(f.preparation), before = await state(f);
    if (kind === "bindings") changed.bindings = [];
    else {
      const provenance = changed.sources[0]!.provenance;
      if (provenance.kind !== "workflow_producer") throw new Error("identity fixture");
      provenance.workflowProducer.heartbeatRunId = randomUUID();
    }
    await expect(beginQaCorrection(owned.db, changed)).rejects.toMatchObject({ reason: "record" });
    expect(await state(f)).toEqual(before);
  });
  it("resumes its own last slot with +0; a new request and a missing proof still need +1", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true); await envelope(f, { maxExecutorAttempts: 1 });
    const result = await prepare(f), before = await state(f);
    await expect(beginQaCorrection(owned.db, f.preparation)).resolves.toMatchObject({ status: "existing" });
    await expect(readQaCorrectionQuality(owned.db, result.preparation, true, undefined, pointer(result))).resolves.not.toBeNull();
    await expect(readQaCorrectionQuality(owned.db, result.preparation, true)).rejects.toMatchObject({ reason: "budget" });
    const verdict = await fresh(f); f.preparation.authority.verdicts = [verdict]; f.preparation.correctionId = randomUUID();
    await expect(beginQaCorrection(owned.db, f.preparation)).rejects.toMatchObject({ reason: "budget" });
    const after = await state(f);
    expect(after.usage).toEqual(before.usage); expect(after.groups).toEqual(before.groups);
    expect(after.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
  });
  it.each(["id", "hash", "scope", "key", "layer", "generation", "payload", "schema"] as const)("rejects forged self-reservation proof: %s", async kind => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true), r = await prepare(f), proof = pointer(r);
    const p = structuredClone(r.preparation);
    if (kind === "id") proof.preparationEventId = (await prepare(await seedQaCorrection(owned.db, "identity", true))).preparationEventId;
    if (kind === "hash") proof.preparationHash = "ff".repeat(32);
    if (kind === "scope") p.companyId = f.otherCompanyId;
    if (kind === "key") await owned.db.update(workflowTransitionEvents).set({ idempotencyKey: randomUUID() }).where(eq(workflowTransitionEvents.id, r.preparationEventId));
    if (kind === "layer") await owned.db.update(workflowTransitionEvents).set({ layer: "foreign" }).where(eq(workflowTransitionEvents.id, r.preparationEventId));
    if (kind === "generation") await owned.db.update(workflowTransitionEvents).set({ executionGeneration: 99 }).where(eq(workflowTransitionEvents.id, r.preparationEventId));
    if (kind === "payload") await owned.db.update(workflowTransitionEvents).set({ payload: { ...r.preparation, bindings: [] } }).where(eq(workflowTransitionEvents.id, r.preparationEventId));
    if (kind === "schema") await owned.db.update(workflowTransitionEvents).set({ payload: { ...r.preparation, unexpected: true } }).where(eq(workflowTransitionEvents.id, r.preparationEventId));
    const before = await state(f);
    await expect(readQaCorrectionQuality(owned.db, p, true, undefined, proof)).rejects.toMatchObject({ reason: "record" });
    expect(await state(f)).toEqual(before);
  });
  it.each([0, 2])("preserves %i legacy + new prepares = 3, without double-counting producer applied events", async legacyCount => {
    const f = await seedQaCorrection(owned.db);
    if (legacyCount) { await legacy(f, "write_failed", true); await legacy(f, "incomplete"); }
    for (let i = 0; i < 3 - legacyCount; i++) {
      await prepare(f);
      if (i < 2 - legacyCount) { f.preparation.authority.verdicts = [await fresh(f)]; f.preparation.correctionId = randomUUID(); }
    }
    await owned.db.insert(workflowTransitionEvents).values({ companyId: f.preparation.companyId, workflowRunId: f.preparation.workflowRunId,
      workflowStepRunId: f.producer.id, eventType: "qa_remediation_applied", layer: "workflow_validation", payload: {} });
    await expect(beginQaCorrection(owned.db, f.preparation)).resolves.toMatchObject({ status: "existing" });
    f.preparation.authority.verdicts = [await fresh(f)]; f.preparation.correctionId = randomUUID();
    await expect(beginQaCorrection(owned.db, f.preparation)).resolves.toMatchObject({ status: "not_applicable" });
  });
  it.each(["cap", "partial", "all"] as const)("handles every QA and explicitly requalifies the remainder: %s", async kind => {
    const f = await seedQaCorrection(owned.db), qa2 = await secondQa(f);
    if (kind === "cap") for (let i = 0; i < 3; i++) await legacy(f, "write_failed", false, qa2);
    else { await legacy(f, "applied", true); if (kind === "all") await legacy(f, "applied", true, qa2); }
    const before = await state(f), result = await beginQaCorrection(owned.db, f.preparation);
    expect(result.status).toBe(kind === "cap" ? "not_applicable" : kind === "all" ? "waiting" : "requalification_required");
    expect(await state(f)).toEqual(before);
    if (result.status === "requalification_required") {
      expect(result.appliedQaStepRunIds).toEqual([f.qa.id]);
      expect(result.remainingVerdicts.map(v => v.qa.stepRunId)).toEqual([qa2.id]);
      f.preparation.authority.verdicts = result.remainingVerdicts;
      await expect(beginQaCorrection(owned.db, f.preparation)).resolves.toMatchObject({ status: "prepared" });
    }
  });
  it.each(["action", "mission", "run", "issue", "source epoch", "verifier epoch", "generation", "QA generation",
    "disabled", "approval", "activation", "period", "group deadline", "cost", "PASS"] as const)("retains current protection on resume: %s", async kind => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true); await prepare(f);
    const a = quality(f);
    if (kind === "action") await owned.db.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, a.actionId));
    if (kind === "mission") await owned.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.preparation.missionId));
    if (kind === "run") await owned.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, f.preparation.workflowRunId));
    if (kind === "issue") await owned.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.qa.issueId!));
    if (kind === "source epoch" || kind === "verifier epoch") await owned.db.update(heartbeatRuns).set({ executionEpoch: 2 }).where(eq(heartbeatRuns.id, kind === "source epoch" ? f.producerHeartbeatId : f.verdictHeartbeatId));
    if (kind === "generation" || kind === "QA generation") await owned.db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, kind === "generation" ? f.producer.id : f.qa.id));
    if (kind === "disabled") await owned.db.update(qualityPolicyVersions).set({ disabledAt: new Date() }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (kind === "approval") await owned.db.update(qualityPolicyVersions).set({ approvedAt: new Date("2100-01-01T00:00:00Z") }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (kind === "activation") await owned.db.update(qualityPolicyVersions).set({ enabledAt: null }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (kind === "period") {
      const [row] = await owned.db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, a.policyVersionId));
      await owned.db.update(qualityPolicyVersions).set({ definition: { ...row!.definition, periodEnd: new Date(Date.now() - 1000).toISOString() } }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    }
    if (kind === "group deadline") await owned.db.update(qualityActionGroups).set({ deadlineAt: new Date(0) }).where(eq(qualityActionGroups.id, a.groupId));
    if (kind === "cost") await owned.db.update(qualityActionGroups).set({ usage: { executionAttempts: 1, chargedCostCents: 101 } }).where(eq(qualityActionGroups.id, a.groupId));
    if (kind === "PASS") await fresh(f, "pass");
    const before = await state(f);
    await expect(beginQaCorrection(owned.db, f.preparation)).rejects.toThrow(); expect(await state(f)).toEqual(before);
  });
  it.each(["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"])("cannot use caller time %s to bypass a deadline; rolls zero usage back", async preparedAt => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    await envelope(f, { deadlineAt: new Date(Date.now() - 1).toISOString() }); f.preparation.preparedAt = preparedAt;
    const before = await state(f);
    await expect(beginQaCorrection(owned.db, f.preparation)).rejects.toMatchObject({ reason: "quality" });
    expect(await state(f)).toEqual(before); expect(before.usage).toEqual([]);
  });
  it("rolls reservation and all prefix writes back when the actual prepare INSERT fails", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    f.preparation.correctionId = f.preparation.authority.verdicts[0]!.eventId; // Real PK violation after reservation.
    const before = await state(f);
    await expect(beginQaCorrection(owned.db, f.preparation)).rejects.toThrow();
    expect(await state(f)).toEqual(before); expect(before.usage).toEqual([]);
  });
  it("returns only historical proof after application, cancellation and a newer PASS, with no effects", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    // Manual fixture is historical reader INPUT ONLY; actual first-issuance evidence is above.
    const issued = await issueQaCorrectionFixture(owned.db, f); await fresh(f, "pass");
    await owned.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.preparation.missionId));
    await owned.db.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, quality(f).actionId));
    const before = await state(f), result = await beginQaCorrection(owned.db, f.preparation);
    expect(result).toMatchObject({ status: "already_applied", appliedEventId: issued.appliedId, authority: "history_only" });
    expect(await state(f)).toEqual(before); expect(before.usage).toEqual([]);
  });
  it.each(["cap", "waiting"] as const)("rolls even zero-usage materialization back on %s", async kind => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true);
    if (kind === "cap") for (let i = 0; i < 3; i++) await legacy(f, "write_failed");
    else await legacy(f, "applied", true);
    const before = await state(f);
    await expect(beginQaCorrection(owned.db, f.preparation)).resolves.toMatchObject({ status: kind === "cap" ? "not_applicable" : "waiting" });
    expect(await state(f)).toEqual(before); expect(before.usage).toEqual([]);
  });
  it.each(["cancel", "epoch", "generation", "policy"] as const)("rechecks %s after an observed action-lock wait", async kind => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true), before = await state(f);
    const control = await owned.db.$client.reserve(), observer = await owned.connect().$client.reserve();
    let jobs: Promise<PromiseSettledResult<Awaited<ReturnType<typeof beginQaCorrection>>>[]> | undefined;
    try {
      await control.unsafe("BEGIN");
      await control.unsafe("SELECT id FROM quality_actions WHERE id = '" + quality(f).actionId + "' FOR UPDATE");
      const [holder] = await control.unsafe("SELECT pg_backend_pid() AS pid");
      jobs = Promise.allSettled([beginQaCorrection(owned.connect(), f.preparation)]);
      const deadline = Date.now() + 6000;
      while (!(await observer.unsafe("SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND " + Number(holder!.pid) + " = ANY(pg_blocking_pids(pid))")).some(r => /quality_actions/.test(String(r.query)))) {
        if (Date.now() >= deadline) throw new Error("actual action lock wait not observed");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (kind === "cancel") await control.unsafe("UPDATE quality_actions SET cancel_requested_at = clock_timestamp() WHERE id = '" + quality(f).actionId + "'");
      if (kind === "epoch") await control.unsafe("UPDATE heartbeat_runs SET execution_epoch = 2 WHERE id = '" + f.producerHeartbeatId + "'");
      if (kind === "generation") await control.unsafe("UPDATE workflow_step_runs SET execution_generation = 1 WHERE id = '" + f.producer.id + "'");
      if (kind === "policy") await control.unsafe("UPDATE quality_policy_versions SET disabled_at = clock_timestamp() WHERE id = '" + quality(f).policyVersionId + "'");
      await control.unsafe("COMMIT");
      expect((await jobs)[0]!.status).toBe("rejected"); expect(await state(f)).toEqual(before);
    } finally {
      await control.unsafe("ROLLBACK");
      try { await jobs; } finally { control.release(); observer.release(); }
    }
  }, 20000);
  it("strictly rejects unknown input without a write prefix", async () => {
    const f = await seedQaCorrection(owned.db, "registered_legacy", true), before = await state(f);
    await expect(beginQaCorrection(owned.db, { ...f.preparation, unexpected: true })).rejects.toMatchObject({ reason: "record" });
    expect(await state(f)).toEqual(before);
  });
});

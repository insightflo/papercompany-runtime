import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, heartbeatRunEvents, issues, workflowDefinitions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { insertWorkflowWakeRequest } from "../../services/heartbeat-workflow-wake.js";
import { claimHeartbeatWithRecoveryGuard } from "../../services/heartbeat-recovery-guard.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../../services/heartbeat-retry-enqueue.js";
import { withReplacementFirstDelivery } from "../../services/workflow/replacement-first-delivery.js";
import { admitReplacement } from "../../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../../services/workflow/plain-start-claim.js";
import { activatePlanningMissionForWorkflowRun } from "../../services/missions/mission-workflow-lifecycle.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../../services/workflow/control-flow/qa-correction-commit.js";
import { appendQaVerdict } from "./qa-correction-fixture.js";
import { seedReplacement } from "./replacement-scenario.js";
import { createCommitSourceHarness, issueC02, issueNextC02, deliveryInput, deliver, correctionRows } from "./c02-delivery-fixture.js";
import type { C02Case } from "./c02-fixture.js";

type World = { c: C02Case; i: Awaited<ReturnType<typeof deliveryInput>> };
type Harness = Awaited<ReturnType<typeof createCommitSourceHarness>>;

// Real fixture mechanisms live here; adapter interception and execution draining remain in the suite.
export function createClaimFixture(owned: Harness, track: (db: Db) => Db, roots: string[], releases: (() => void)[]) {
  async function world(quality = false, queued = true) {
    const c = await issueC02(owned, { mode: "content-only", quality }), i = await deliveryInput(c);
    track(c.peer);
    await c.peer.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, c.s.f.verdictWakeId));
    await c.peer.update(agents).set({ status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: owned.root, promptTemplate: "Isolated claim" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, i.agentId));
    if (queued) await deliver(c, i);
    return { c, i };
  }
  async function pending(w: World) {
    const { contextSnapshot, ...request } = w.i.request;
    await insertWorkflowWakeRequest(owned.db, { ...request, companyId: w.i.companyId, agentId: w.i.agentId,
      issueId: w.i.issueId, missionId: w.i.missionId, workflowRunId: w.i.workflowRunId,
      workflowStepRunId: w.i.workflowStepRunId, workflowExecutionGeneration: w.i.workflowExecutionGeneration,
      status: "queued", payload: { ...request.payload, issueId: w.i.issueId, _paperclipWakeContext: contextSnapshot } });
  }
  async function replacement() {
    const s = await seedReplacement(owned.db); roots.push(s.tempRoot);
    const target = (await admitReplacement(owned.db, s.input, s.actor)).run;
    expect(await claimPlainWorkflowStart(owned.db, target.id,
      { activateMission: activatePlanningMissionForWorkflowRun } as never)).toBe("started");
    await withReplacementFirstDelivery(owned.db, target.id, async () => {});
    return target.id;
  }
  async function ordinaryDag(w: World) {
    const [definition] = await owned.db.insert(workflowDefinitions).values({ companyId: w.i.companyId, name: "Ordinary nested wake",
      stepsJson: [{ id: "ordinary", name: "Ordinary", type: "agent", agentId: w.i.agentId, dependencies: [] }] }).returning();
    const [run] = await owned.db.insert(workflowRuns).values({ companyId: w.i.companyId, missionId: w.i.missionId,
      workflowId: definition!.id, status: "running", triggeredBy: "test" }).returning();
    const [issue] = await owned.db.insert(issues).values({ companyId: w.i.companyId, missionId: w.i.missionId,
      title: "Ordinary nested issue", status: "todo", assigneeAgentId: w.i.agentId,
      originKind: "workflow_execution", originRunId: run!.id }).returning();
    await owned.db.insert(workflowStepRuns).values({ workflowRunId: run!.id, stepId: "ordinary", issueId: issue!.id, status: "pending" });
    return run!.id;
  }
  async function insertGate<T>(w: World, table: string, condition: string, during: (pid: number) => Promise<T>): Promise<T> {
    const name = "c02_" + randomUUID().replaceAll("-", ""), key = parseInt(name.slice(4, 11), 16);
    const holder = track(owned.connect());
    await holder.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_id='${w.i.companyId}'::uuid AND (${condition}) THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
      RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`));
    try {
      return await holder.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
        const [pid] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        return during(Number(pid!.pid));
      });
    } finally {
      await holder.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`));
    }
  }
  const blockedInsert = (w: World, pid: number) => vi.waitFor(async () => {
    const rows = await w.c.peer.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE '%insert%'`);
    expect(rows.length).toBeGreaterThan(0); return rows;
  }, { timeout: 10000 });
  async function retry(w: World, parent: typeof heartbeatRuns.$inferSelect, kind: string) {
    const [agent] = await owned.db.select().from(agents).where(eq(agents.id, w.i.agentId));
    const deps = { db: owned.db, resolveSessionBeforeForWakeup: async () => {
      const sessions = await w.c.peer.execute(sql`SELECT id FROM agent_task_sessions WHERE agent_id=${w.i.agentId}
        UNION ALL SELECT id FROM mission_sessions WHERE agent_id=${w.i.agentId}`);
      expect(sessions).toEqual([]); return null;
    }, appendRunEvent: async (run: typeof heartbeatRuns.$inferSelect, seq: number, event: { eventType: string; payload?: Record<string, unknown> }) => {
      await owned.db.insert(heartbeatRunEvents).values({ companyId: run.companyId,
        runId: run.id, agentId: run.agentId, seq, ...event });
    } };
    return kind === "adapter_fallback"
      ? enqueueAdapterFallbackRun(deps, parent, agent!, new Date(), { fallbackCommand: "isolated", fallbackReason: "test" })
      : enqueueProcessLossRetry(deps, parent, agent!, new Date(),
        { kind: kind === "adapter_failed_retry" ? "adapter_failed_transient" : "process_lost" });
  }
  async function missingWakeClaim(mode: "root" | "nested") {
    const w = await world(), b = (await correctionRows(w.c)).heartbeats[0]!;
    const parent = (await claimHeartbeatWithRecoveryGuard(owned.db, b, new Date()))!;
    const child = await retry(w, parent, "process_lost_retry");
    expect(child).toMatchObject({ retryOfRunId: parent.id, workflowStepRunId: null, workflowExecutionGeneration: null });
    expect(child.wakeupRequestId).not.toBeNull();
    const [detached] = await owned.db.update(heartbeatRuns).set({ wakeupRequestId: null })
      .where(eq(heartbeatRuns.id, child.id)).returning();
    await issueNextC02(w.c);
    let observed: unknown, claimed: typeof heartbeatRuns.$inferSelect | null | undefined;
    let inside: typeof heartbeatRuns.$inferSelect | undefined;
    const attempt = async (db: Db) => {
      try { claimed = await claimHeartbeatWithRecoveryGuard(db, detached!, new Date()); }
      catch (error) { observed = error; }
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, child.id));
      inside = current;
    };
    if (mode === "nested") {
      const target = await replacement(), rollback = Error("missing wake outer rollback");
      await expect(withReplacementFirstDelivery(owned.db, target, async tx => {
        await attempt(track(tx));
        throw rollback;
      })).rejects.toBe(rollback);
    } else await attempt(owned.db);
    return { w, child, detached: detached!, observed, claimed, inside };
  }
  async function changeOwnerAfterObservation(w: World, b: typeof heartbeatRuns.$inferSelect,
    resume: () => Promise<void>, finish: <T>(operation: Promise<T>) => Promise<T>) {
    const holder = track(owned.connect()), ownerHolder = track(owned.connect());
    let pid = 0, releaseB!: () => void;
    const held = new Promise<void>(resolve => { releaseB = resolve; }); releases.push(releaseB);
    const holding = finish(holder.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, b.id)).for("update");
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`); pid = Number(row!.pid);
      await held;
    }));
    try {
      await vi.waitFor(() => { expect(pid).toBeGreaterThan(0); }, { timeout: 10000 });
      let settled = false;
      const resumed = finish(resume());
      void resumed.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(async () => {
        const rows = await w.c.peer.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND ${pid} = ANY(pg_blocking_pids(pid))
          AND query ILIKE '%heartbeat_runs%'`);
        expect(rows.length).toBeGreaterThan(0);
      }, { timeout: 10000 });
      // Create and commit only AFTER the public claim is observed waiting on B, before its issue lock.
      const owner = await w.c.peer.transaction(async tx => {
        const [created] = await tx.insert(heartbeatRuns).values({ companyId: w.i.companyId, agentId: w.i.agentId,
          issueId: w.i.issueId, status: "running" }).returning();
        await tx.update(issues).set({ executionRunId: created!.id, checkoutRunId: created!.id })
          .where(eq(issues.id, w.i.issueId));
        return created!;
      });
      await ownerHolder.transaction(async tx => {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.id)).for("update");
        releaseB(); await holding;
        // Completion while the NEW owner is still locked distinguishes a late heartbeat-lock regression.
        await vi.waitFor(() => { expect(settled).toBe(true); }, { timeout: 10000 });
        await resumed;
        const [issue] = await w.c.peer.select().from(issues).where(eq(issues.id, w.i.issueId));
        expect(issue).toMatchObject({ executionRunId: owner.id, checkoutRunId: owner.id });
        const [preserved] = await w.c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.id));
        expect(preserved).toEqual(owner);
      });
      return owner;
    } finally { releaseB(); await holding; }
  }
  return { world, pending, replacement, ordinaryDag, insertGate, blockedInsert, retry, missingWakeClaim, changeOwnerAfterObservation };
}

/** C02/C12: a fresh genuine QA authority per correction, with registered prior bytes and public C03 writers. */
export async function issueFollowingC02(previous: C02Case, index: number): Promise<C02Case> {
  const { s, peer } = previous;
  // The preceding call already read and validated this committed issuance before returning it.
  // Reuse that fixture proof here; every newly issued correction is still read back below.
  const prior = { preparation: s.p, applied: previous.applied };
  if (s.mode !== "content-only" || prior.preparation.authority.kind !== "workflow_qa") throw Error("content-only workflow QA required");
  const revision = prior.applied.revisions[0]!, main = revision.files.find(file => file.role === "main")!;
  const file = path.join(revision.root, revision.mainRelativePath), bytes = await readFile(file);
  expect(main.relativePath).toBe(revision.mainRelativePath);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(main.sha256);
  expect(bytes.length).toBe(main.byteSize);
  const text: unknown = JSON.parse(bytes.toString("utf8")).title, token = "history-" + String(index).padStart(3, "0");
  if (typeof text !== "string" || text === token) throw Error("distinct prior content title required");
  const [origin] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
  const p = structuredClone(prior.preparation), stepId = "qa-" + token;
  const [run] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
  const [definition] = await peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  // This unmarked legacy static fixture reads current stepsJson. Preserve every previous definition.
  await peer.update(workflowDefinitions).set({ stepsJson: [...definition!.stepsJson, {
    id: stepId, name: "QA " + token, type: "agent", agentId: origin!.agentId, dependencies: [p.producer.stepId],
    workProductSelectors: { [p.producer.stepId]: { type: "artifact", title: "report" } },
  }] }).where(eq(workflowDefinitions.id, definition!.id));
  const [issue] = await peer.insert(issues).values({ companyId: p.companyId, missionId: p.missionId,
    title: "[QA] " + token, status: "todo", assigneeAgentId: origin!.agentId,
    originKind: "workflow_execution", originRunId: p.workflowRunId }).returning();
  // No declared tool contract, frozen attempt or tool request on this new QA; use the actual row defaults.
  const [qa] = await peer.insert(workflowStepRuns).values({ workflowRunId: p.workflowRunId,
    stepId, issueId: issue!.id, status: "failed" }).returning();
  const [binding] = await peer.insert(workflowStepOutputBindings).values({ companyId: p.companyId,
    workflowRunId: p.workflowRunId, consumerStepRunId: qa!.id, referencedStepId: p.producer.stepId,
    sourceExecutionGeneration: p.producer.executionGeneration, workProductId: revision.workProductId }).returning();
  const remediations = { items: [{ op: "string_replace" as const, file, find: text, replace: token }] };
  const f = { ...s.f, qa: qa!, bindingId: binding!.id, remediations, preparation: p };
  const verdict = await appendQaVerdict(peer, f, "request_changes", remediations), now = new Date();
  const [heartbeat] = await peer.update(heartbeatRuns).set({ createdAt: now })
    .where(eq(heartbeatRuns.id, verdict.heartbeatRunId)).returning();
  await peer.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
  await peer.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, heartbeat!.wakeupRequestId!));
  p.correctionId = randomUUID(); p.preparedAt = now.toISOString();
  p.authority = { kind: "workflow_qa", verdicts: [verdict], toolEvidence: null };
  p.sources = [{ productId: revision.workProductId,
    provenance: { kind: "prior_correction", appliedEventId: previous.ref.appliedEventId } }];
  p.bindings = [{ bindingId: binding!.id, consumer: verdict.qa,
    referencedStepId: p.producer.stepId, expectedProductId: revision.workProductId }];
  const prepared = await beginQaCorrection(s.db, p);
  if (prepared.status !== "prepared") throw Error("real history preparation required: " + prepared.status);
  const measured = await measureQaCorrectionSources(s.db, {
    preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
  const stored = await storeQaCorrection(s.db, measured);
  const result = await commitQaCorrection(s.db, stored);
  if (result.status !== "committed") throw Error("real history issuance required: " + result.status);
  const issued = result.proof;
  const applied = issued.applied, followup = issued.followups[0]!;
  const [appliedRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.appliedEventId));
  const [followupRow] = await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, applied.followupEventIds[0]!));
  if (!appliedRow || !followupRow) throw Error("peer cannot see committed history");
  const output = applied.revisions[0]!;
  expect(JSON.parse(await readFile(path.join(output.root, output.mainRelativePath), "utf8")).title).toBe(token);
  return { ...previous, s: { ...s, p: prepared.preparation, f: { ...f, preparation: prepared.preparation,
    verdictHeartbeatId: heartbeat!.id, verdictWakeId: heartbeat!.wakeupRequestId! },
    productId: revision.workProductId, file, directory: revision.root, text,
    files: new Map([[revision.mainRelativePath, bytes]]) }, stored, appliedRow, applied, followupRow, followup,
    ref: { ...previous.ref, appliedEventId: appliedRow.id, requestId: followup.requestId } };
}

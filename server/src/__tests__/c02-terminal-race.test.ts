import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  heartbeatRuns, issueComments, issues, missionAgentRuntimes, missions, qualityActions, qualityActionGroups,
  qualityPolicyVersions, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTerminalEffectIntents, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { finalizeWorkflowRunState } from "../services/workflow/workflow-run-finalization.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import * as authority from "../services/workflow/control-flow/qa-correction-authority.js";
import * as followupReader from "../services/workflow/control-flow/qa-correction-followup.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { issueC02, issueNextC02, storeC02ConsumptionInput } from "./helpers/c02-fixture.js";
import {
  commitDbState, createCommitSourceHarness, makeCommitSource, type CommitSourceCase,
} from "./qa-correction-commit-fixture.js";

type Snapshot = Awaited<ReturnType<typeof loadWorkflowExecutionContext>>;
const hooks = {
  normalizeRecord: (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
  getDynamicLaunchStepIds: () => undefined,
  buildWorkflowDefinitionExecutionShape: (context: Snapshot) => ({ name: context.definition.name, steps: context.steps }),
};
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
beforeAll(async () => {
  owned = await createCommitSourceHarness();
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "c02-terminal-quality-storage"));
}, 120000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  try { await owned?.close(); } finally { vi.unstubAllEnvs(); }
}, 120000);

async function source() {
  const s = await makeCommitSource(owned.db, owned.root, "content-only");
  const [heartbeat] = await s.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId));
  await s.db.insert(missionAgentRuntimes).values({
    companyId: s.p.companyId, missionId: s.p.missionId, agentId: heartbeat!.agentId,
    adapterType: "process", runtimeKey: s.p.workflowRunId, currentIssueId: s.p.producer.issueId,
    status: "ready", processPid: null,
  });
  return s;
}
async function snapshot(a: Db, s: CommitSourceCase, outcome: "completed" | "failed") {
  await s.db.update(workflowStepRuns).set({ status: outcome }).where(eq(workflowStepRuns.id, s.f.qa.id));
  const context = await loadWorkflowExecutionContext(a, s.p.workflowRunId);
  expect(context.stepRuns.find(step => step.id === s.f.qa.id)?.status).toBe(outcome);
  expect(context.run.status).toBe("running");
  return context;
}
async function prepare(s: CommitSourceCase, applied = false) {
  // The peer restores the actual C03-eligible state AFTER A's successful snapshot.
  await s.db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, s.f.qa.id));
  const p = await beginQaCorrection(s.db, s.p);
  if (p.status !== "prepared") throw Error("actual preparation required: " + p.status);
  s.p = p.preparation;
  if (applied) {
    const measured = await measureQaCorrectionSources(s.db, {
      preparationEventId: p.preparationEventId, preparationHash: p.preparationHash,
    });
    const result = await commitQaCorrection(s.db, await storeQaCorrection(s.db, measured));
    expect(result.status).toBe("committed");
  }
}
async function state(db: Db, s: CommitSourceCase) {
  const id = s.p.companyId;
  const { activities: _audit, ...correction } = await commitDbState({ ...s, db });
  return {
    correction,
    run: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId)),
    steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.p.workflowRunId)).orderBy(workflowStepRuns.id),
    issues: await db.select().from(issues).where(eq(issues.companyId, id)).orderBy(issues.id),
    comments: await db.select().from(issueComments).where(eq(issueComments.companyId, id)).orderBy(issueComments.id),
    missions: await db.select().from(missions).where(eq(missions.companyId, id)).orderBy(missions.id),
    runtimes: await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.companyId, id)).orderBy(missionAgentRuntimes.id),
    decisions: await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, id)),
    effects: await db.select().from(workflowTerminalEffectIntents).where(eq(workflowTerminalEffectIntents.companyId, id)),
  };
}
const finalize = (a: Db, context: Snapshot, enabled: boolean) =>
  finalizeWorkflowRunState(a, context, context.stepRuns, enabled, true, hooks);

// Observe the actual public finalizer waiting on the peer's run lock, without a sleep or mock.
async function behindRunLock(a: Db, peer: Db, observer: Db, context: Snapshot, enabled: boolean) {
  let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof finalize>>>[]> | undefined;
  try {
    await peer.transaction(async tx => {
      await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, context.run.id),
        eq(workflowRuns.companyId, context.run.companyId))).for("update");
      const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pending = Promise.allSettled([finalize(a, context, enabled)]);
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await observer.execute(sql`SELECT pid, query, pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'
          AND wait_event_type = 'Lock' AND ${Number(holder!.pid)} = ANY(pg_blocking_pids(pid))`);
        if (waiting.some(row => /(?:from|update)\s+"?workflow_runs"?/i.test(String(row.query))
          && /(?:for\s+update|^\s*update)/i.test(String(row.query)) && Number(row.pid) !== Number(holder!.pid))) break;
        if (Date.now() >= deadline) throw Error("public finalizer run lock wait not observed");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
  } finally {
    // Await rejection too, so a failed observer never leaves a live finalizer in the fixture.
    if (pending) await pending;
  }
  if (!pending) throw Error("public finalizer was not started");
  const [result] = await pending;
  if (!result) throw Error("missing finalizer result");
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

// C02 rev43 8A oracle: outstanding valid work cannot be destroyed by an older terminal observation.
// This exact group can run against old finalizers and proposed finalizers with identical expectations.
describe("C02 stage8A stale terminal snapshot protection", () => {
  const cases = [false, true].flatMap(enabled => (["completed", "failed"] as const).flatMap(outcome =>
    [false, true].map(applied => ({ enabled, outcome, applied }))));
  it.each(cases)("ON=$enabled outcome=$outcome applied=$applied preserves peer correction", async ({ enabled, outcome, applied }) => {
    const s = await source(), a = owned.connect(), observer = owned.connect();
    const context = await snapshot(a, s, outcome);
    await prepare(s, applied);
    const before = await state(observer, s); // Includes all legitimate peer issuance/status changes.
    const result = await behindRunLock(a, s.db, observer, context, enabled);
    expect(result).toEqual(before.run[0]);
    expect(result.status).toBe("running"); // The DAG child-completion hook requires a terminal return.
    expect(await state(observer, s)).toEqual(before);
    expect(before.decisions).toHaveLength(0);
    expect(before.effects).toHaveLength(0);
    expect(before.runtimes[0]?.status).toBe("ready");
  }, 20000);
});

describe("C02 stage8A normal and cancellation controls", () => {
  const controls = [false, true].flatMap(enabled => (["completed", "failed"] as const).map(outcome => ({ enabled, outcome })));
  it.each(controls)("ON=$enabled outcome=$outcome still finalizes without correction", async ({ enabled, outcome }) => {
    const s = await source(), a = owned.connect(), context = await snapshot(a, s, outcome);
    const before = await state(a, s), result = await finalize(a, context, enabled), after = await state(a, s);
    expect(result.status).toBe(outcome);
    expect(after.decisions).toHaveLength(enabled ? 1 : 0);
    expect(after.effects).toHaveLength(enabled ? 1 : 0);
    expect(after.runtimes[0]?.status).toBe("stopped");
    expect(after.steps.map(step => step.executionGeneration)).toEqual(
      before.steps.map(step => step.executionGeneration + (enabled ? 1 : 0)));
    if (enabled) expect(after.effects[0]?.status).toBe("completed");
  }, 20000);
  it.each([false, true])("ON=%s ignores invalid preparation rows and lost current attempts", async enabled => {
    for (const fault of ["invalid-row", "lost-attempt"] as const) {
      const s = await source(), a = owned.connect(), context = await snapshot(a, s, "failed");
      await prepare(s);
      if (fault === "invalid-row") await s.db.update(workflowTransitionEvents).set({ layer: "untrusted" })
        .where(eq(workflowTransitionEvents.id, s.p.correctionId));
      else await s.db.update(workflowStepRuns).set({ retryCount: s.f.qa.retryCount + 1 })
        .where(eq(workflowStepRuns.id, s.f.qa.id));
      expect((await finalize(a, context, enabled)).status).toBe("failed");
    }
  }, 20000);
  it.each([false, true])("ON=%s preserves a peer cancellation over the stale failure snapshot", async enabled => {
    const s = await source(), a = owned.connect(), context = await snapshot(a, s, "failed");
    await prepare(s);
    await s.db.update(workflowRuns).set({ status: "cancelled", completedAt: new Date() }).where(eq(workflowRuns.id, s.p.workflowRunId));
    const before = await state(a, s), result = await finalize(a, context, enabled), after = await state(a, s);
    expect(result).toEqual(before.run[0]);
    expect(after.run).toEqual(before.run);
    expect(after.steps).toEqual(before.steps);
    expect(after.decisions).toHaveLength(0);
    expect(after.effects).toHaveLength(0);
  }, 20000);
  it.each(["failed", "cancelled"] as const)("explicit %s respects the independent correction gate", async decision => {
    const s = await source();
    await prepare(s);
    const result = await finalizeRunTerminal(owned.connect(), {
      companyId: s.p.companyId, runId: s.p.workflowRunId, expectedAuthorityVersion: 0, decision,
      cause: { policy: decision === "cancelled" ? "operator_cancel" : "outcome_convergence",
        discovery: "engine_recompute", origin: "dag_engine" },
      gatePolicy: "immediate", now: new Date(), stepRuns: [],
    });
    expect(result.kind).toBe(decision === "cancelled" ? "finalized" : "deferred");
    expect(result.run.status).toBe(decision === "cancelled" ? "cancelled" : "running");
  }, 20000);
});

// These are DB-relation reader inputs, NOT stage13 consumption-writer/QA execution evidence.
describe("C02 stage8A relation inputs and failure classification", () => {
  async function liveness(s: CommitSourceCase) {
    const { readQaCorrectionLiveness } = await import("../services/workflow/control-flow/qa-correction-liveness.js");
    return owned.connect().transaction(async tx => {
      const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, s.p.workflowRunId),
        eq(workflowRuns.companyId, s.p.companyId))).for("update");
      if (!run) throw Error("locked run missing");
      return readQaCorrectionLiveness(tx, run);
    });
  }
  it("keeps current B open after a fresh PASS without rechecking A rejection", async () => {
    const b = await issueC02(owned, { mode: "content-only" });
    await appendQaVerdict(b.peer, b.s.f, "pass");
    expect(await liveness(b.s)).toMatchObject({ kind: "open", requestId: b.ref.requestId });
  }, 20000);
  it("distinguishes actual B→C and releases only the current consumed C input", async () => {
    const b = await issueC02(owned, { mode: "content-only" }), c = await issueNextC02(b);
    expect(await liveness(c.s)).toMatchObject({ kind: "open", requestId: c.ref.requestId });
    await storeC02ConsumptionInput(c, "workflow_verdict");
    expect(await liveness(c.s)).toEqual({ kind: "clear" });
  }, 20000);
  it("continues past consumed B to another valid preparation", async () => {
    const b = await issueC02(owned, { mode: "content-only" });
    await storeC02ConsumptionInput(b, "tool_qa");
    expect(await liveness(b.s)).toEqual({ kind: "clear" });
    const r = b.stored.revisions[0]!, now = new Date();
    const verdict = await appendQaVerdict(b.peer, b.s.f, "request_changes", {
      items: [{ op: "string_replace", file: path.join(r.root, r.mainRelativePath), find: "new", replace: "final" }],
    });
    await b.peer.update(heartbeatRuns).set({ createdAt: now }).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
    await b.peer.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
    const p = structuredClone(b.s.p);
    p.correctionId = randomUUID(); p.preparedAt = now.toISOString(); p.authority.verdicts = [verdict];
    p.sources = [{ productId: r.workProductId, provenance: { kind: "prior_correction", appliedEventId: b.ref.appliedEventId } }];
    p.bindings.forEach(binding => { binding.expectedProductId = r.workProductId; });
    const prepared = await beginQaCorrection(b.peer, p);
    expect(prepared.status).toBe("prepared");
    expect(await liveness(b.s)).toEqual({ kind: "open", correctionId: p.correctionId });
  }, 20000);
  it.each(["none", "cancel", "policy", "deadline", "cost"] as const)("reuses last quality slot and keeps current limits: %s", async fault => {
    const c = await issueC02(owned, { mode: "content-only", quality: true }), a = c.s.p.authority;
    if (a.kind !== "quality_current_output") throw Error("quality fixture required");
    if (fault === "cancel") await c.peer.update(qualityActions).set({ cancelRequestedAt: new Date() }).where(eq(qualityActions.id, a.actionId));
    if (fault === "policy") await c.peer.update(qualityPolicyVersions).set({ disabledAt: new Date() }).where(eq(qualityPolicyVersions.id, a.policyVersionId));
    if (fault === "deadline") await c.peer.update(qualityActionGroups).set({ deadlineAt: new Date() }).where(eq(qualityActionGroups.id, a.groupId));
    if (fault === "cost") {
      const [group] = await c.peer.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, a.groupId));
      await c.peer.update(qualityActionGroups).set({ usage: { ...group!.usage, chargedCostCents: 101 } })
        .where(eq(qualityActionGroups.id, a.groupId));
    }
    const before = await state(c.peer, c.s);
    expect((await liveness(c.s)).kind).toBe(fault === "none" ? "open" : "clear");
    expect(await state(c.peer, c.s)).toEqual(before);
  }, 20000);
  const malformed = [false, true].flatMap(enabled =>
    (["schema", "relation", "receipt"] as const).map(fault => ({ enabled, fault })));
  it.each(malformed)("ON=$enabled holds malformed consumption $fault input as unknown", async ({ enabled, fault }) => {
    const c = await issueC02(owned, { mode: "content-only" }), input = await storeC02ConsumptionInput(c, "tool_qa");
    if (fault === "schema") await c.peer.update(workflowTransitionEvents).set({ payload: {} })
      .where(eq(workflowTransitionEvents.id, input.row.id));
    if (fault === "relation") await c.peer.update(workflowTransitionEvents).set({
      payload: { ...input.consumed, followupEventId: c.appliedRow.id },
    }).where(eq(workflowTransitionEvents.id, input.row.id));
    if (fault === "receipt") {
      const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
      await c.peer.update(workflowStepRuns).set({ metadata: { ...step!.metadata, toolArtifactReceipt: {} } })
        .where(eq(workflowStepRuns.id, step!.id));
    }
    const before = await state(c.peer, c.s);
    expect((await liveness(c.s)).kind).toBe("unknown");
    expect((await finalize(owned.connect(), await loadWorkflowExecutionContext(c.peer, c.ref.workflowRunId), enabled)).status).toBe("running");
    expect(await state(c.peer, c.s)).toEqual(before);
  }, 20000);
  it.each(["other-409", "database", "future-reason"] as const)("does not swallow injected reader failure %s", async fault => {
    const s = await source();
    await prepare(s);
    const error = fault === "other-409" ? new HttpError(409, "unrelated_conflict")
      : fault === "future-reason" ? new followupReader.QaCorrectionFollowupReadError("future_reason") : Error("database read failure");
    vi.spyOn(authority, "validateQaCorrectionAuthority").mockRejectedValueOnce(error);
    expect(await liveness(s)).toEqual({ kind: "unknown", error: error.message });
  }, 20000);
});

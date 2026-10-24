// @vitest-environment node
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import * as authority from "../services/workflow/control-flow/qa-correction-authority.js";
import {
  applyLinkedWorkflowRunFinalization, reloadWorkflowRunForFinalization,
} from "../services/workflow/workflow-child-native-finalization.js";
import {
  addCascadeTargets, confirmCurrent, createHarness, finalizeChild, linkedGate, linkCorrectionRun,
  liveness, makeCase, modes, observe, scope, settle, state, terminalSnapshot,
  type Case, type Harness, type Mode, type Phase,
} from "./helpers/c02-cascade-child-liveness-fixture.js";

let owned: Harness;
beforeAll(async () => {
  owned = await createHarness();
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "c02-cascade-child-storage"));
}, 120000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  try { await owned?.close(); } finally { vi.unstubAllEnvs(); }
}, 120000);

const phases = ["prepared", "applied", "unknown"] as const;
function unknownReader(c: Case) {
  if (c.phase !== "unknown") return undefined;
  // Only an unexpected authority READ fails; the DB, locks and finalization writers remain real.
  return vi.spyOn(authority, "validateQaCorrectionAuthority")
    .mockRejectedValue(Error("C02 stage8B authority read unavailable"));
}
async function expectProtected(db: Db, c: Case) {
  const live = await liveness(db, c);
  if (c.phase === "unknown") expect(live).toMatchObject({ kind: "unknown" });
  else expect(live).toMatchObject({
    kind: "open", correctionId: c.s.p.correctionId,
    ...(c.requestId ? { requestId: c.requestId } : {}),
  });
}
type LinkedGate = Awaited<ReturnType<typeof linkedGate>>;
function apply(db: Db, c: Case, gate: LinkedGate, nextStatus: string, now = new Date()) {
  return applyLinkedWorkflowRunFinalization(db, {
    bound: gate.bound, companyId: c.s.p.companyId, nextStatus, boundWhere: gate.boundWhere,
    patch: { startedAt: now, completedAt: nextStatus === "running" ? null : now },
  });
}

// C02 adopted oracle: valid unfinished correction precedes success/failure; explicit cancel wins.
// Run these SAME groups against the input HEAD and candidate. Expectations never depend on the guard.
describe("C02 stage8B before-after cascade correction protection", () => {
  const cases = modes.flatMap(mode => phases.map(phase => ({ mode, phase })));
  it.each(cases)("$mode $phase: no additional writes after peer issuance", async ({ mode, phase }) => {
    const c = await makeCase(owned, phase), a = owned.worker, observer = owned.observer;
    await addCascadeTargets(c, mode.startsWith("hold"));
    unknownReader(c);
    await expectProtected(a, c);
    // Issuance can change counters/metadata: only fresh FULL observations may enter the cascade.
    const observed = await observe(a, scope(c), mode);
    await confirmCurrent(a, observed, mode);
    const before = await state(observer, c);
    const result = await settle(a, observed, mode);
    expect(result?.action).toBe(mode.startsWith("stuck") ? "deferred" : "skipped");
    expect(result?.reason).not.toContain("observation changed");
    expect(await state(observer, c)).toEqual(before);
    expect(before.runtimes[0]?.status).toBe("ready");
    expect(before.decisions).toHaveLength(0);
    expect(before.effects).toHaveLength(0);
  }, 20000);
  it.each(["stuck-on", "stuck-off"] as Mode[])("%s protects even with no pending prefix", async mode => {
    const c = await makeCase(owned, "prepared"), a = owned.worker, observed = await observe(a, scope(c), mode);
    expect(observed.pending).toHaveLength(0);
    await confirmCurrent(a, observed, mode);
    const before = await state(owned.observer, c);
    expect((await settle(a, observed, mode))?.action).toBe("deferred");
    expect(await state(owned.observer, c)).toEqual(before);
  }, 20000);
});

describe("C12 stage8B cascade preservation controls", () => {
  it.each(modes)("%s without correction keeps normal ON/OFF and partial-hold behavior", async mode => {
    const c = await makeCase(owned, "none"), a = owned.worker, hold = mode.startsWith("hold");
    const enabled = mode.endsWith("-on"), stuck = mode.startsWith("stuck");
    await addCascadeTargets(c, hold);
    expect(await liveness(a, c)).toEqual({ kind: "clear" });
    const observed = await observe(a, scope(c), mode);
    await confirmCurrent(a, observed, mode);
    const before = await state(owned.observer, c), result = await settle(a, observed, mode);
    const after = await state(owned.observer, c), run = after.runs.find(r => r.id === c.s.p.workflowRunId)!;
    if (hold) expect(result).toBeNull();
    else expect(result?.action).toBe("recovered");
    expect(run.status).toBe(hold ? "running" : "failed");
    expect(run.dispatchAuthorityVersion).toBe(
      before.runs.find(row => row.id === c.s.p.workflowRunId)!.dispatchAuthorityVersion,
    );
    expect(after.decisions).toHaveLength(enabled && !hold ? 1 : 0);
    expect(after.effects).toHaveLength(enabled && !hold ? 1 : 0);
    if (enabled && !hold) expect(after.effects[0]?.status).toBe("completed");
    expect(after.runtimes[0]?.status).toBe(enabled && !hold ? "stopped" : "ready");
    for (const selected of observed.selected) {
      const step = after.steps.find(row => row.id === selected.id)!;
      expect(step.status).toBe("skipped");
      expect(step.metadata).toMatchObject({ keep: "after",
        [stuck ? "failureCascadeSkipped" : "controlFlowSkipped"]: true });
    }
    for (const step of after.steps) {
      const prior = before.steps.find(row => row.id === step.id)!;
      expect(step.executionGeneration).toBe(prior.executionGeneration + (enabled && !hold ? 1 : 0));
    }
    const newTransitions = after.correction.events.filter(row => row.eventType === "workflow_step_status_transition"
      && !before.correction.events.some(old => old.id === row.id));
    expect(newTransitions).toHaveLength(observed.selected.length);
    expect(after.comments.length - before.comments.length).toBe(stuck ? 0 : 1);
    const targetIssue = after.issues.find(row => row.id === observed.selected[0]!.issueId)!;
    expect(targetIssue.status).toBe(stuck ? "todo" : "blocked");
    if (hold) expect(after.steps.find(row => row.stepId === "held")?.status).toBe("pending");
  }, 20000);

  const classifications = (["stuck-on", "deadlock-on"] as Mode[]).flatMap(mode =>
    (["authority", "terminal"] as const).map(fault => ({ mode, fault })));
  it.each(classifications)("$mode preserves finalizer-owned $fault classification", async ({ mode, fault }) => {
    const c = await makeCase(owned, "prepared"), a = owned.worker;
    await addCascadeTargets(c, false);
    const observed = await observe(a, scope(c), mode);
    await c.s.db.update(workflowRuns).set(fault === "authority"
      ? { dispatchAuthorityVersion: 1 } : { status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, c.s.p.workflowRunId));
    const spy = vi.spyOn(authority, "validateQaCorrectionAuthority").mockRejectedValue(Error("must not classify correction"));
    const before = await state(owned.observer, c), result = await settle(a, observed, mode);
    expect(result?.action).toBe("skipped");
    expect(result?.reason).toMatch(fault === "authority" ? /authority superseded/i : /already terminal/i);
    expect(spy).not.toHaveBeenCalled();
    expect(await state(owned.observer, c)).toEqual(before);
  }, 20000);
});

describe("C02 stage8B before-after linked-child correction protection", () => {
  const cases = phases.flatMap(phase => (["completed", "failed"] as const).map(outcome => ({ phase, outcome })));
  it.each(cases)("$phase blocks $outcome and the real caller returns a non-terminal row", async ({ phase, outcome }) => {
    const c = await makeCase(owned, phase), a = owned.worker, observer = owned.observer;
    const identity = await linkCorrectionRun(c), context = await terminalSnapshot(a, c, outcome);
    unknownReader(c);
    await expectProtected(a, c);
    const gate = await linkedGate(a, c, outcome), before = await state(observer, c);
    expect(gate.bound.childRunId).toBe(c.s.p.workflowRunId);
    expect(gate.bound.invocationId).toBe(identity.invocationId);
    expect(await apply(a, c, gate, outcome)).toEqual({ outcome: "no-op" });
    expect(await state(observer, c)).toEqual(before);
    const durable = await reloadWorkflowRunForFinalization(a, {
      runId: c.s.p.workflowRunId, companyId: c.s.p.companyId,
    });
    expect(durable).toEqual(before.runs.find(run => run.id === c.s.p.workflowRunId));
    expect(durable.status).toBe("running");
    expect(durable.childStartMaterializedAt).not.toBeNull();
    expect(before.invocations[0]?.generation).toBe(1);

    // workflow-run-finalization's actual no-op reload feeds DAG's terminal-only completion hook.
    expect(await finalizeChild(a, context)).toEqual(durable);
    const afterCaller = await state(observer, c);
    const extraAudit = afterCaller.correction.activities.filter(row =>
      !before.correction.activities.some(old => old.id === row.id));
    expect(extraAudit.map(row => row.action)).toEqual(outcome === "completed" ? ["workflow_run.finalization_refused"] : []);
    expect({ ...afterCaller, correction: { ...afterCaller.correction,
      activities: before.correction.activities } }).toEqual(before);
  }, 20000);
});

describe("C12 stage8B linked-child preservation controls", () => {
  const controls: { phase: Phase; next: string }[] = [
    ...["completed", "failed", "running", "cancelled"].map(next => ({ phase: "none" as const, next })),
    ...phases.flatMap(phase => ["running", "cancelled"].map(next => ({ phase, next }))),
  ];
  it.each(controls)("$phase still permits $next and preserves receipt/generations", async ({ phase, next }) => {
    const c = await makeCase(owned, phase), a = owned.worker;
    await linkCorrectionRun(c);
    const spy = unknownReader(c);
    if (phase === "none") expect(await liveness(a, c)).toEqual({ kind: "clear" });
    else await expectProtected(a, c);
    spy?.mockClear();
    const gate = await linkedGate(a, c, next), before = await state(owned.observer, c), now = new Date();
    const result = await apply(a, c, gate, next, now), after = await state(owned.observer, c);
    expect(result.outcome).toBe("updated");
    if (spy) expect(spy).not.toHaveBeenCalled(); // running/cancel bypass correction uncertainty.
    const prior = before.runs.find(run => run.id === c.s.p.workflowRunId)!;
    expect(after.runs.find(run => run.id === prior.id)).toEqual({
      ...prior, status: next, startedAt: prior.startedAt ?? now, completedAt: next === "running" ? null : now,
      childStartToken: null, childStartLeaseExpiresAt: null,
    });
    expect(after.steps).toEqual(before.steps);
    expect(after.invocations).toEqual(before.invocations);
    expect(after.correction).toEqual(before.correction);
    expect(after.runtimes).toEqual(before.runtimes);
    expect(after.decisions).toHaveLength(0);
    expect(after.effects).toHaveLength(0);
  }, 20000);

  it.each(["receipt", "target", "terminal"] as const)("%s is rechecked before reading correction", async fault => {
    const c = await makeCase(owned, "prepared"), a = owned.worker;
    await linkCorrectionRun(c);
    const gate = await linkedGate(a, c, "completed");
    if (fault === "receipt") await c.s.db.update(workflowRuns).set({ childStartMaterializedAt: null })
      .where(eq(workflowRuns.id, c.s.p.workflowRunId));
    if (fault === "target") {
      const [other] = await c.s.db.insert(workflowDefinitions).values({
        companyId: c.s.p.companyId, name: "Different retained target", stepsJson: [],
      }).returning();
      await c.s.db.update(workflowRuns).set({ workflowId: other!.id }).where(eq(workflowRuns.id, c.s.p.workflowRunId));
    }
    if (fault === "terminal") await c.s.db.update(workflowRuns).set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowRuns.id, c.s.p.workflowRunId));
    const spy = vi.spyOn(authority, "validateQaCorrectionAuthority").mockRejectedValue(Error("must not bypass boundWhere"));
    const before = await state(owned.observer, c);
    expect(await apply(a, c, gate, "completed")).toEqual({ outcome: "no-op" });
    expect(spy).not.toHaveBeenCalled();
    expect(await state(owned.observer, c)).toEqual(before);
  }, 20000);
});

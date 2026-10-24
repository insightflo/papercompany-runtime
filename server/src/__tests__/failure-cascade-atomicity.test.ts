import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import { evaluateRecoveryChannels, finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { lockCascadeObservation, writeDeadlockCascade, writeStuckCascade } from "../services/workflow/failure-cascade-writes.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { retryMetadata } from "./helpers/run-terminal-boundary-fixture.js";
import { seedQaCorrection } from "./helpers/qa-correction-fixture.js";
import {
  cascadeState, createCascadeHarness, enabled, errorMessages, insertUnblock, isStuck,
  modes, observe, seedCascade, settle, snapshot, staleReason, terminalInput, trigger, waitForSkipLock,
  type Mode,
} from "./helpers/failure-cascade-atomicity-fixture.js";

const terminalModes = modes.filter(mode => !mode.startsWith("hold"));
const onModes: Mode[] = ["stuck-on", "deadlock-on"];
// C04 revision1 is the oracle: deferred/stale means zero cascade writes, including
// nested terminal writes. Expected state comes from another PG connection, not a writer.
describe("C04B atomic failure cascade", () => {
  let owned: Awaited<ReturnType<typeof createCascadeHarness>>;
  beforeAll(async () => { owned = await createCascadeHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  it.each(modes)("%s rejects completion by the real closeout writer without a run authority bump", async mode => {
    const world = await seedCascade(owned.db, mode.startsWith("hold"));
    // Closeout needs a linked pending issue, including the selected step in hold.
    const target = mode.startsWith("hold") ? "held" : "after";
    const observed = await observe(owned.db, world, mode);
    const completed = await completeLinkedWorkflowStepRunsForIssue({
      db: owned.peer, issueId: world.issueIdsByStep[target]!, completedAt: new Date(),
    });
    expect(completed).toEqual([world.stepRunIdsByStep[target]]);
    const before = await snapshot(owned.peer, world);
    expect(before.run.dispatchAuthorityVersion).toBe(observed.run.dispatchAuthorityVersion);
    expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped", reason: staleReason });
    expect(await snapshot(owned.peer, world)).toEqual(before);
  });

  it.each(modes.flatMap(mode => ["retry", "raw-null", "missing", "extra"].map(change => ({ mode, change }))))(
    "$mode rejects $change observation loss", async ({ mode, change }) => {
      const world = await seedCascade(owned.db, mode.startsWith("hold"));
      if (change === "raw-null") await owned.db.update(workflowStepRuns).set({ metadata: sql`'null'::jsonb` })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.after!));
      const observed = await observe(owned.db, world, mode);
      if (change === "raw-null") expect(
        observed.steps.find(step => step.stepId === "after")?.metadata,
      ).toBeNull();
      if (change === "retry" || change === "raw-null") await owned.peer.update(workflowStepRuns)
        .set({ metadata: change === "retry" ? retryMetadata("waiting", 1, 3, new Date(Date.now() + 3600000).toISOString()) : {} })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.after!));
      if (change === "missing") await owned.peer.delete(workflowStepRuns).where(eq(workflowStepRuns.id, world.stepRunIdsByStep.after!));
      if (change === "extra") await owned.peer.insert(workflowStepRuns).values({ workflowRunId: world.runId, stepId: "extra", status: "pending" });
      const before = await snapshot(owned.peer, world);
      expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped", reason: staleReason });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    });

  it.each(modes.flatMap(mode => ["cancelled", "pending", "authority", "mission", "mission-from-null", "company"].map(change => ({ mode, change }))))(
    "$mode yields without a prefix after $change", async ({ mode, change }) => {
      const world = await seedCascade(owned.db, mode.startsWith("hold"));
      if (change === "mission-from-null") await owned.db.update(workflowRuns).set({ missionId: null }).where(eq(workflowRuns.id, world.runId));
      const observed = await observe(owned.db, world, mode);
      if (change === "company") observed.run = { ...observed.run, companyId: randomUUID() };
      else await owned.peer.update(workflowRuns).set(change === "authority" ? { dispatchAuthorityVersion: 1 }
        : change === "mission" ? { missionId: null } : change === "mission-from-null" ? { missionId: world.missionId }
        : { status: change }).where(eq(workflowRuns.id, world.runId));
      const before = await snapshot(owned.peer, world);
      expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped" });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    });

  it.each(modes.filter(mode => !isStuck(mode)))("%s checks failed predecessors and dispatch-ready presence", async mode => {
    for (const change of ["status", "ready", "omitted"] as const) {
      const world = await seedCascade(owned.db, mode.startsWith("hold")), observed = await observe(owned.db, world, mode);
      if (change === "omitted") Reflect.deleteProperty(observed.steps.find(step => step.stepId === "upstream")!, "dispatchReadyAt");
      else await owned.peer.update(workflowStepRuns).set(change === "status" ? { status: "completed" } : { dispatchReadyAt: new Date() })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.upstream!));
      const before = await snapshot(owned.peer, world);
      expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped", reason: staleReason });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    }
  });

  it.each(modes)("%s rejects duplicate targets and contradictory arrays", async mode => {
    for (const change of ["duplicate", "contradiction"] as const) {
      const world = await seedCascade(owned.db, mode.startsWith("hold")), observed = await observe(owned.db, world, mode);
      const selected = isStuck(mode) ? observed.pending : observed.selected;
      const altered = change === "duplicate" ? [...selected, selected[0]!] : [{ ...selected[0]!, metadata: { contradictory: true } }, ...selected.slice(1)];
      if (isStuck(mode)) observed.pending = altered; else observed.selected = altered;
      const before = await snapshot(owned.peer, world);
      expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped", reason: staleReason });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    }
  });

  it.each(modes.filter(mode => mode !== "stuck-off"))("%s rejects duplicate or incomplete full observations", async mode => {
    for (const change of ["duplicate", "missing"] as const) {
      const world = await seedCascade(owned.db, mode.startsWith("hold")), observed = await observe(owned.db, world, mode);
      observed.steps = change === "duplicate" ? [...observed.steps, observed.steps[0]!] : observed.steps.slice(1);
      const before = await snapshot(owned.peer, world);
      expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "skipped", reason: staleReason });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    }
  });

  it("stuck OFF's empty boundary is no full observation, but a new running step invalidates it", async () => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, "stuck-off");
    await owned.peer.insert(workflowStepRuns).values({ workflowRunId: world.runId, stepId: "active", status: "running" });
    const before = await snapshot(owned.peer, world);
    expect(await settle(owned.db, observed, "stuck-off")).toMatchObject({ action: "skipped", reason: staleReason });
    expect(await snapshot(owned.peer, world)).toEqual(before);
  });

  it.each(["hold-on", "hold-off"] as Mode[])("%s keeps a valid mixed hold and rejects inconsistent mayFinalize", async mode => {
    const world = await seedCascade(owned.db, true), observed = await observe(owned.db, world, mode);
    const before = await snapshot(owned.peer, world);
    expect(await settle(owned.db, observed, mode)).toBeNull();
    const after = await snapshot(owned.peer, world);
    expect(after.run).toEqual(before.run);
    expect(after.steps.find(step => step.stepId === "held")).toEqual(before.steps.find(step => step.stepId === "held"));
    expect(after.steps.find(step => step.stepId === "after")).toMatchObject({ status: "skipped", metadata: { keep: "original", controlFlowSkipped: true } });
    expect(after.transitions).toHaveLength(1);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.effects).toEqual(before.effects);
    const inconsistent = await observe(owned.db, world, mode);
    inconsistent.selected = [];
    expect(await settle(owned.db, inconsistent, "deadlock-on")).toMatchObject({ action: "skipped", reason: staleReason });
    expect(await snapshot(owned.peer, world)).toEqual(after);
    const fresh = await observe(owned.db, world, mode);
    fresh.selected = fresh.pending;
    expect(await settle(owned.db, fresh, mode)).toMatchObject({ action: "skipped", reason: staleReason });
    expect(await snapshot(owned.peer, world)).toEqual(after);
  });

  it.each(modes)("%s accepts matching null mission observations", async mode => {
    const world = await seedCascade(owned.db, mode.startsWith("hold"));
    await owned.db.update(workflowRuns).set({ missionId: null }).where(eq(workflowRuns.id, world.runId));
    const result = await settle(owned.db, await observe(owned.db, world, mode), mode);
    if (mode.startsWith("hold")) expect(result).toBeNull();
    else expect(result).toMatchObject({ action: "recovered" });
  });

  it.each(onModes)("%s rolls back an open recovery result", async mode => {
    const world = await seedCascade(owned.db);
    await owned.db.update(workflowStepRuns).set({ metadata: retryMetadata("waiting", 1, 3, new Date(Date.now() + 3600000).toISOString()) })
      .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.upstream!));
    const observed = await observe(owned.db, world, mode), before = await snapshot(owned.peer, world);
    expect(await settle(owned.db, observed, mode)).toMatchObject({ action: isStuck(mode) ? "deferred" : "skipped" });
    expect(await snapshot(owned.peer, world)).toEqual(before);
  });

  it.each(onModes)("%s also rolls back a real correction-liveness deferred result", async mode => {
    const f = await seedQaCorrection(owned.db), p = f.preparation;
    expect((await beginQaCorrection(owned.db, p)).status).toBe("prepared");
    const scope = { companyId: p.companyId, runId: p.workflowRunId };
    await owned.db.insert(workflowStepRuns).values({ workflowRunId: scope.runId, stepId: "downstream", status: "pending" });
    const observed = await observe(owned.db, scope, mode), before = await snapshot(owned.peer, scope);
    expect((await evaluateRecoveryChannels(owned.peer, {
      runId: scope.runId, companyId: scope.companyId, missionId: p.missionId, stepRuns: observed.steps, now: new Date(),
    })).kind).toBe("clear");
    expect(await settle(owned.db, observed, mode)).toMatchObject({ action: isStuck(mode) ? "deferred" : "skipped" });
    expect(await snapshot(owned.peer, scope)).toEqual(before);
  });

  it.each(onModes)("%s cancels real nested run/generation/decision/effect writes after outer throw", async mode => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, mode);
    const before = await snapshot(owned.peer, world);
    await expect(owned.db.transaction(async tx => {
      expect(await lockCascadeObservation(tx, isStuck(mode)
        ? { kind: "stuck", run: observed.run, pendingSteps: observed.pending, boundaryStepRuns: observed.steps, boundaryEnabled: true }
        : { kind: "deadlock", run: observed.run, stepsToSkip: observed.selected, runSteps: observed.steps, boundaryEnabled: true, mayFinalize: true })).toBe("current");
      if (isStuck(mode)) await writeStuckCascade(tx, observed.run, observed.pending, new Date());
      else await writeDeadlockCascade(tx, observed.run, observed.selected, new Date());
      const result = await finalizeRunTerminal(tx, terminalInput(observed));
      expect(result.kind).toBe("finalized");
      if (result.kind !== "finalized") throw Error("real finalized required");
      expect(result.effectIntentCount).toBeGreaterThan(0);
      const inside = await cascadeState(tx, world);
      expect(inside.run.status).toBe("failed");
      expect(inside.decisions).toHaveLength(1);
      expect(inside.effects.length).toBeGreaterThan(0);
      expect(inside.effects.every(effect => effect.status === "pending")).toBe(true);
      expect(inside.runtimes).toEqual(before.runtimes);
      expect(inside.steps.find(step => step.stepId === "after")?.status).toBe("skipped");
      expect(inside.transitions).toHaveLength(1);
      for (const step of inside.steps) expect(step.executionGeneration).toBe(before.steps.find(row => row.id === step.id)!.executionGeneration + 1);
      if (!isStuck(mode)) {
        expect(inside.comments).toHaveLength(1);
        expect(inside.issues.find(issue => issue.id === world.issueIdsByStep.after)?.status).toBe("blocked");
      }
      throw Error("c04_outer_abort");
    })).rejects.toThrow("c04_outer_abort");
    expect(await snapshot(owned.peer, world)).toEqual(before);
  });

  it.each(onModes)("%s cancels same-failed internal writes but commits different-completed self-healing", async mode => {
    for (const decision of ["failed", "completed"] as const) {
      const world = await seedCascade(owned.db);
      expect((await finalizeRunTerminal(owned.db, terminalInput(await observe(owned.db, world, mode), decision))).kind).toBe("finalized");
      await owned.db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, world.runId));
      const observed = await observe(owned.db, world, mode), before = await snapshot(owned.peer, world);
      const result = await settle(owned.db, observed, mode), after = await snapshot(owned.peer, world);
      if (decision === "failed") {
        expect(result).toMatchObject({ action: "skipped" });
        expect(after).toEqual(before);
      } else {
        expect(result).toMatchObject({ action: "recovered" });
        expect(after.run).toMatchObject({ status: "failed", dispatchAuthorityVersion: 1 });
        expect(after.decisions.map(row => [row.decision, row.decidedAuthorityVersion]).sort()).toEqual([["completed", 0], ["failed", 1]]);
        expect(after.steps.find(step => step.stepId === "after")?.status).toBe("skipped");
        for (const step of after.steps) expect(step.executionGeneration).toBe(before.steps.find(row => row.id === step.id)!.executionGeneration + 1);
        expect(after.effects.filter(effect => !before.effects.some(row => row.id === effect.id)).every(effect => effect.status === "completed")).toBe(true);
        expect(after.runtimes[0]?.status).toBe("stopped");
      }
    }
  });

  it.each(onModes)("%s preserves terminal decision conflict without prefix writes", async mode => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, mode);
    await finalizeRunTerminal(owned.peer, terminalInput(observed, "completed"));
    const before = await snapshot(owned.peer, world);
    await expect(settle(owned.db, observed, mode)).rejects.toThrow("terminal decision conflict");
    expect(await snapshot(owned.peer, world)).toEqual(before);
  });

  it.each(onModes)("%s sees a late unblock after a physically observed first-skip wait", async mode => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, mode);
    const key = Math.floor(Math.random() * 1000000000);
    const remove = await trigger(owned.db, "workflow_step_runs", "BEFORE UPDATE",
      `NEW.id = '${world.stepRunIdsByStep.after}'::uuid AND NEW.status = 'skipped'`, `PERFORM pg_advisory_xact_lock(${key});`);
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof settle>>>[]> | undefined;
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await owned.peer.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`);
        const [holder] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        pending = Promise.allSettled([settle(owned.db, observed, mode)]);
        await waitForSkipLock(owned.observer, Number(holder!.pid));
        await insertUnblock(tx, world, world.issueIdsByStep.upstream!);
        before = await cascadeState(tx, world);
      });
      const [result] = await pending!;
      expect(result!.status).toBe("fulfilled");
      if (result!.status !== "fulfilled") throw result!.reason;
      expect(result!.value).toMatchObject({ action: isStuck(mode) ? "deferred" : "skipped" });
      expect(await snapshot(owned.peer, world)).toEqual(before);
    } finally { if (pending) await pending; await remove(); }
  });

  it.each(["stuck-off", "deadlock-off"] as Mode[])("%s cancels its entire prefix if final UPDATE fails", async mode => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, mode), before = await snapshot(owned.peer, world);
    const prefix = `EXISTS (SELECT 1 FROM workflow_step_runs WHERE id = '${world.stepRunIdsByStep.after}'::uuid AND status = 'skipped')
      AND EXISTS (SELECT 1 FROM workflow_transition_events WHERE workflow_run_id = '${world.runId}'::uuid)`;
    const block = isStuck(mode) ? "TRUE" : `EXISTS (SELECT 1 FROM issue_comments WHERE issue_id = '${world.issueIdsByStep.after}'::uuid)`;
    const remove = await trigger(owned.db, "workflow_runs", "BEFORE UPDATE",
      `NEW.id = '${world.runId}'::uuid AND NEW.status = 'failed'`,
      `IF NOT (${prefix} AND ${block}) THEN RAISE EXCEPTION 'c04_prefix_missing'; END IF; RAISE EXCEPTION 'c04_off_failure';`);
    try {
      const [result] = await Promise.allSettled([settle(owned.db, observed, mode)]);
      expect(result!.status).toBe("rejected");
      if (result!.status !== "rejected") throw Error("injected final UPDATE must fail");
      expect(errorMessages(result!.reason)).toContain("c04_off_failure");
      expect(await snapshot(owned.peer, world)).toEqual(before);
    } finally { await remove(); }
  });

  it.each(terminalModes)("%s preserves normal results, markers, transitions, blocking and committed effects", async mode => {
    const world = await seedCascade(owned.db), observed = await observe(owned.db, world, mode), before = await snapshot(owned.peer, world);
    const result = await settle(owned.db, observed, mode), after = await snapshot(owned.peer, world);
    expect(result).toMatchObject({ action: "recovered" });
    expect(result?.reason).toContain(isStuck(mode) ? "Marked stuck run as failed" : "converged without 60-min wait");
    expect(after.run.status).toBe("failed");
    expect(after.run.dispatchAuthorityVersion).toBe(before.run.dispatchAuthorityVersion);
    const step = after.steps.find(row => row.stepId === "after")!;
    expect(step).toMatchObject({ status: "skipped", metadata: { keep: "original",
      ...(isStuck(mode) ? { failureCascadeSkipped: true } : { controlFlowSkipped: true }) } });
    expect(after.transitions).toEqual([expect.objectContaining({ fromStatus: "pending", toStatus: "skipped",
      reasonCode: isStuck(mode) ? "workflow_reconciler" : "workflow_deadlock_reconciler",
      payload: expect.objectContaining({ transitionVersion: step.statusTransitionVersion }) })]);
    expect(step.completedAt).not.toBeNull();
    if (!isStuck(mode)) {
      expect(after.issues.find(issue => issue.id === world.issueIdsByStep.after)?.status).toBe("blocked");
      expect(after.comments[0]?.body).toContain(`[control-plane-deadlock:${world.runId}:${step.id}]`);
    } else expect(after.comments).toHaveLength(0);
    expect(after.decisions).toHaveLength(enabled(mode) ? 1 : 0);
    expect(after.effects).toHaveLength(enabled(mode) ? 1 : 0);
    expect(after.effects.every(effect => effect.status === "completed")).toBe(true);
    expect(after.runtimes[0]?.status).toBe(enabled(mode) ? "stopped" : "busy");
    for (const row of after.steps) expect(row.executionGeneration).toBe(before.steps.find(old => old.id === row.id)!.executionGeneration + (enabled(mode) ? 1 : 0));
  });
});

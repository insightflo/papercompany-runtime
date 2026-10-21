import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  instanceSettings, workflowDefinitions, workflowRecoveryAuthorities, workflowRunDefinitions,
  workflowRuns, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { seedBoundaryIntegrationRun } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import {
  createCascadeHarness, enabled, errorMessages, isStuck, observe, settle, snapshot, trigger, type Mode,
} from "./helpers/failure-cascade-atomicity-fixture.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "../services/workflow/workflow-sync-source.js";
import { retryIssueLessToolWorkflowStepInternal } from "../services/workflow/retry-issue-less-manual.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";
import { isIssueLessToolStep } from "../services/workflow/issue-less-tool-shape.js";
import { getWorkflowExecutionResultSnapshot } from "../services/workflow/dag-engine.js";

const allModes: Mode[] = ["stuck-on", "stuck-off", "deadlock-on", "deadlock-off"];
const officialModes: Mode[] = ["stuck-on", "deadlock-on"];
describe("C04 durable failure-cascade causes", () => {
  let owned: Awaited<ReturnType<typeof createCascadeHarness>>;
  beforeAll(async () => { owned = await createCascadeHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  async function seed(historical = true) {
    const db = owned.db;
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {},
      experimental: { enableRunReopenGuardV1: true, enableRunRecoveryServiceV1: true } });
    const world = await seedBoundaryIntegrationRun(db, { steps: [
      { stepId: "upstream", status: "pending" },
      { stepId: "after", status: "pending", dependencies: ["upstream"], metadata: { keep: "first" } },
      { stepId: "last", status: "pending", dependencies: ["after"], metadata: { keep: "second" } },
      { stepId: "other", status: "pending" },
      { stepId: "mixed", status: "pending", dependencies: ["after", "other"] },
      { stepId: "mixed-last", status: "pending", dependencies: ["mixed"] },
      { stepId: "excluded", status: "pending", dependencies: ["upstream"] },
      { stepId: "cancelled", status: "pending", issueStatus: "cancelled", dependencies: ["upstream"] },
      { stepId: "published", status: "pending", metadata: { publicationReceipt: { confirmed: true, key: "keep" } } },
    ] });
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, world.workflowId));
    const steps = (definition!.stepsJson as Array<Record<string, unknown>>).map(step => step.id === "upstream"
      ? { ...step, type: "tool", agentId: "", toolNames: ["c04-no-execute"] }
      : step.id === "excluded" ? { ...step, conditionalDependencies: [{ stepId: "published", when: "failure" }] } : step);
    await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, world.workflowId));
    if (historical) await db.transaction(async tx => {
      await tx.update(workflowRuns).set({ status: "pending", startedAt: null, metadata: { executionDefinitionVersion: 1 } })
        .where(eq(workflowRuns.id, world.runId));
      await captureExecutionDefinition(tx, world.runId);
      await tx.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, world.runId));
    });
    async function mark(stepId: string, status: string, source: WorkflowSyncSource, metadata?: Record<string, unknown>) {
      const [row] = await db.update(workflowStepRuns).set({ status, completedAt: new Date(), ...(metadata ? { metadata } : {}) })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep[stepId]!)).returning();
      await recordWorkflowStepStatusTransition(db, { companyId: world.companyId, missionId: world.missionId,
        workflowRunId: world.runId, workflowStepRunId: row!.id, issueId: row!.issueId,
        fromStatus: "pending", toStatus: status, transitionVersion: row!.statusTransitionVersion, source });
    }
    await mark("published", "completed", "workflow_tool_result");
    await mark("excluded", "skipped", "workflow_sync", { controlFlowSkipped: true });
    await mark("upstream", "failed", "workflow_tool_result");
    await mark("other", "failed", "workflow_tool_result");
    const before = await snapshot(owned.peer, world);
    const [definitionSnapshot] = await db.select().from(workflowRunDefinitions)
      .where(eq(workflowRunDefinitions.workflowRunId, world.runId));
    return { ...world, before, definitionHash: definitionSnapshot?.definitionHash ?? null };
  }
  type World = Awaited<ReturnType<typeof seed>>;
  type State = Awaited<ReturnType<typeof snapshot>>;
  type Step = State["steps"][number];

  // Expected identities are the seeded PostgreSQL rows BEFORE either writer or finalizer runs.
  function expectedIdentity(row: Step) {
    return { stepRunId: row.id, stepId: row.stepId, issueId: row.issueId,
      executionGeneration: row.executionGeneration, statusTransitionVersion: row.statusTransitionVersion,
      dispatchRequestId: row.lastDispatchRequestId };
  }
  function expectedProof(world: World, stepId: string, mode: Mode) {
    const row = world.before.steps.find(row => row.stepId === stepId)!;
    const causes = world.before.steps.filter(row =>
      row.stepId === "upstream" || (["mixed", "mixed-last"].includes(stepId) && row.stepId === "other"))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { schemaVersion: 1, companyId: world.companyId, missionId: world.missionId,
      workflowRunId: world.runId, authorityVersion: world.before.run.dispatchAuthorityVersion,
      definitionHash: world.definitionHash, source: isStuck(mode) ? "workflow_reconciler" : "workflow_deadlock_reconciler",
      target: expectedIdentity(row), causes: causes.map(expectedIdentity), complete: true };
  }
  async function finish(world: World, mode: Mode) {
    const observed = await observe(owned.db, world, mode);
    expect(await settle(owned.db, observed, mode)).toMatchObject({ action: "recovered" });
    return snapshot(owned.peer, world);
  }
  async function sync(db: Db, runId: string) {
    const result = await getWorkflowExecutionResultSnapshot(db, runId);
    if (!result) throw Error("missing fixture");
    return result;
  }
  async function recover(world: World, before: State) {
    const failed = before.steps.find(row => row.stepId === "upstream")!;
    return retryIssueLessToolWorkflowStepInternal({ db: owned.db, companyId: world.companyId, runId: world.runId,
      stepId: "upstream", recoveryRequestReference: "c04-provenance",
      expectedFailure: { stepRunId: failed.id, authorityVersion: before.run.dispatchAuthorityVersion,
        executionGeneration: failed.executionGeneration, dispatchRequestId: failed.lastDispatchRequestId },
      loadWorkflowExecutionContext, isIssueLessToolStep,
      resetUnlaunchedTerminalStepRuns: async () => { throw Error("strict recovery cannot use legacy reset"); },
      syncWorkflowRunState: sync });
  }
  async function assertRecovery(world: World, terminal: State, restored: boolean) {
    expect(await recover(world, terminal)).not.toBeNull();
    const current = await snapshot(owned.peer, world);
    expect(current.run).toMatchObject({ status: "running", dispatchAuthorityVersion: terminal.run.dispatchAuthorityVersion + 1 });
    const authorities = await owned.peer.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, world.runId));
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.status).toBe("consumed");
    for (const before of terminal.steps) {
      const row = current.steps.find(row => row.id === before.id)!;
      expect(row.executionGeneration).toBe(before.executionGeneration + 1);
      if (before.stepId === "upstream") expect(row.status).toBe("pending");
      else if (restored && ["after", "last"].includes(before.stepId)) {
        expect(row).toMatchObject({ status: "pending", completedAt: null, startedAt: null });
        expect(row.metadata).toEqual({ ...before.metadata,
          ...(before.metadata.failureCascadeSkipped ? { failureCascadeSkipped: false } : { controlFlowSkipped: false }) });
      } else expect(row).toEqual({ ...before, executionGeneration: before.executionGeneration + 1 });
    }
    expect(current.issues).toEqual(terminal.issues);
    expect(current.effects).toEqual(terminal.effects);
    expect(current.wakes).toEqual(terminal.wakes);
    expect(current.heartbeats).toEqual(terminal.heartbeats);
  }

  // Oracle: C04 + assessment:24-39 + addendum:2-4. A -> after -> last has ONE cause;
  // (after, other) -> mixed -> mixed-last has TWO. The same input fails on the baseline
  // because it records neither causal identity, authority/generation nor verified graph hash.
  it.each(allModes)("%s persists actual single and multiple causes with the skip", async mode => {
    const world = await seed(), terminal = await finish(world, mode);
    for (const id of ["after", "last", "mixed", "mixed-last", "cancelled"]) {
      const row = terminal.steps.find(row => row.stepId === id)!;
      expect(row.status).toBe("skipped");
      expect(row.metadata.failureCascadeProvenance).toEqual(expectedProof(world, id, mode));
      expect(row.executionGeneration).toBe(world.before.steps.find(prior => prior.id === row.id)!.executionGeneration
        + (enabled(mode) ? 1 : 0)); // Existing terminal fence, independent of the new evidence.
    }
    for (const id of ["excluded", "published"]) {
      const before = world.before.steps.find(row => row.stepId === id)!;
      expect(terminal.steps.find(row => row.id === before.id))
        .toEqual({ ...before, executionGeneration: before.executionGeneration + (enabled(mode) ? 1 : 0) });
    }
  });

  it.each(officialModes)("%s consumes the exact recorded cause without reviving the other branch", async mode => {
    const world = await seed(), terminal = await finish(world, mode);
    await assertRecovery(world, terminal, true);
  });

  const corruptions = ["authority", "definition", "target-generation", "failure-generation", "failure-identity", "malformed"] as const;
  it.each(officialModes.flatMap(mode => corruptions.map(corruption => ({ mode, corruption }))))(
    "$mode rejects $corruption evidence instead of falling back to the historical path", async ({ mode, corruption }) => {
      const world = await seed();
      await finish(world, mode);
      const good = expectedProof(world, "after", mode);
      const proof = corruption === "authority" ? { ...good, authorityVersion: good.authorityVersion + 1 }
        : corruption === "definition" ? { ...good, definitionHash: "0".repeat(64) }
          : corruption === "target-generation" ? { ...good, target: { ...good.target, executionGeneration: good.target.executionGeneration + 1 } }
            : corruption === "failure-generation" ? { ...good, causes: [{ ...good.causes[0]!, executionGeneration: good.causes[0]!.executionGeneration + 1 }] }
              : corruption === "failure-identity" ? { ...good, causes: [expectedIdentity(world.before.steps.find(row => row.stepId === "other")!)] }
                : null;
      const id = world.stepRunIdsByStep.after!;
      const [row] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id));
      await owned.db.update(workflowStepRuns).set({ metadata: { ...row!.metadata, failureCascadeProvenance: proof } })
        .where(eq(workflowStepRuns.id, id));
      // Baseline ignores this exact counterexample and revives after/last; corrected behavior leaves both sticky.
      await assertRecovery(world, await snapshot(owned.peer, world), false);
    });

  it.each(officialModes)("%s preserves accepted historical transition/graph proof without inventing causes", async mode => {
    const world = await seed();
    const terminal = await finish(world, mode);
    // Model a pre-upgrade record: remove the new field, retain actual events, versions and frozen graph.
    for (const row of terminal.steps) {
      if (row.status !== "skipped") continue;
      const metadata = { ...row.metadata };
      delete metadata.failureCascadeProvenance;
      await owned.db.update(workflowStepRuns).set({ metadata }).where(eq(workflowStepRuns.id, row.id));
    }
    await assertRecovery(world, await snapshot(owned.peer, world), true);
    const current = await snapshot(owned.peer, world);
    expect(current.steps.every(row => !Object.prototype.hasOwnProperty.call(row.metadata, "failureCascadeProvenance"))).toBe(true);
  });

  it.each(officialModes)("%s marks missing historical graph as unproven and keeps skips sticky", async mode => {
    const world = await seed(false), terminal = await finish(world, mode);
    expect(terminal.steps.find(row => row.stepId === "after")?.metadata.failureCascadeProvenance)
      .toMatchObject({ schemaVersion: 1, definitionHash: null, causes: [], complete: false });
    await assertRecovery(world, terminal, false);
  });

  it.each(allModes)("%s rolls back all skips and terminal state when causal metadata storage fails", async mode => {
    const world = await seed(), observed = await observe(owned.db, world, mode);
    observed.pending.sort((a, b) => a.stepId.localeCompare(b.stepId));
    const remove = await trigger(owned.db, "workflow_step_runs", "BEFORE UPDATE",
      `NEW.workflow_run_id = '${world.runId}'::uuid AND OLD.status = 'pending' AND NEW.status = 'skipped'
        AND NEW.step_id = 'last' AND NEW.metadata ? 'failureCascadeProvenance'`,
      `IF NOT EXISTS (SELECT 1 FROM workflow_step_runs WHERE id = '${world.stepRunIdsByStep.after}'::uuid
        AND status = 'skipped' AND metadata ? 'failureCascadeProvenance') THEN
        RAISE EXCEPTION 'c04_provenance_prefix_missing'; END IF; RAISE EXCEPTION 'c04_provenance_store_failed';`);
    try {
      const [result] = await Promise.allSettled([settle(owned.db, observed, mode)]);
      expect(result!.status).toBe("rejected");
      if (result!.status !== "rejected") throw Error("causal storage must fail the cascade");
      expect(errorMessages(result!.reason)).toContain("c04_provenance_store_failed");
      expect(await snapshot(owned.peer, world)).toEqual(world.before);
    } finally { await remove(); }
  });
});

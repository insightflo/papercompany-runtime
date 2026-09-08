import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { seedWorkflowRun } from "./helpers/workflow-execution-definition-fixture.js";
import {
  seedFenceGraph,
  seedFenceHeartbeatRun,
  seedFenceStepRun,
  seedFenceWakeup,
  startFenceFixture,
  type FenceFixture,
  type FenceGraph,
} from "./helpers/workflow-resume-stale-fences-fixture.js";
import {
  resolveHeartbeatResumeScopeFence,
  type HeartbeatResumeScopeRun,
} from "../services/workflow/resume-scope-fence.js";

// Real embedded PostgreSQL rows; this proves the helper boundary, not heartbeat end-to-end.
describe("heartbeat recorded resume identity", () => {
  let fixture: FenceFixture;
  let db: Db;
  let graph: FenceGraph;
  let foreignGraph: FenceGraph;
  let stepId: string;
  let otherStepId: string;
  let otherRunId: string;
  const stamp = randomUUID();

  beforeAll(async () => {
    fixture = await startFenceFixture("resume-heartbeat-identity-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    graph = await seedFenceGraph(db, "HB-ID", { runMetadata: { resumeRequestId: stamp } });
    foreignGraph = await seedFenceGraph(db, "HB-FOREIGN");
    stepId = (await seedFenceStepRun(db, {
      runId: graph.runId,
      values: { executionGeneration: 2, metadata: { resumeRequestId: stamp } },
    })).id;
    otherStepId = (await seedFenceStepRun(db, { runId: graph.runId, stepId: "other-step" })).id;
    otherRunId = await seedWorkflowRun(db.$client, {
      workflowId: graph.workflowId,
      companyId: graph.companyId,
      missionId: graph.missionId,
    });
  }, 60_000);

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  function heartbeat(values: Partial<Parameters<typeof seedFenceHeartbeatRun>[1]> = {}) {
    return seedFenceHeartbeatRun(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      workflowStepRunId: stepId,
      ...values,
    });
  }

  function wakeup(values: Partial<Parameters<typeof seedFenceWakeup>[1]> = {}) {
    return seedFenceWakeup(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      workflowRunId: graph.runId,
      workflowStepRunId: stepId,
      workflowExecutionGeneration: 2,
      ...values,
    });
  }

  function rejection(recorded: number | null) {
    return {
      action: "reject",
      workflowRunId: graph.runId,
      workflowStepRunId: stepId,
      gotGeneration: 2,
      wantGeneration: recorded,
      reason: "generation_mismatch",
    };
  }

  it("rejects missing recorded generation without a wakeup", async () => {
    expect(await resolveHeartbeatResumeScopeFence(db, await heartbeat())).toEqual(rejection(null));
  });

  it("does not accept generation from context text or JSON", async () => {
    const run = await heartbeat({
      contextSnapshot: { workflowExecutionGeneration: 2, generation: "2", text: "generation 2" },
    });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual(rejection(null));
  });

  it.each([false, true])("allows exact typed wakeup fallback (context step link: %s)", async (contextLink) => {
    const wake = await wakeup();
    const run = await heartbeat({
      wakeupRequestId: wake.id,
      workflowStepRunId: contextLink ? null : stepId,
      // The joined actual run, not context's run ID, governs wakeup identity.
      contextSnapshot: { workflowStepRunId: stepId, workflowRunId: otherRunId },
    });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
  });

  it.each(["step", "run", "company", "missing-step", "missing-run"] as const)(
    "rejects fallback wakeup with mismatched %s identity",
    async (kind) => {
      const wake = await wakeup({
        ...(kind === "step" ? { workflowStepRunId: otherStepId } : {}),
        ...(kind === "run" ? { workflowRunId: otherRunId } : {}),
        ...(kind === "company" ? { companyId: foreignGraph.companyId, agentId: foreignGraph.agentId } : {}),
        ...(kind === "missing-step" ? { workflowStepRunId: null } : {}),
        ...(kind === "missing-run" ? { workflowRunId: null } : {}),
      });
      const run = await heartbeat({
        wakeupRequestId: wake.id,
        contextSnapshot: { workflowRunId: otherRunId, workflowExecutionGeneration: 2 },
      });
      expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual(rejection(null));
    },
  );

  it("rejects a missing wakeup row", async () => {
    const run = await heartbeat();
    expect(await resolveHeartbeatResumeScopeFence(db, {
      ...run, wakeupRequestId: randomUUID(),
    })).toEqual(rejection(null));
  });

  it.each([null, -1])("rejects absent/invalid wakeup generation %s", async (generation) => {
    const wake = await wakeup({ workflowExecutionGeneration: generation });
    const run = await heartbeat({ wakeupRequestId: wake.id });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual(rejection(null));
  });

  it("rejects a stale wakeup generation with recorded/current diagnostics preserved", async () => {
    const wake = await wakeup({ workflowExecutionGeneration: 1 });
    expect(await resolveHeartbeatResumeScopeFence(db, await heartbeat({ wakeupRequestId: wake.id })))
      .toEqual(rejection(1));
  });

  it("rejects stale direct generation despite an exact fallback", async () => {
    const wake = await wakeup();
    const run = await heartbeat({ wakeupRequestId: wake.id, workflowExecutionGeneration: 1 });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual(rejection(1));
  });

  it("allows exact direct generation without a wakeup", async () => {
    const run = await heartbeat({ workflowExecutionGeneration: 2 });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
  });

  it.each(["stale", "foreign"] as const)("exact direct generation takes precedence over %s wakeup", async (kind) => {
    const wake = await wakeup(kind === "stale"
      ? { workflowExecutionGeneration: 1 }
      : { workflowStepRunId: otherStepId, workflowRunId: otherRunId });
    const run = await heartbeat({ wakeupRequestId: wake.id, workflowExecutionGeneration: 2 });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "2", false])(
    "rejects invalid non-null direct generation %s without falling back",
    async (invalid) => {
      const wake = await wakeup();
      const run = await heartbeat({ wakeupRequestId: wake.id });
      // SQL integer cannot represent most of these; only helper input is overridden.
      // Heartbeat, wakeup, target step and joined workflow run remain real DB rows.
      const input = { ...run, workflowExecutionGeneration: invalid } as unknown as HeartbeatResumeScopeRun;
      expect(await resolveHeartbeatResumeScopeFence(db, input)).toEqual(rejection(null));
    },
  );

  it("uses fallback when the direct typed generation is undefined", async () => {
    const wake = await wakeup();
    const run = await heartbeat({ wakeupRequestId: wake.id });
    expect(await resolveHeartbeatResumeScopeFence(db, { ...run, workflowExecutionGeneration: undefined }))
      .toEqual({ action: "allow" });
  });

  it("allows exact generation zero on a stamped step", async () => {
    const step = await seedFenceStepRun(db, {
      runId: graph.runId,
      stepId: "zero-generation",
      values: { executionGeneration: 0, metadata: { resumeRequestId: stamp } },
    });
    const run = await heartbeat({ workflowStepRunId: step.id, workflowExecutionGeneration: 0 });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
  });

  it("preserves run/step stamp mismatch rejection even with exact generation", async () => {
    const step = await seedFenceStepRun(db, {
      runId: graph.runId,
      stepId: "stale-stamp",
      values: { executionGeneration: 2, metadata: { resumeRequestId: randomUUID() } },
    });
    const run = await heartbeat({ workflowStepRunId: step.id, workflowExecutionGeneration: 2 });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({
      ...rejection(2), workflowStepRunId: step.id, reason: "resume_request_id_mismatch",
    });
  });

  it("allows an unstamped step with no recorded generation", async () => {
    const run = await heartbeat({ workflowStepRunId: otherStepId });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
  });

  it("preserves allowance with no step link or no target row", async () => {
    const run = await heartbeat({ workflowStepRunId: null });
    expect(await resolveHeartbeatResumeScopeFence(db, run)).toEqual({ action: "allow" });
    expect(await resolveHeartbeatResumeScopeFence(db, { ...run, workflowStepRunId: randomUUID() }))
      .toEqual({ action: "allow" });
  });
});

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  captureNativeScopedRecords, seedNativeEntryGraph, startNativeEntryFixture,
  type NativeEntryFixture,
} from "./helpers/workflow-resume-native-entry-fixture.js";
import * as liveness from "../services/workflow/rework-liveness.js";
import { reconcileGraceWaitingControlNodes } from "../services/workflow/grace-waiting-control-node-reconciler.js";

// No agents/tools may be dispatched by a rejected timer candidate.
const { wakeup } = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup }) };
});

describe("grace timer preserves native sync ownership and cancellation guards", () => {
  let fixture: Extract<NativeEntryFixture, { supported: true }>;
  beforeAll(async () => {
    const started = await startNativeEntryFixture("grace-reconciler-guards-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
  }, 60_000);
  afterAll(async () => { if (fixture) await fixture.cleanup(); });

  async function seed(prefix: string) {
    const graph = await seedNativeEntryGraph(fixture.sql, fixture.db, { prefix });
    await fixture.db.insert(workflowStepRuns).values({
      workflowRunId: graph.runId, stepId: graph.stepId, status: "pending",
      metadata: { controlNodeGraceWait: {
        since: "2026-09-01T00:00:00.000Z", nextEvaluateAt: "2026-09-01T00:00:01.000Z",
        reason: "missing artifact", attempts: 1,
      } },
    });
    return graph;
  }
  async function snapshot(graph: Awaited<ReturnType<typeof seed>>) {
    return {
      scoped: await captureNativeScopedRecords(fixture.sql, graph.runId),
      queue: await fixture.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, graph.companyId)),
      activity: await fixture.db.select().from(activityLog).where(eq(activityLog.companyId, graph.companyId)),
    };
  }

  it("a false child marker yields skipped without run, step, issue, queue or audit writes", async () => {
    const graph = await seed("GFC");
    await fixture.db.update(workflowRuns).set({ triggeredBy: "workflow-step" }).where(eq(workflowRuns.id, graph.runId));
    const before = await snapshot(graph);
    const result = await reconcileGraceWaitingControlNodes(fixture.db);
    expect(result.find((row) => row.runId === graph.runId)?.action).toBe("skipped");
    expect(await snapshot(graph)).toEqual(before);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("an already cancelled candidate is not selected and has no new writes", async () => {
    const graph = await seed("GCC");
    await fixture.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, graph.runId));
    const before = await snapshot(graph);
    const result = await reconcileGraceWaitingControlNodes(fixture.db);
    expect(result.find((row) => row.runId === graph.runId)).toBeUndefined();
    expect(await snapshot(graph)).toEqual(before);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("cancellation after timer selection yields skipped without further writes", async () => {
    const graph = await seed("GRC");
    const original = liveness.hasActiveWorkflowReworkIteration;
    let cancelled: Awaited<ReturnType<typeof snapshot>> | undefined;
    // Inject the competing cancellation after selection, before the real sync entry.
    const spy = vi.spyOn(liveness, "hasActiveWorkflowReworkIteration").mockImplementation(async (db, input) => {
      const active = await original(db, input);
      if (input.workflowRunId === graph.runId) {
        await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, graph.runId));
        cancelled = await snapshot(graph);
      }
      return active;
    });
    try {
      const result = await reconcileGraceWaitingControlNodes(fixture.db);
      expect(cancelled).toBeDefined();
      expect(result.find((row) => row.runId === graph.runId)?.action).toBe("skipped");
      expect(await snapshot(graph)).toEqual(cancelled);
      expect(wakeup).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

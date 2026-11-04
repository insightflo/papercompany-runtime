import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, workflowTransitionEvents } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { readTerminalReleaseAcknowledgment, readTerminalReleaseManifest,
  readReadyTerminalReleaseContinuation, TERMINAL_RELEASE_EVENT_TYPE } from "../services/heartbeat-terminal-release-continuation.js";
import { createHeartbeatC5PublicFixture, within } from "./helpers/heartbeat-c5-public-fixture.js";
import { createHeartbeatC5PublicLifecycle } from "./helpers/heartbeat-c5-public-lifecycle.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
  runningProcesses: new Map(),
}));

// Observe real reads without substituting manifest validity, authority, or DB results.
vi.mock("../services/heartbeat-terminal-release-continuation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat-terminal-release-continuation.js")>();
  return { ...actual, readTerminalReleaseManifest: vi.fn(actual.readTerminalReleaseManifest) };
});

it("preserves microseconds and UUID ties, reaches empty reset, and revisits pending continuations in three sweeps", async () => {
  const fixture = await createHeartbeatC5PublicFixture();
  const db = fixture.db;
  const lifecycles: Array<Awaited<ReturnType<typeof createHeartbeatC5PublicLifecycle>>> = [];
  try {
    const seeded = [];
    for (let index = 0; index < 3; index += 1) {
      const lifecycle = await createHeartbeatC5PublicLifecycle(fixture);
      lifecycles.push(lifecycle);
      adapter.mockImplementation(lifecycle.executeActual);
      const producer = await lifecycle.startProducer();
      if (!producer?.id) throw new Error("cursor fixture lacks producer run");
      await within(lifecycle.producerWorkCompleted, "cursor producer official artifact");
      const qaRunId = await within(lifecycle.qaVerdictSubmitted, "cursor original QA request_changes");
      lifecycle.releaseProducerActual();
      await vi.waitFor(async () => {
        expect((await lifecycle.readIdentity(producer.id)).heartbeat?.status).toBe("succeeded");
        const drains = await db.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.heartbeatRunId, producer.id),
          eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
        expect(drains).toHaveLength(1);
      }, { timeout: 30_000, interval: 20 });
      expect((await lifecycle.prepare()).outcome).toBe("prepared");
      lifecycle.releaseQaActual();
      await waitForHeartbeatExecutionsToDrain(db, 30_000);
      const events = await db.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle.companyId),
        eq(workflowTransitionEvents.heartbeatRunId, qaRunId),
        eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE)));
      expect(events).toHaveLength(1);
      const id = events[0]!.id;
      // Production readReady checks the actual receipt, exact owner, and frozen attempt identity.
      const ready = await readReadyTerminalReleaseContinuation(db, id);
      expect(ready.kind).toBe("ready");
      if (ready.kind !== "ready") throw new Error(ready.reason);
      const obligation = ready.manifest.obligations.find(item => item.action.kind === "sync_issue")!;
      expect(obligation).toBeDefined();
      // readTerminalReleaseAcknowledgment returns pending only for ready evidence with no ACK (lines 246-255).
      expect((await readTerminalReleaseAcknowledgment(db, id, obligation.effectKey)).kind).toBe("pending");
      seeded.push({ id, manifest: ready.manifest, effectKey: obligation.effectKey, actualOutcome: ready.actualOutcome });
    }
    // Keep genuine event IDs and any existing ACK references; only the test's timestamp precision changes.
    seeded.sort((a, b) => b.id.localeCompare(a.id));
    for (const [index, seed] of seeded.entries()) {
      const timestamp = index === 0 ? "2026-11-03 00:00:00.123100+00" : "2026-11-03 00:00:00.123900+00";
      await db.update(workflowTransitionEvents).set({ createdAt: sql`${timestamp}::timestamptz` })
        .where(eq(workflowTransitionEvents.id, seed.id));
    }
    const orderedIds = [seeded[0]!.id, seeded[2]!.id, seeded[1]!.id];
    const timestamps = await db.select({ id: workflowTransitionEvents.id,
      microseconds: sql<string>`to_char(${workflowTransitionEvents.createdAt}, 'US')` })
      .from(workflowTransitionEvents).where(inArray(workflowTransitionEvents.id, seeded.map(seed => seed.id)));
    expect(timestamps.map(row => row.microseconds).sort()).toEqual(["123100", "123900", "123900"]);
    const beforeRuns = await db.select().from(heartbeatRuns);
    const beforeWakes = await db.select().from(agentWakeupRequests);
    const service = heartbeatService(db);
    const reads = vi.mocked(readTerminalReleaseManifest);
    const scanReadbacks: string[][] = [];
    for (let sweep = 0; sweep < 3; sweep += 1) {
      reads.mockClear();
      await service.reapOrphanedRuns();
      await waitForHeartbeatExecutionsToDrain(db, 30_000);
      scanReadbacks.push([...new Set(reads.mock.calls.map(call => call[1]).filter(id => seeded.some(seed => seed.id === id)))]);
    }
    // No last-row repeat: the second sweep is empty, resets, and the third revisits old pending work.
    expect(scanReadbacks).toEqual([orderedIds, [], orderedIds]);
    for (const seed of seeded) {
      expect((await readTerminalReleaseAcknowledgment(db, seed.id, seed.effectKey)).kind)
        .toBe("pending");
    }
    expect(await db.select().from(heartbeatRuns)).toEqual(beforeRuns);
    expect(await db.select().from(agentWakeupRequests)).toEqual(beforeWakes);
    console.log("CURSOR_PRECISION_PROOF", JSON.stringify({ scanReadbacks, pending: 3, sweeps: 3 }));
    // No V2 completion was published: lifecycle assertAuthorizedQaRefire (232-278) requires it.
    // Only the requested producer and original QA may run; a speculative refire is not an allowed setup run.
    for (const seed of seeded) expect(seed.actualOutcome).toBe("fulfilled");
    for (const lifecycle of lifecycles) {
      const runs = beforeRuns.filter(run => run.companyId === lifecycle.companyId);
      const wakes = beforeWakes.filter(wake => wake.companyId === lifecycle.companyId);
      expect(runs).toHaveLength(2);
      expect(wakes).toHaveLength(2);
      expect(runs.map(run => run.status)).toEqual(["succeeded", "succeeded"]);
    }
  } finally {
    for (const lifecycle of lifecycles) { lifecycle.releaseProducerActual(); lifecycle.releaseQaActual(); }
    await fixture.cleanup();
  }
}, 90_000);

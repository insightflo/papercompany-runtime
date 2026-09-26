import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setHeartbeatRunStatus } from "../services/heartbeat.js";
import { subscribeCompanyLiveEvents, type LiveEvent } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

async function seedRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  overrides: Record<string, unknown> = {},
) {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id,
    companyId,
    agentId,
    invocationSource: "on_demand",
    status: "queued",
    ...overrides,
  } as never);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
  return run!;
}

describeEP("heartbeat run-status fencing (setHeartbeatRunStatus)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let events: LiveEvent[];
  let unsubscribe: (() => void) | null = null;
  let infoSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-status-fencing-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "FenceCo", status: "active" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fence agent",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    events = [];
    unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => events.push(event));
  });
  afterAll(() => {
    unsubscribe?.();
    tempDb = null;
  });
  afterEach(() => {
    infoSpy?.mockRestore();
    infoSpy = null;
  });

  const eventsForRun = (runId: string) =>
    events.filter(
      (event) => event.type === "heartbeat.run.status" && event.payload.runId === runId,
    );

  it("discards the write when the current status is not in expectedStatuses (zombie write fence)", async () => {
    const run = await seedRun(db, companyId, agentId, {
      status: "cancelled",
      finishedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);

    const updated = await setHeartbeatRunStatus(
      db,
      run.id,
      "failed",
      { error: "late executor write", errorCode: "adapter_failed", finishedAt: new Date() },
      { expectedStatuses: ["running"] },
    );

    expect(updated).toBeNull();

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.errorCode).toBeNull();
    expect(row?.error).toBeNull();
    expect(row?.finishedAt?.toISOString()).toBe("2026-04-01T00:00:00.000Z");

    const discardCalls = infoSpy.mock.calls.filter(
      (call) => call[call.length - 1] === "fenced run-status write discarded",
    );
    expect(discardCalls).toHaveLength(1);
    const fields = discardCalls[0]![0] as Record<string, unknown>;
    expect(fields.runId).toBe(run.id);
    expect(fields.attempted).toBe("failed");
    expect(fields.expectedStatuses).toEqual(["running"]);

    expect(eventsForRun(run.id)).toHaveLength(0);
  });

  it("updates and emits events when the current status matches expectedStatuses", async () => {
    const run = await seedRun(db, companyId, agentId, { status: "running" });
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);

    const updated = await setHeartbeatRunStatus(
      db,
      run.id,
      "failed",
      { error: "adapter crashed", errorCode: "adapter_failed", finishedAt: new Date() },
      { expectedStatuses: ["running"] },
    );

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("failed");
    expect(updated?.errorCode).toBe("adapter_failed");

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row?.status).toBe("failed");
    expect(row?.finishedAt).not.toBeNull();

    const runEvents = eventsForRun(run.id);
    expect(runEvents.length).toBeGreaterThanOrEqual(1);
    expect(runEvents[0]!.payload.status).toBe("failed");

    const discardCalls = infoSpy.mock.calls.filter(
      (call) => call[call.length - 1] === "fenced run-status write discarded",
    );
    expect(discardCalls).toHaveLength(0);
  });

  it("keeps the legacy unconditional write when expectedStatuses is omitted", async () => {
    const run = await seedRun(db, companyId, agentId, {
      status: "cancelled",
      finishedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const updated = await setHeartbeatRunStatus(db, run.id, "failed", {
      error: "legacy overwrite",
      errorCode: "adapter_failed",
      finishedAt: new Date(),
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("failed");
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row?.status).toBe("failed");
  });

  it("matches any of the expected pre-states (queued|running cancel fence)", async () => {
    const queuedRun = await seedRun(db, companyId, agentId, { status: "queued" });
    const runningRun = await seedRun(db, companyId, agentId, { status: "running" });
    const terminalRun = await seedRun(db, companyId, agentId, { status: "succeeded" });

    const cancelledQueued = await setHeartbeatRunStatus(
      db,
      queuedRun.id,
      "cancelled",
      { errorCode: "cancelled" },
      { expectedStatuses: ["queued", "running"] },
    );
    const cancelledRunning = await setHeartbeatRunStatus(
      db,
      runningRun.id,
      "cancelled",
      { errorCode: "cancelled" },
      { expectedStatuses: ["queued", "running"] },
    );
    const cancelledTerminal = await setHeartbeatRunStatus(
      db,
      terminalRun.id,
      "cancelled",
      { errorCode: "cancelled" },
      { expectedStatuses: ["queued", "running"] },
    );

    expect(cancelledQueued?.status).toBe("cancelled");
    expect(cancelledRunning?.status).toBe("cancelled");
    expect(cancelledTerminal).toBeNull();

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, terminalRun.id));
    expect(row?.status).toBe("succeeded");
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setWorkflowStepRunStatus } from "../services/workflow/step-status-fencing.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping step-status fencing tests: ${support.reason ?? "unsupported host"}`);

/** company → definition → run → step run 최소 시드(mission 불필요). */
async function seedStepRun(db: ReturnType<typeof createDb>, status: string) {
  const companyId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `FenceCo-${companyId.slice(0, 8)}`,
    issuePrefix: `SF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
  });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "fence-wf", stepsJson: [] });
  await db.insert(workflowRuns).values({
    id: runId, workflowId, companyId, status: "running", triggeredBy: "test", startedAt: new Date(),
  });
  const [row] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: "step-a", status, metadata: {},
  }).returning();
  return row!;
}

describeEP("step status fencing (setWorkflowStepRunStatus)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let infoSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("step-status-fencing-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });
  afterEach(() => {
    infoSpy?.mockRestore();
    infoSpy = null;
  });

  const discardCalls = () =>
    (infoSpy?.mock.calls ?? []).filter((call) => call[call.length - 1] === "fenced step-status write discarded");

  it("discards the write when the current status is not in expectedStatuses (zombie write fence)", async () => {
    const stepRun = await seedStepRun(db, "failed");
    const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);

    const updated = await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "completed",
      patch: { lastDispatchErrorSummary: "late executor write" },
      expectedStatuses: ["running"],
    });

    expect(updated).toBeNull();
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(row?.status).toBe("failed");
    expect(row?.lastDispatchErrorSummary).toBeNull();
    expect(row?.statusTransitionVersion).toBe(before[0]!.statusTransitionVersion);

    expect(discardCalls()).toHaveLength(1);
    const fields = discardCalls()[0]![0] as Record<string, unknown>;
    expect(fields.stepRunId).toBe(stepRun.id);
    expect(fields.attempted).toBe("completed");
    expect(fields.expected).toEqual(["running"]);
  });

  it("updates normally when the current status matches expectedStatuses", async () => {
    const stepRun = await seedStepRun(db, "running");
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);

    const updated = await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "failed",
      patch: { lastDispatchErrorSummary: "adapter crashed" },
      expectedStatuses: ["running", "pending"],
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("failed");
    expect(updated?.lastDispatchErrorSummary).toBe("adapter crashed");
    // migration 0080 트리거: status 값이 실제로 바뀐 갱신만 version 를 +1 한다.
    expect(updated?.statusTransitionVersion).toBe(stepRun.statusTransitionVersion + 1);
    expect(discardCalls()).toHaveLength(0);
  });

  it("keeps the legacy unconditional write when expectedStatuses is omitted", async () => {
    const stepRun = await seedStepRun(db, "completed");

    const updated = await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "failed",
      patch: { lastDispatchErrorSummary: "legacy overwrite" },
    });

    expect(updated?.status).toBe("failed");
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(row?.status).toBe("failed");
    expect(row?.lastDispatchErrorSummary).toBe("legacy overwrite");
  });

  it("honors extraConditions (generation CAS) and discards on mismatch", async () => {
    const stepRun = await seedStepRun(db, "running");
    await db.update(workflowStepRuns)
      .set({ executionGeneration: stepRun.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, stepRun.id));
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);

    const updated = await setWorkflowStepRunStatus(db, {
      stepRunId: stepRun.id,
      status: "completed",
      patch: { completedAt: new Date() },
      expectedStatuses: ["running"],
      extraConditions: [eq(workflowStepRuns.executionGeneration, stepRun.executionGeneration)],
    });

    expect(updated).toBeNull();
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRun.id));
    expect(row?.status).toBe("running");
    expect(row?.completedAt).toBeNull();
    expect(discardCalls()).toHaveLength(1);
  });
});

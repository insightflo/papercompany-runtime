import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, issues, workflowStepRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables, seedBoundaryWorld, stepRunsOf, type BoundaryWorld } from "./helpers/run-terminal-boundary-fixture.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping run-late-result-fencing tests: ${support.reason ?? "unsupported host"}`);

const FAILED_CAUSE = { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "late result fencing" } as const;
let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("late-result-fencing-");
  db = createDb(tempDb.connectionString);
});
afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

async function loadStepRun(id: string) {
  const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id));
  expect(row).toBeDefined();
  return row!;
}
async function markIssueDone(world: BoundaryWorld) {
  await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, world.stepIssueId));
}
async function finalizeFailed(world: BoundaryWorld, version: number) {
  const result = await finalizeRunTerminal(db, {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: version,
    decision: "failed", cause: FAILED_CAUSE, gatePolicy: "immediate", now: new Date(), stepRuns: stepRunsOf(world),
  });
  expect(result.kind).toBe("finalized");
}
async function assertGenerationCas(staleId: string, staleGeneration: number, currentId: string, currentGeneration: number) {
  const now = new Date();
  const stale = await db.update(workflowStepRuns).set({ status: "completed", startedAt: now, completedAt: now })
    .where(and(eq(workflowStepRuns.id, staleId), eq(workflowStepRuns.executionGeneration, staleGeneration)))
    .returning({ id: workflowStepRuns.id });
  expect(stale).toEqual([]);
  const current = await db.update(workflowStepRuns).set({ status: "completed", startedAt: now, completedAt: now })
    .where(and(eq(workflowStepRuns.id, currentId), eq(workflowStepRuns.executionGeneration, currentGeneration)))
    .returning({ id: workflowStepRuns.id });
  expect(current).toHaveLength(1);
}

describeEP("late results are fenced by step execution generation", () => {
  it("fences the issue-sync consumption point after terminal stamping", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    const stale = await loadStepRun(world.stepRunId);
    await finalizeFailed(world, 0);
    const current = await loadStepRun(world.stepRunId);
    await assertGenerationCas(stale.id, stale.executionGeneration, current.id, current.executionGeneration);
  });

  it("fences ordinary completion after terminal stamping", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    const stale = await loadStepRun(world.stepRunId);
    await finalizeFailed(world, 0);
    const current = await loadStepRun(world.stepRunId);
    await assertGenerationCas(stale.id, stale.executionGeneration, current.id, current.executionGeneration);
  });

  it("accepts a fresh issue-state sync after recovery", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    await finalizeFailed(world, 0);
    const recovery = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "source_issue_unblock", requestReference: "issue-sync-recovery",
      requestedBy: "source_issue_unblock", now: new Date(),
    });
    expect(recovery.kind).toBe("recovered");
    const recovered = await loadStepRun(world.stepRunId);
    await markIssueDone(world);
    await syncWorkflowRunState(db, world.runId);
    expect(await loadStepRun(world.stepRunId)).toMatchObject({ status: "completed", executionGeneration: recovered.executionGeneration });
  });
});

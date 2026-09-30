import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, missions, workflowRuns, workflowStepRuns, workflowRunDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { reconcileReplacementStarts } from "../services/workflow/replacement-start-reconciler.js";
import { syncWorkflowRunState, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

describe("replacement first delivery crash and contention", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-delivery-"); db = createDb(temp.connectionString);
    setWorkflowToolStepExecutor(async () => ({ accepted: true })); }, 60_000);
  afterAll(async () => { setWorkflowToolStepExecutor(null); await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
  async function seed() { const s = await seedReplacement(db); roots.push(s.tempRoot);
    return { ...s, target: (await admitReplacement(db, s.input, s.actor)).run }; }
  const hooks = { activateMission: async () => {} } as never;
  it("reconciles a crash after initial claim using the same run and native request, without rewriting startedAt", async () => {
    const s = await seed(); expect(await claimPlainWorkflowStart(db, s.target.id, hooks)).toBe("started");
    const [claimed] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.target.id));
    await Promise.all([reconcileReplacementStarts(db), reconcileReplacementStarts(db)]);
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.target.id));
    expect(steps).toHaveLength(2);
    const tool = steps.find((step) => step.stepId === "collect-us-stockflow")!;
    expect(tool.lastDispatchRequestId).toBeTruthy(); expect(tool.metadata?.toolQueue).toMatchObject({ status: "queued" });
    const [delivered] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.target.id));
    expect(delivered.startedAt).toEqual(claimed.startedAt);
    expect(delivered.metadata?.replacementStart).toMatchObject({ schemaVersion: 1, deliveredAt: expect.any(String) });
    await reconcileReplacementStarts(db);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.target.id))).toEqual(steps);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toHaveLength(2);
  });
  it("failed delivery transaction rolls materialization back and retains a recoverable claim", async () => {
    const s = await seed(); await claimPlainWorkflowStart(db, s.target.id, hooks);
    await db.$client.unsafe(`CREATE FUNCTION refuse_replacement_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.target.id}'::uuid AND NEW.metadata->'replacementStart'->>'deliveredAt' IS NOT NULL THEN RAISE EXCEPTION 'receipt crash'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER refuse_replacement_receipt BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION refuse_replacement_receipt()`);
    try {
      await expect(syncWorkflowRunState(db, s.target.id)).rejects.toThrow("receipt crash");
      expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.target.id))).toEqual([]);
    } finally { await db.$client.unsafe("DROP TRIGGER refuse_replacement_receipt ON workflow_runs; DROP FUNCTION refuse_replacement_receipt()"); }
    await reconcileReplacementStarts(db);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.target.id))).toHaveLength(2);
  });
  it.each(["cancel", "budget"])("%s committed while delivery waits on mission lock prevents all materialization", async (kind) => {
    const s = await seed(); await claimPlainWorkflowStart(db, s.target.id, hooks);
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), locked = new Promise<void>((r) => { ready = r; });
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(missions).where(eq(missions.id, s.mission.id)).for("update"); ready(); await gate;
      if (kind === "cancel") await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
      else await tx.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    });
    await locked; const delivery = syncWorkflowRunState(db, s.target.id); release(); await blocker;
    await expect(delivery).rejects.toThrow("replacement_start_ineligible");
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.target.id))).toEqual([]);
  });
  it("bad targets on page one do not starve page two", async () => {
    const targets: string[] = [];
    for (let i = 0; i < 101; i++) targets.push((await seed()).target.id);
    targets.sort(); const good = targets.pop()!;
    for (const id of targets) await db.update(workflowRunDefinitions).set({ definitionHash: "0".repeat(64) }).where(eq(workflowRunDefinitions.workflowRunId, id));
    const outcomes = await reconcileReplacementStarts(db);
    expect(outcomes.find((r) => r.runId === good)?.kind).toBe("started");
    expect(outcomes.filter((r) => targets.includes(r.runId) && r.code === "replacement_start_failed")).toHaveLength(100);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, good))).toHaveLength(2);
  }, 120_000);
});

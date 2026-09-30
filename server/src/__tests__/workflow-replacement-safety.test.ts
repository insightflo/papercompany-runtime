import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, heartbeatRuns, agentWakeupRequests, workflowStepRuns, workflowRuns,
  workflowDefinitions, workflowRecoveryAuthorities, workflowRunDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { proposeReplacement } from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { workflowService as workflowEngine } from "../services/workflow/engine.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { reconcileReplacementStarts } from "../services/workflow/replacement-start-reconciler.js";

// Every case catches a missing DB evidence branch, not a displayed run/issue status.
describe("replacement safety boundaries (isolated PostgreSQL)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-safety-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
  async function seed() { const s = await seedReplacement(db); roots.push(s.tempRoot); return s; }
  const hook = { activateMission: async () => {} } as never;
  async function evidence(s: Awaited<ReturnType<typeof seed>>, kind: string) {
    if (kind === "budget") return db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 2 }).where(eq(companies.id, s.companyId));
    if (kind === "tool_queued" || kind === "tool_claimed") return db.update(workflowStepRuns).set({ metadata: {
      toolInvocation: { requestId: "live-tool", toolName: "collect-us-stockflow", queuedAt: new Date().toISOString() },
      toolQueue: { status: kind === "tool_queued" ? "queued" : "claimed" },
    } }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (kind.startsWith("issue_")) await db.update(workflowStepRuns).set({ issueId: s.recoveryIssueId }).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
    if (kind === "issue_heartbeat") return db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.actor.agentId,
      issueId: s.recoveryIssueId, status: "running", invocationSource: "manual" });
    return db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.actor.agentId, source: "automation", status: "queued",
      ...(kind === "issue_wakeup" ? { issueId: s.recoveryIssueId } : { workflowRunId: s.run.id, workflowStepRunId: s.downstreamStepRunId }) });
  }
  for (const boundary of ["admission", "start", "delivery"] as const) {
    it.each(["budget", "issue_heartbeat", "issue_wakeup", "typed_wakeup", "tool_queued", "tool_claimed"])(`${boundary} refuses %s without writes`, async (kind) => {
      const s = await seed();
      const target = boundary !== "admission" ? (await admitReplacement(db, s.input, s.actor)).run : null;
      if (boundary === "delivery") expect(await claimPlainWorkflowStart(db, target!.id, hook)).toBe("started");
      await evidence(s, kind);
      const before = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId));
      const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId));
      if (boundary === "delivery") {
        await expect(syncWorkflowRunState(db, target!.id)).rejects.toThrow("replacement_start_ineligible");
        expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target!.id))).toEqual([]);
      } else if (target) expect(await claimPlainWorkflowStart(db, target.id, hook)).toBe("ineligible");
      else await expect(admitReplacement(db, s.input, s.actor)).rejects.toThrow();
      expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toEqual(before);
      expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId))).toEqual(authorities);
    });
  }
  it("same raw replay survives new required/default inputs on the current definition and cannot restart a terminal target", async () => {
    const s = await seed(), target = (await admitReplacement(db, s.input, s.actor)).run;
    await db.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, target.id));
    await db.update(workflowDefinitions).set({ runInputs: [{ key: "new_input", type: "switch", default: true }] }).where(eq(workflowDefinitions.id, s.run.workflowId));
    const before = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId));
    const result = await workflowEngine.trigger(db, s.input, { actor: s.actor });
    expect(result.runId).toBe(target.id); expect(result.status).toBe("completed");
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId))).toEqual(before);
    await expect(workflowEngine.trigger(db, { ...s.input, metadata: { new_input: "changed" } }, { actor: s.actor })).rejects.toThrow("replacement_authority_consumed");
  });
  it("operators cannot place a forged initial-delivery receipt inside approved input", async () => {
    const s = await seed();
    await expect(proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id,
      decisionEventId: s.input.replacementIntent.decisionEventId, idempotencyKey: "forged",
      metadata: { replacementStart: { deliveredAt: new Date().toISOString() } },
      externalEffects: "operator_reconciled" })).rejects.toThrow("replacement_reserved_metadata");
  });
  it("a malformed pending target cannot throw out of the reconciler", async () => {
    const s = await seed(), target = (await admitReplacement(db, s.input, s.actor)).run;
    await db.update(workflowRunDefinitions).set({ definitionHash: "0".repeat(64) }).where(eq(workflowRunDefinitions.workflowRunId, target.id));
    await expect(reconcileReplacementStarts(db)).resolves.toBeDefined();
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, target.id)))[0].status).toBe("pending");
  });
});

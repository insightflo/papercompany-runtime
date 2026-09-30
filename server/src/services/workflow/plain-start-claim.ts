import { and, eq, isNull, sql } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, workflowRecoveryAuthorities, type Db } from "@paperclipai/db";
import { validReplacementStart } from "./replacement-start-evidence.js";
import type { WorkflowRunStartHooks } from "./workflow-run-start.js";

// A pending status is not initial-start authority once any dispatch/recovery has occurred.
// Mission → run serializes cancellation with the pending→running single-winner claim.
export async function claimPlainWorkflowStart(db: Db, runId: string, hooks: WorkflowRunStartHooks) {
  return db.transaction(async (tx) => {
    const [observed] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!observed) return "ineligible" as const;
    if (observed.missionId) {
      const [mission] = await tx.select().from(missions).where(and(eq(missions.id, observed.missionId),
        eq(missions.companyId, observed.companyId))).for("update");
      if (!mission || !["planning", "active"].includes(mission.status)) return "ineligible" as const;
    }
    const [replacement] = await tx.select().from(workflowRecoveryAuthorities).where(and(
      eq(workflowRecoveryAuthorities.companyId, observed.companyId), eq(workflowRecoveryAuthorities.replacementRunId, runId))).limit(1);
    if (replacement) await tx.select().from(workflowRuns).where(eq(workflowRuns.id, replacement.workflowRunId)).for("update");
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    if (!run || run.missionId !== observed.missionId) return "ineligible" as const;
    if (run.status === "running") return "busy" as const;
    if (run.status !== "pending" || run.startedAt || run.completedAt || run.dispatchAuthorityVersion !== 0) return "ineligible" as const;
    const [used] = await tx.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, runId)).limit(1);
    const [step] = await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId)).limit(1);
    if (used || step || !await validReplacementStart(tx, run)) return "ineligible" as const;
    const startedAt = new Date();
    const [claimed] = await tx.update(workflowRuns).set({ status: "running", startedAt, completedAt: null,
      ...(replacement ? { metadata: { ...run.metadata, replacementStart: { schemaVersion: 1, authorityId: replacement.id,
        authorityVersion: 0, claimedAt: startedAt.toISOString(), deliveredAt: null } } } : {}) })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "pending"), isNull(workflowRuns.startedAt),
        sql`${workflowRuns.triggeredBy} <> 'workflow-step'`, isNull(workflowRuns.parentRunId), isNull(workflowRuns.parentStepRunId),
        sql`not exists (select 1 from workflow_step_invocations i where i.child_run_id = ${workflowRuns.id})`))
      .returning({ id: workflowRuns.id });
    if (!claimed) return "ineligible" as const;
    await hooks.activateMission(tx as unknown as Db, { companyId: run.companyId, missionId: run.missionId, workflowRunId: run.id, startedAt });
    return "started" as const;
  });
}

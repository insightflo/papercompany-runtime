import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { latestTerminalDecision, recoverTerminalRun } from "./run-recovery-authority.js";
import { evaluateRecoveryChannels } from "./run-terminal-recovery-gate.js";
import { isRunRecoveryServiceEnabled } from "./run-reopen-guard-flag.js";
import { resumeWorkflowRun } from "./workflow-store.js";
import { HttpError } from "../../errors.js";

export async function acceptSourceIssueRecovery(db: Db, input: {
  run: typeof workflowRuns.$inferSelect; stepRunId: string; issueId: string;
}) {
  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const run = await lockUnreplacedRun(t, input.run.id, input.run.companyId);
      if (!run || run.status !== "failed" || run.dispatchAuthorityVersion !== input.run.dispatchAuthorityVersion) return null;
      const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).for("update");
      const step = steps.find((s) => s.id === input.stepRunId && s.issueId === input.issueId);
      if (!step || step.status !== "failed") return null;
      const decision = await latestTerminalDecision(t, run.id, run.companyId);
      let official = false;
      if (await isRunRecoveryServiceEnabled(t) && decision) {
        if (decision.decidedAuthorityVersion !== run.dispatchAuthorityVersion) return null;
        const gate = await evaluateRecoveryChannels(t, { runId: run.id, companyId: run.companyId, missionId: run.missionId, stepRuns: steps, now: new Date() });
        if (gate.kind !== "open") return null;
        const recovery = await recoverTerminalRun(t, { runId: run.id, companyId: run.companyId,
          expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedDecision: "failed", recoveryKind: "source_issue_unblock",
          requestReference: input.issueId, requestedBy: "source_issue_unblock", now: new Date() });
        if (recovery.kind !== "recovered") return null;
        official = true;
      } else if (!await resumeWorkflowRun(t, run.id, run.companyId)) return null;
      const [changed] = await tx.update(workflowStepRuns).set({ status: "running", completedAt: null })
        .where(and(eq(workflowStepRuns.id, step.id), eq(workflowStepRuns.status, "failed"))).returning();
      if (!changed) throw new Error("source_issue_recovery_cas_lost");
      const [updated] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
      return { run: updated, official };
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return null;
    throw error;
  }
}

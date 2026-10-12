import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { latestTerminalDecision, recoverTerminalRun } from "./run-recovery-authority.js";
import { evaluateRecoveryChannels } from "./run-terminal-recovery-gate.js";
import { isRunRecoveryServiceEnabled } from "./run-reopen-guard-flag.js";
import { resumeWorkflowRun } from "./workflow-store.js";
import { HttpError } from "../../errors.js";
import type { AutomaticSourceRecovery } from "./source-issue-native-resume.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function acceptSourceIssueRecovery(db: Db, input: {
  run: typeof workflowRuns.$inferSelect; stepRunId: string; issueId: string;
  /** [owner automatic] exact failure + 현재 intent 검증 — legacy board resume fallback 미사용. */
  ownerExecution?: AutomaticSourceRecovery;
}) {
  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const run = await lockUnreplacedRun(t, input.run.id, input.run.companyId);
      if (!run || run.status !== "failed" || run.dispatchAuthorityVersion !== input.run.dispatchAuthorityVersion) return null;
      const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id)).for("update");
      const step = steps.find((s) => s.id === input.stepRunId && s.issueId === input.issueId);
      if (!step || step.status !== "failed") return null;
      let receipt: { authorityId: string; authorityVersion: number; executionGeneration: number } | null = null;
      if (input.ownerExecution) {
        const oe = input.ownerExecution;
        // exact failure identity + 현재 intent 를 같은 lock 하에서 재확인(상한 소진도 차단).
        if (run.id !== oe.workflowRunId || run.missionId !== oe.missionId || input.stepRunId !== oe.stepRunId
          || run.dispatchAuthorityVersion !== oe.expectedAuthorityVersion
          || step.executionGeneration !== oe.expectedExecutionGeneration
          || step.lastDispatchRequestId !== oe.failedDispatchRequestId
          || record(step.metadata).workflowRetryExhaustion || !await oe.validateIntent(t)) return null;
      }
      const serviceEnabled = await isRunRecoveryServiceEnabled(t);
      const decision = await latestTerminalDecision(t, run.id, run.companyId);
      if (input.ownerExecution && (!serviceEnabled || !decision)) return null; // no legacy fallback
      let official = false;
      if (serviceEnabled && decision) {
        if (decision.decidedAuthorityVersion !== run.dispatchAuthorityVersion) return null;
        const gate = await evaluateRecoveryChannels(t, { runId: run.id, companyId: run.companyId, missionId: run.missionId, stepRuns: steps, now: new Date() });
        if (gate.kind !== "open") return null;
        const recovery = await recoverTerminalRun(t, { runId: run.id, companyId: run.companyId,
          expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedDecision: "failed",
          recoveryKind: input.ownerExecution ? "supervision_tool_retry" : "source_issue_unblock",
          requestReference: input.ownerExecution ? `mission-owner-execute:${input.ownerExecution.actionId}` : input.issueId,
          requestedBy: input.ownerExecution ? "mission_owner_execute" : "source_issue_unblock", now: new Date() });
        if (recovery.kind !== "recovered") return null;
        official = true;
        if (input.ownerExecution) receipt = { authorityId: recovery.authority.id,
          authorityVersion: recovery.authority.resultingAuthorityVersion,
          executionGeneration: input.ownerExecution.expectedExecutionGeneration + 1 };
      } else if (!await resumeWorkflowRun(t, run.id, run.companyId)) return null;
      const [changed] = await tx.update(workflowStepRuns).set({ status: "running", completedAt: null,
        ...(receipt ? { metadata: { ...record(step.metadata), ownerToolRetry: { schemaVersion: 1, ...receipt } } } : {}) })
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

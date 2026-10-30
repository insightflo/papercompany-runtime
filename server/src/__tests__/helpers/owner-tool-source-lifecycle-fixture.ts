import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  heartbeatRuns, issues, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { seedToolRecoveryScenario } from "./tool-recovery-scenario.js";
import { buildMissionSupervisionContext } from "../../services/missions/mission-supervision-context.js";
import { recordMissionOwnerDecision } from "../../services/missions/mission-owner-recovery-ledger.js";
import type { completeWorkflowToolStepFromResult } from "../../services/workflow/dag-engine.js";
import type { captureExecutionDefinition } from "../../services/workflow/execution-definition.js";
import { canonicalRows, snapshotLifecycleState, snapshotNativeDownstreamState } from "./owner-tool-source-lifecycle-observation.js";

type Scenario = Awaited<ReturnType<typeof seedToolRecoveryScenario>>;

type FixtureDependencies = {
  getDb: () => Db;
  roots: string[];
  assignmentPromises: Promise<unknown>[];
  completeToolStep: typeof completeWorkflowToolStepFromResult;
  captureDefinition: typeof captureExecutionDefinition;
  assertCompletion: (result: unknown) => void;
};

/** Shared real-Postgres fixture setup; all database and test-barrier dependencies are passed by the test. */
export function createOwnerToolSourceLifecycleFixture(deps: FixtureDependencies) {
  async function seedRecovered(cardStatus: "todo" | "done" = "done", snapshot = false, failedSource = false) {
    const db = deps.getDb();
    const s = await seedToolRecoveryScenario({ db, artifactExists: true }); deps.roots.push(s.tempRoot);
    const [originalRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const requestId = randomUUID(), attemptedAt = originalRun.createdAt, failedAt = new Date();
    if (snapshot) {
      await db.update(workflowRuns).set({ status: "pending", startedAt: null, completedAt: null,
        metadata: { executionDefinitionVersion: 1 } }).where(eq(workflowRuns.id, s.workflowRunId));
      await db.transaction(tx => deps.captureDefinition(tx, s.workflowRunId));
    }
    await db.update(workflowRuns).set(failedSource
      ? { status: "failed", startedAt: attemptedAt, completedAt: failedAt,
        ...(snapshot ? { metadata: { executionDefinitionVersion: 1 } } : {}) }
      : { status: "running", startedAt: attemptedAt, completedAt: null, dispatchAuthorityVersion: 2,
        ...(snapshot ? { metadata: { executionDefinitionVersion: 1 } } : {}) }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set(failedSource
      ? { startedAt: attemptedAt, completedAt: failedAt }
      : { status: "running", startedAt: attemptedAt, completedAt: null,
      lastDispatchRequestId: requestId, lastDispatchAttemptAt: attemptedAt, lastDispatchAcceptedAt: attemptedAt,
      metadata: { toolInvocation: { requestId, toolName: "collect-us-stockflow", queuedAt: attemptedAt.toISOString() },
        toolQueue: { status: "queued", queuedAt: attemptedAt.toISOString() } } }).where(eq(workflowStepRuns.id, s.stepRunId));
    await db.update(issues).set({ status: cardStatus }).where(eq(issues.id, s.recoveryIssueId));
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: s.companyId, agentId: s.ownerAgentId,
      issueId: s.recoveryIssueId, status: "succeeded" });
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.recoveryIssueId, workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${s.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: s.workflowRunId, stepRunId: s.stepRunId } });
    if (failedSource) {
      await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        decidedAuthorityVersion: originalRun.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
        discoveryPath: "stuck_diagnostic", origin: "reconciler" });
      return s;
    }
    const completed = await deps.completeToolStep(db, { companyId: s.companyId, workflowRunId: s.workflowRunId,
      stepRunId: s.stepRunId, stepId: "collect-us-stockflow", requestId, toolName: "collect-us-stockflow",
      success: true, exitCode: 0, artifactPath: s.artifactPath });
    deps.assertCompletion(completed);
    await Promise.all(deps.assignmentPromises.splice(0));
    return s;
  }

  async function context(s: Scenario) {
    const c = await buildMissionSupervisionContext(deps.getDb(), { missionId: s.missionId });
    const issue = c.missionIssueById.get(s.recoveryIssueId)!;
    return { c, issue, sourceIssue: c.missionIssueById.get(issue.originId!)! };
  }

  async function ownerRetryState(s: Scenario) {
    const db = deps.getDb();
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const authorities = canonicalRows(await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId)));
    const events = canonicalRows(await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, s.stepRunId)));
    return { run, stepRun, authorities, outcomes: events.filter(event => event.payload?.schema === "recovery_outcome.v1") };
  }

  async function decide(s: Scenario, target: Record<string, unknown>) {
    const db = deps.getDb();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.recoveryIssueId));
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: s.companyId, agentId: s.ownerAgentId,
      issueId: s.recoveryIssueId, status: "succeeded" });
    const recoveryTarget = missionOwnerDecisionSubmitSchema.parse({ decision: "retry_source_issue", recoveryTarget: target }).recoveryTarget!;
    await recordMissionOwnerDecision({ db, issue: { id: issue.id, companyId: s.companyId, missionId: s.missionId },
      heartbeatRunId, sourceIssueId: issue.originId, submission: { decision: "retry_source_issue", recoveryTarget } });
  }

  async function currentTarget(s: Scenario) {
    const db = deps.getDb();
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    return { kind: "tool_step", workflowRunId: run.id, stepRunId: step.id,
      expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedExecutionGeneration: step.executionGeneration,
      failedDispatchRequestId: step.lastDispatchRequestId };
  }

  return { seedRecovered, context, decide, currentTarget,
    lifecycleState: (s: Scenario) => snapshotLifecycleState(deps.getDb(), s), ownerRetryState,
    nativeDownstreamState: (s: Scenario) => snapshotNativeDownstreamState(deps.getDb(), s) };
}

export function successfulAdapterResult(): AdapterExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

/** Pause only at the external adapter call; native wake persistence and claim still run. */
export function createNativeAdapterBoundary() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { entered, release: () => release(), execute: async () => {
    enter(); await gate; return successfulAdapterResult();
  } };
}

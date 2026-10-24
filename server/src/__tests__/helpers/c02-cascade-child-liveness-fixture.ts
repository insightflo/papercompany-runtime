import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  heartbeatRuns, issueComments, issues, missionAgentRuntimes, missions, workflowDefinitions,
  workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTerminalDecisions,
  workflowTerminalEffectIntents, type Db,
} from "@paperclipai/db";
import {
  commitDbState, createCommitSourceHarness, makeCommitSource, type CommitSourceCase,
} from "../qa-correction-commit-fixture.js";
import { issueC02 } from "./c02-fixture.js";
import { modes, observe, settle, type Mode, type Observed } from "./failure-cascade-atomicity-fixture.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { readQaCorrectionLiveness } from "../../services/workflow/control-flow/qa-correction-liveness.js";
import { lockCascadeObservation } from "../../services/workflow/failure-cascade-writes.js";
import { loadWorkflowExecutionContext } from "../../services/workflow/workflow-execution-context.js";
import { finalizeWorkflowRunState } from "../../services/workflow/workflow-run-finalization.js";
import { resolveWorkflowRunFinalizationGate } from "../../services/workflow/workflow-cancel-bridge.js";

export { modes, observe, settle };
export type { Mode };
export type Phase = "none" | "prepared" | "applied" | "unknown";
export type Harness = Awaited<ReturnType<typeof createCommitSourceHarness>> & {
  issuer: Db; worker: Db; observer: Db;
};
export type Case = { s: CommitSourceCase; phase: Phase; requestId?: string };
export const scope = (c: Case) => ({ companyId: c.s.p.companyId, runId: c.s.p.workflowRunId });

export async function createHarness() {
  const owned = await createCommitSourceHarness();
  try {
    // Open both transactions at once: these are physical PostgreSQL sessions, not PGlite/mocks.
    const peer = owned.connect();
    await owned.db.transaction(async left => {
      const [a] = await left.execute(sql`SELECT pg_backend_pid() AS pid, current_setting('data_directory') AS dir`);
      if (!path.basename(String(a!.dir)).startsWith("qa-correction-authority-")) {
        throw Error("Expected the correction harness's owned PostgreSQL");
      }
      await peer.transaction(async right => {
        const [b] = await right.execute(sql`SELECT pg_backend_pid() AS pid`);
        if (Number(a!.pid) === Number(b!.pid)) throw Error("Distinct PostgreSQL sessions required");
      });
    });
    return { ...owned, issuer: peer, worker: owned.db, observer: owned.connect() };
  } catch (error) {
    await owned.close();
    throw error;
  }
}

export async function makeCase(owned: Harness, phase: Phase): Promise<Case> {
  const peer = owned.issuer;
  let s: CommitSourceCase, requestId: string | undefined;
  if (phase === "applied") {
    // Reuse the actual begin -> measure -> store -> commit path on the peer connection.
    const issued = await issueC02({ ...owned, db: peer, connect: () => owned.observer }, { mode: "content-only" });
    s = issued.s;
    requestId = issued.ref.requestId;
  } else {
    s = await makeCommitSource(peer, owned.root, "content-only");
    if (phase !== "none") {
      const prepared = await beginQaCorrection(peer, s.p);
      if (prepared.status !== "prepared") throw Error("Real preparation required: " + prepared.status);
      s.p = prepared.preparation;
    }
  }
  const [heartbeat] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId));
  await peer.insert(missionAgentRuntimes).values({
    companyId: s.p.companyId, missionId: s.p.missionId, agentId: heartbeat!.agentId,
    adapterType: "process", runtimeKey: s.p.workflowRunId, currentIssueId: s.p.producer.issueId,
    status: "ready", processPid: null,
  });
  return { s, phase, requestId };
}

export async function addCascadeTargets(c: Case, hold: boolean) {
  const { s } = c, db = s.db;
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
  if (!run) throw Error("Correction run missing");
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  if (!definition) throw Error("Correction definition missing");
  const targets = hold ? ["after", "held"] : ["after"];
  for (const stepId of targets) {
    const [issue] = await db.insert(issues).values({
      companyId: s.p.companyId, missionId: s.p.missionId, title: stepId,
      status: stepId === "held" ? "blocked" : "todo", originKind: "workflow_execution",
    }).returning();
    await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId, issueId: issue!.id, status: "pending", metadata: { keep: stepId },
    });
  }
  await db.update(workflowDefinitions).set({
    stepsJson: [...definition.stepsJson as Record<string, unknown>[], ...targets.map(id => ({
      id, name: id, dependencies: [s.f.qa.stepId],
    }))],
  }).where(eq(workflowDefinitions.id, definition.id));
}

/** Precondition only, never the test oracle: prevent stale_observation from masquerading as protection. */
export async function confirmCurrent(db: Db, o: Observed, mode: Mode) {
  const boundaryEnabled = mode.endsWith("-on");
  const result = await db.transaction(tx => lockCascadeObservation(tx, mode.startsWith("stuck")
    ? { kind: "stuck", run: o.run, pendingSteps: o.pending,
      boundaryStepRuns: boundaryEnabled ? o.steps : [], boundaryEnabled }
    : { kind: "deadlock", run: o.run, stepsToSkip: o.selected, runSteps: o.steps,
      boundaryEnabled, mayFinalize: !mode.startsWith("hold") }));
  if (result !== "current") throw Error("Cascade fixture did not reach the current path: " + result);
}

export function liveness(db: Db, c: Case) {
  return db.transaction(async tx => {
    const [run] = await tx.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, c.s.p.workflowRunId), eq(workflowRuns.companyId, c.s.p.companyId),
    )).for("update");
    if (!run) throw Error("Locked correction run missing");
    return readQaCorrectionLiveness(tx, run);
  });
}

/** Full independent SQL snapshot includes legitimate peer changes before the tested action. */
export function state(db: Db, c: Case) {
  return db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const companyId = c.s.p.companyId;
    const runs = await tx.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)).orderBy(workflowRuns.id);
    return {
      correction: await commitDbState({ ...c.s, db: tx as unknown as Db }),
      runs,
      steps: await tx.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runs.map(r => r.id)))
        .orderBy(workflowStepRuns.id),
      invocations: await tx.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId))
        .orderBy(workflowStepInvocations.id),
      issues: await tx.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(issues.id),
      comments: await tx.select().from(issueComments).where(eq(issueComments.companyId, companyId)).orderBy(issueComments.id),
      missions: await tx.select().from(missions).where(eq(missions.companyId, companyId)).orderBy(missions.id),
      runtimes: await tx.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.companyId, companyId))
        .orderBy(missionAgentRuntimes.id),
      decisions: await tx.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.companyId, companyId))
        .orderBy(workflowTerminalDecisions.id),
      effects: await tx.select().from(workflowTerminalEffectIntents).where(eq(workflowTerminalEffectIntents.companyId, companyId))
        .orderBy(workflowTerminalEffectIntents.id),
    };
  });
}

/**
 * Bind the correction run itself, not a different child generated by insertLinkedInvocation.
 * Existing real step rows + a fixture materialization receipt are not provider-execution evidence.
 */
export async function linkCorrectionRun(c: Case) {
  const { s } = c, parentRunId = randomUUID(), parentStepRunId = randomUUID(), invocationId = randomUUID();
  await s.db.transaction(async tx => {
    const [child] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
    if (!child) throw Error("Child correction run missing");
    const [definition] = await tx.insert(workflowDefinitions).values({
      companyId: s.p.companyId, name: "C02 correction parent",
      stepsJson: [{ id: "run-child", name: "Run correction child", type: "workflow",
        targetWorkflowId: child.workflowId, dependencies: [] }],
    }).returning();
    await tx.insert(workflowRuns).values({
      id: parentRunId, companyId: s.p.companyId, missionId: s.p.missionId,
      workflowId: definition!.id, status: "running", triggeredBy: "test",
    });
    await tx.insert(workflowStepRuns).values({
      id: parentStepRunId, workflowRunId: parentRunId, stepId: "run-child",
      status: "pending", retryCount: 0, metadata: {},
    });
    await tx.update(workflowRuns).set({
      parentRunId, parentStepRunId, rootRunId: parentRunId,
      triggeredBy: "workflow-step", triggerSource: "workflow", childStartMaterializedAt: new Date(),
    }).where(eq(workflowRuns.id, child.id));
    await tx.insert(workflowStepInvocations).values({
      id: invocationId, companyId: s.p.companyId, parentStepRunId, childRunId: child.id,
      state: "linked", generation: 1, targetWorkflowId: child.workflowId,
    });
  });
  return { parentRunId, parentStepRunId, invocationId };
}

export async function linkedGate(db: Db, c: Case, nextStatus: string) {
  const gate = await resolveWorkflowRunFinalizationGate(db, {
    runId: c.s.p.workflowRunId, companyId: c.s.p.companyId, nextStatus,
  });
  if (gate.kind !== "linked") throw Error("Actual linked gate required: " + gate.kind);
  return gate;
}

export async function terminalSnapshot(db: Db, c: Case, outcome: "completed" | "failed") {
  await c.s.db.update(workflowStepRuns).set({ status: outcome }).where(eq(workflowStepRuns.id, c.s.f.qa.id));
  const context = await loadWorkflowExecutionContext(db, c.s.p.workflowRunId);
  // The peer restores the actual correction-eligible state after the caller's terminal observation.
  await c.s.db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, c.s.f.qa.id));
  return context;
}

export function finalizeChild(db: Db, context: Awaited<ReturnType<typeof terminalSnapshot>>) {
  return finalizeWorkflowRunState(db, context, context.stepRuns, false, true, {
    normalizeRecord: value => value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : {},
    getDynamicLaunchStepIds: () => undefined,
    buildWorkflowDefinitionExecutionShape: current => ({ name: current.definition.name, steps: current.steps }),
  });
}

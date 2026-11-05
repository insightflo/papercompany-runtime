import { and, eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import {
  missions, workflowRuns, workflowStepInvocations, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { findChildStartIdentityForRun, lockChildStartIdentityRows, type ChildStartIdentity, type LockedChildStartRows, type WorkflowTx } from "./workflow-child-start-state.js";
import type { TransactionDb } from "./execution-definition.js";

type MissionRow = typeof missions.$inferSelect;
type RunRow = typeof workflowRuns.$inferSelect;
type StepRow = typeof workflowStepRuns.$inferSelect;

export type ExpectedWorkflowToolScope =
  | Readonly<{
      kind: "plain";
      companyId: string;
      workflowRunId: string;
      missionId: string | null;
    }>
  | Readonly<{
      kind: "linked";
      companyId: string;
      workflowRunId: string;
      missionId: null;
      identity: Readonly<ChildStartIdentity>;
      parentMissionId: string | null;
      targetWorkflowId: string;
    }>;

/** Raw locked rows are context only. They do not authorize sending or a result disposition. */
export type RawWorkflowToolScope = Readonly<{
  tx: TransactionDb;
  expected: ExpectedWorkflowToolScope;
  mission: MissionRow | null;
  run: RunRow | null;
  steps: readonly StepRow[];
  child: LockedChildStartRows | null;
  scopeIssue: string | null;
}>;

export type LegacyStructuralScopeDiscovery =
  | Readonly<{ kind: "ready"; expected: ExpectedWorkflowToolScope }>
  | Readonly<{ kind: "held"; reason: string }>;

type ScopeWork<T> = (scope: RawWorkflowToolScope) => Promise<T>;

async function setLockTimeouts(tx: WorkflowTx): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', '500ms', true), set_config('statement_timeout', '5s', true)`);
}

async function lockMission(tx: WorkflowTx, companyId: string, missionId: string | null): Promise<MissionRow | null> {
  if (!missionId) return null;
  const [mission] = await tx.select().from(missions).where(and(
    eq(missions.id, missionId), eq(missions.companyId, companyId),
  )).for("update").limit(1);
  return mission ?? null;
}

async function lockPlainScope(tx: WorkflowTx, expected: Extract<ExpectedWorkflowToolScope, { kind: "plain" }>): Promise<RawWorkflowToolScope> {
  const mission = await lockMission(tx, expected.companyId, expected.missionId);
  const base = { tx: tx as unknown as TransactionDb, expected, mission, run: null, steps: [], child: null };
  if (expected.missionId && !mission) return { ...base, scopeIssue: "mission_missing_or_scope" };

  const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, expected.workflowRunId)).for("update").limit(1);
  if (!run) return { ...base, scopeIssue: "run_missing_or_scope" };
  if (run.missionId !== expected.missionId) return { ...base, run, scopeIssue: "run_mission_changed" };
  if (run.parentRunId || run.parentStepRunId || run.triggeredBy === "workflow-step") {
    return { ...base, run, scopeIssue: "linked_capture_missing" };
  }
  if (run.companyId !== expected.companyId) return { ...base, run, scopeIssue: "run_missing_or_scope" };
  const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
    .orderBy(workflowStepRuns.stepId, workflowStepRuns.id).for("update");
  return { ...base, run, steps, scopeIssue: null };
}

async function lockLinkedScope(tx: WorkflowTx, expected: Extract<ExpectedWorkflowToolScope, { kind: "linked" }>): Promise<RawWorkflowToolScope> {
  const empty = { tx: tx as unknown as TransactionDb, expected, mission: null, run: null, steps: [], child: null };
  const identity: ChildStartIdentity = { ...expected.identity };
  if (identity.companyId !== expected.companyId || identity.childRunId !== expected.workflowRunId || identity.generation !== 1) {
    return { ...empty, scopeIssue: "linked_capture_invalid" };
  }

  const [discovered] = await tx.select({ companyId: workflowRuns.companyId, missionId: workflowRuns.missionId })
    .from(workflowRuns).where(eq(workflowRuns.id, identity.parentRunId)).limit(1);
  if (!discovered || discovered.companyId !== expected.companyId || discovered.missionId !== expected.parentMissionId) {
    return { ...empty, scopeIssue: "parent_mission_changed" };
  }
  const mission = await lockMission(tx, expected.companyId, expected.parentMissionId);
  const beforeParent = { ...empty, mission };
  if (expected.parentMissionId && !mission) return { ...beforeParent, scopeIssue: "parent_mission_missing" };

  const child = await lockChildStartIdentityRows(tx, identity);
  const base = { ...beforeParent, child, run: child.child };
  if (!child.parent || !child.invocation || !child.parentStep || !child.child) {
    return { ...base, scopeIssue: "linked_identity_missing" };
  }
  if (child.parent.missionId !== expected.parentMissionId) return { ...base, scopeIssue: "parent_mission_changed" };
  if (child.child.missionId !== null) return { ...base, scopeIssue: "child_mission_unsupported" };
  const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, child.child.id))
    .orderBy(workflowStepRuns.stepId, workflowStepRuns.id).for("update");
  return { ...base, steps, scopeIssue: null };
}

/** Open the single root transaction and acquire the shared raw prefix before calling the owner. */
export async function withWorkflowToolLockScope<T>(
  db: Db,
  expected: ExpectedWorkflowToolScope,
  work: ScopeWork<T>,
): Promise<T> {
  if (is(db, PgTransaction)) throw new Error("workflow_tool_lock_scope_requires_root_db");
  return db.transaction(async (tx) => {
    const txHandle = tx as unknown as WorkflowTx;
    await setLockTimeouts(txHandle);
    const scope = expected.kind === "plain"
      ? await lockPlainScope(txHandle, expected)
      : await lockLinkedScope(txHandle, expected);
    return work(scope);
  });
}

function held(reason: string): LegacyStructuralScopeDiscovery {
  return { kind: "held", reason };
}

async function missionBelongsToCompany(db: Db, companyId: string, missionId: string | null): Promise<boolean> {
  if (missionId === null) return true;
  const [mission] = await db.select({ id: missions.id }).from(missions).where(and(
    eq(missions.id, missionId), eq(missions.companyId, companyId),
  )).limit(1);
  return !!mission;
}

/** Discover a legacy run's immutable raw lock branch before the caller takes any workflow locks. */
export async function discoverLegacyStructuralScope(
  db: Db,
  input: Readonly<{ companyId: string; workflowRunId: string }>,
): Promise<LegacyStructuralScopeDiscovery> {
  if (is(db, PgTransaction)) throw new Error("legacy_structural_scope_discovery_requires_root_db");
  const [run] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId),
  )).limit(1);
  if (!run) return held("legacy_run_missing_or_scope");

  if (!(await missionBelongsToCompany(db, input.companyId, run.missionId))) return held("legacy_mission_missing_or_scope");
  const [linkedInvocation] = await db.select({ id: workflowStepInvocations.id }).from(workflowStepInvocations).where(and(
    eq(workflowStepInvocations.childRunId, run.id), eq(workflowStepInvocations.state, "linked"),
  )).limit(1);
  const hasChildHints = !!run.parentRunId || !!run.parentStepRunId || run.triggeredBy === "workflow-step" || !!linkedInvocation;
  if (!hasChildHints) {
    return { kind: "ready", expected: { kind: "plain", companyId: input.companyId, workflowRunId: run.id, missionId: run.missionId } };
  }

  const found = await findChildStartIdentityForRun(db, run.id);
  if (!found) return held("legacy_linked_identity_missing");
  const identity = found.identity;
  if (identity.companyId !== input.companyId || identity.childRunId !== run.id || identity.generation !== 1 ||
      run.triggeredBy !== "workflow-step" || run.parentRunId !== identity.parentRunId ||
      run.parentStepRunId !== identity.parentStepRunId || run.missionId !== null) {
    return held("legacy_linked_identity_inconsistent");
  }

  const [parent] = await db.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId })
    .from(workflowRuns).where(eq(workflowRuns.id, identity.parentRunId)).limit(1);
  const [parentStep] = await db.select({ id: workflowStepRuns.id,
    workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId,
  }).from(workflowStepRuns).where(eq(workflowStepRuns.id, identity.parentStepRunId)).limit(1);
  const [invocation] = await db.select().from(workflowStepInvocations).where(and(
    eq(workflowStepInvocations.id, identity.invocationId), eq(workflowStepInvocations.companyId, input.companyId),
  )).limit(1);
  if (!parent || parent.companyId !== input.companyId || !parentStep ||
      parentStep.workflowRunId !== parent.id || parentStep.stepId !== identity.stepId || !invocation ||
      invocation.state !== "linked" || invocation.parentStepRunId !== parentStep.id || invocation.childRunId !== run.id ||
      invocation.generation !== identity.generation || invocation.targetWorkflowId !== run.workflowId) {
    return held("legacy_linked_identity_inconsistent");
  }
  if (!(await missionBelongsToCompany(db, input.companyId, parent.missionId))) return held("legacy_parent_mission_missing_or_scope");

  return {
    kind: "ready",
    expected: {
      kind: "linked", companyId: input.companyId, workflowRunId: run.id, missionId: null,
      identity, parentMissionId: parent.missionId, targetWorkflowId: invocation.targetWorkflowId,
    },
  };
}

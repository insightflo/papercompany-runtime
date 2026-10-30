import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issues, workflowRecoveryAuthorities,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { seedToolRecoveryScenario } from "./tool-recovery-scenario.js";

type Scenario = Awaited<ReturnType<typeof seedToolRecoveryScenario>>;
type CapturedSqlWrite = { operation: string; table: string; columns: string[]; parameters: unknown[] };

export function canonicalRows<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

export async function snapshotLifecycleState(db: Db, s: Scenario) {
  const run = canonicalRows(await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)));
  const steps = canonicalRows(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId)));
  const runIssues = canonicalRows(await db.select().from(issues).where(and(
    eq(issues.companyId, s.companyId), eq(issues.originRunId, s.workflowRunId))));
  const missionIssues = canonicalRows(await db.select().from(issues).where(and(
    eq(issues.companyId, s.companyId), eq(issues.missionId, s.missionId))));
  const issueIds = missionIssues.map(issue => issue.id), stepIds = steps.map(step => step.id);
  const runWakes = canonicalRows(await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.workflowRunId, s.workflowRunId))));
  const cardWakes = canonicalRows(await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.issueId, s.recoveryIssueId))));
  const missionWakes = canonicalRows(await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, s.companyId), eq(agentWakeupRequests.missionId, s.missionId))));
  const heartbeats = canonicalRows(await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), eq(heartbeatRuns.workflowStepRunId, s.downstreamStepRunId))));
  const missionHeartbeats = canonicalRows(await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, s.companyId), inArray(heartbeatRuns.issueId, issueIds))));
  const wakeIds = missionWakes.map(wake => wake.id), heartbeatIds = missionHeartbeats.map(run => run.id);
  const comments = canonicalRows((await db.select({ comment: issueComments }).from(issueComments)
    .innerJoin(issues, eq(issueComments.issueId, issues.id)).where(and(
      eq(issueComments.companyId, s.companyId), eq(issues.companyId, s.companyId), eq(issues.missionId, s.missionId))))
    .map(row => row.comment));
  const entityIds = [...new Set([s.missionId, s.workflowRunId, ...stepIds, ...issueIds])];
  const activities = canonicalRows(await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId), or(
    inArray(activityLog.entityId, entityIds), inArray(activityLog.runId, heartbeatIds)))));
  const events = canonicalRows(await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, s.companyId), or(eq(workflowTransitionEvents.missionId, s.missionId),
      eq(workflowTransitionEvents.workflowRunId, s.workflowRunId), inArray(workflowTransitionEvents.workflowStepRunId, stepIds),
      inArray(workflowTransitionEvents.issueId, issueIds), inArray(workflowTransitionEvents.wakeupRequestId, wakeIds),
      inArray(workflowTransitionEvents.heartbeatRunId, heartbeatIds)))));
  const authorities = canonicalRows(await db.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId)));
  return { run, steps, runIssues, missionIssues, runWakes, cardWakes, missionWakes, heartbeats,
    missionHeartbeats, comments, activities, authorities, events };
}

export async function snapshotNativeDownstreamState(db: Db, s: Scenario) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
  const [sourceStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
  const [downstreamStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
  const wakes = downstreamStep.issueId ? canonicalRows(await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.issueId, downstreamStep.issueId))) : [];
  const wakeIds = wakes.map(wake => wake.id);
  const heartbeats = wakeIds.length ? canonicalRows(await db.select().from(heartbeatRuns)
    .where(inArray(heartbeatRuns.wakeupRequestId, wakeIds))) : [];
  return { run, sourceStep, downstreamStep, wakes, heartbeats };
}

function parseSqlWrites(statement: string, parameters: unknown[]): CapturedSqlWrite[] {
  const pattern = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:"([A-Za-z_][\w$]*)"|([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?))/gi;
  return [...statement.matchAll(pattern)].flatMap(match => {
    const operation = match[1]!.toUpperCase().startsWith("INSERT") ? "INSERT"
      : match[1]!.toUpperCase().startsWith("DELETE") ? "DELETE"
        : match[1]!.toUpperCase().startsWith("TRUNCATE") ? "TRUNCATE"
          : match[1]!.toUpperCase().startsWith("MERGE") ? "MERGE" : "UPDATE";
    const end = match.index! + match[0].length;
    if (operation === "UPDATE" && !/^\s+SET\b/i.test(statement.slice(end))) return [];
    const table = (match[2] ?? match[3]!).split(".").at(-1)!;
    const clause = statement.slice(end);
    const columns = operation === "INSERT"
      ? clause.match(/^\s*\(([^)]+)\)/)?.[1]?.split(",").map(value => value.trim().replaceAll('"', "")) ?? []
      : operation === "UPDATE"
        ? (clause.match(/^\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|\s+RETURNING\b|$)/i)?.[1] ?? "")
          .split(",").map(value => value.split("=")[0]!.trim().replaceAll('"', "")).filter(Boolean)
        : [];
    return [{ operation, table, columns, parameters }];
  });
}

export async function captureBoundedSqlWrites<T>(db: Db, action: () => Promise<T>) {
  const writes: CapturedSqlWrite[] = [], failures: string[] = [];
  const client = db.$client as unknown as { unsafe: (...args: unknown[]) => unknown };
  const original = client.unsafe;
  client.unsafe = (...args: unknown[]) => {
    const statement = args[0], parameters = Array.isArray(args[1]) ? args[1] as unknown[] : [];
    if (typeof statement !== "string") failures.push("SQL statement was not captured as text");
    else {
      if (statement.length > 4096 || parameters.length > 64 || JSON.stringify(parameters).length > 8192) failures.push("SQL capture limit exceeded");
      else writes.push(...parseSqlWrites(statement, parameters.slice()));
      if (writes.length > 32) failures.push("SQL write count exceeded");
    }
    return Reflect.apply(original, client, args);
  };
  try {
    const value = await action();
    if (failures.length) throw new Error(failures.join(", "));
    return { value, writes };
  } finally { client.unsafe = original; }
}

export async function captureSixSupervisions<T>(db: Db, supervise: () => Promise<T>) {
  const sequential: Array<{ value: T; writes: CapturedSqlWrite[] }> = [];
  for (let index = 0; index < 4; index++) sequential.push(await captureBoundedSqlWrites(db, supervise));
  const concurrent = await captureBoundedSqlWrites(db, () => Promise.all([supervise(), supervise()]));
  return { results: [...sequential.map(call => call.value), ...concurrent.value],
    writes: [...sequential.map(call => call.writes), concurrent.writes] };
}

export function supervisionDiagnosticMarker(missionId: string, now: Date, findings: string[]): string {
  const signature = createHash("sha256").update(findings.slice().sort().join("\n")).digest("hex").slice(0, 16);
  return `mission-owner-supervision:${missionId}:${now.toISOString().slice(0, 13)}:${signature}`;
}

type LifecycleSnapshot = Awaited<ReturnType<typeof snapshotLifecycleState>>;
type NativeObservation = {
  missionId: string; oversightIssueId: string | null; findings: string[]; commented: boolean; appliedActions: unknown[];
  recommendations: Array<{ type: string; safeToAutoApply: boolean; reason: string }>;
  recoveryOutcomes?: Array<{ kind?: string; reason?: string; outcome?: string }>;
};

export function assertNativeSupervisionEffects(input: {
  before: LifecycleSnapshot; after: LifecycleSnapshot; sourceBefore: LifecycleSnapshot["steps"][number];
  sourceAfter: LifecycleSnapshot["steps"][number]; artifactPath: string;
  artifactBefore: ReturnType<typeof artifactDigest>; artifactAfter: ReturnType<typeof artifactDigest>;
  observations: NativeObservation[]; writes: CapturedSqlWrite[][]; companyId: string; missionId: string;
  missionTitle: string; ownerAgentId: string; now: Date;
}) {
  const { before, after, sourceBefore, sourceAfter, artifactBefore, artifactAfter, observations } = input;
  assert.equal(observations.length, 6);
  const first = observations[0]!;
  assert.ok(first.oversightIssueId);
  assert.deepStrictEqual(observations.map(row => ({ missionId: row.missionId, oversightIssueId: row.oversightIssueId,
    findings: row.findings, recommendations: row.recommendations, commented: row.commented, appliedActions: row.appliedActions })),
  Array.from({ length: 6 }, (_, index) => ({ missionId: input.missionId, oversightIssueId: first.oversightIssueId,
    findings: first.findings, recommendations: first.recommendations, commented: index === 0, appliedActions: [] })));
  const outcomes = observations.flatMap(row => row.recoveryOutcomes ?? []);
  assert.ok(outcomes.some(row => row.kind === "no_op" && row.reason === "source_already_recovered" && row.outcome === "blocked"));
  assert.equal(outcomes.some(row => row.reason === "target_missing"), false);
  const metadata = sourceBefore.metadata as Record<string, Record<string, unknown>>;
  const invocation = metadata.toolInvocation, result = metadata.toolResult, queue = metadata.toolQueue;
  assert.deepStrictEqual([sourceBefore.status, sourceBefore.executionGeneration, sourceBefore.lastDispatchRequestId],
    ["completed", 0, invocation.requestId]);
  assert.ok(sourceBefore.startedAt instanceof Date && sourceBefore.completedAt instanceof Date);
  assert.deepStrictEqual([sourceBefore.lastDispatchAttemptAt, sourceBefore.lastDispatchAcceptedAt], [sourceBefore.startedAt, sourceBefore.startedAt]);
  assert.deepStrictEqual([invocation.toolName, invocation.requestId, queue.queuedAt, queue.settledAt,
    result.requestId, result.completedAt, result.success, result.artifactPath, result.artifactSha256],
  ["collect-us-stockflow", sourceBefore.lastDispatchRequestId, sourceBefore.lastDispatchAttemptAt!.toISOString(),
    sourceBefore.completedAt.toISOString(), sourceBefore.lastDispatchRequestId, sourceBefore.completedAt.toISOString(),
    true, input.artifactPath, artifactBefore.sha256]);
  assert.deepStrictEqual([queue.status, typeof queue.queuedAt, typeof queue.settledAt], ["settled", "string", "string"]);
  assert.deepStrictEqual(sourceAfter, sourceBefore);
  assert.deepStrictEqual(artifactAfter.bytes, artifactBefore.bytes);
  assert.equal(artifactAfter.sha256, artifactBefore.sha256);
  const marker = supervisionDiagnosticMarker(input.missionId, input.now, first.findings);
  const added = after.comments.filter(row => !before.comments.some(old => old.id === row.id));
  assert.equal(added.length, 1);
  const comment = added[0]!;
  assert.deepStrictEqual([comment.companyId, comment.issueId, comment.authorAgentId, comment.authorUserId],
    [input.companyId, first.oversightIssueId, input.ownerAgentId, null]);
  assert.ok(comment.body.includes(`<!-- ${marker} -->`) && comment.body.includes(`- Mission: ${input.missionTitle}`));
  assert.ok(comment.body.includes(`- Observed at: ${input.now.toISOString()}`));
  for (const finding of first.findings) assert.ok(comment.body.includes(`- ${finding}`));
  for (const recommendation of first.recommendations) assert.ok(comment.body.includes(recommendation.reason));
  assert.ok(comment.body.includes("Applied safe actions:\n- None"));
  assert.ok(comment.createdAt instanceof Date && comment.updatedAt instanceof Date);
  assert.equal(after.comments.filter(row => row.body.includes(`<!-- ${marker} -->`)).length, 1);
  const beforeIssue = before.missionIssues.find(row => row.id === first.oversightIssueId)!;
  const afterIssue = after.missionIssues.find(row => row.id === first.oversightIssueId)!;
  assert.notDeepStrictEqual(afterIssue.updatedAt, beforeIssue.updatedAt);
  assert.deepStrictEqual({ ...afterIssue, updatedAt: beforeIssue.updatedAt }, beforeIssue);
  assert.deepStrictEqual(input.writes.map(rows => rows.map(({ operation, table, columns }) => ({ operation, table, columns }))), [
    [{ operation: "INSERT", table: "issue_comments", columns: ["id", "company_id", "issue_id", "author_agent_id", "author_user_id", "body", "created_at", "updated_at"] },
      { operation: "UPDATE", table: "issues", columns: ["updated_at"] }], [], [], [], [],
  ]);
  assert.deepStrictEqual(input.writes[0]![0]!.parameters, [input.companyId, first.oversightIssueId, input.ownerAgentId, null, comment.body]);
  assert.deepStrictEqual(input.writes[0]![1]!.parameters, [afterIssue.updatedAt.toISOString(), first.oversightIssueId]);
  assert.equal(after.events.some(row => row.eventType === "mission_owner_decision_not_applied" && row.reasonCode === "tool_target_missing"), false);
  assert.equal(after.events.some(row => row.eventType === "mission_owner_dead_target_escalation"), false);
  assert.equal(after.events.some(row => row.eventType === "mission_owner_tool_step_retry"), false);
  const expected = structuredClone(before);
  expected.comments = canonicalRows([...before.comments, comment]);
  expected.missionIssues = canonicalRows(before.missionIssues.map(row => row.id === first.oversightIssueId
    ? { ...row, updatedAt: afterIssue.updatedAt } : row));
  assert.deepStrictEqual(after, expected);
}

export async function runAndAssertNativeSupervision(input: {
  db: Db; before: LifecycleSnapshot; sourceStepRunId: string; snapshot: () => Promise<LifecycleSnapshot>; artifactPath: string;
  supervise: () => Promise<{ missions: NativeObservation[] }>; settle: () => Promise<unknown>;
  assertBoundaries: () => void; companyId: string; missionId: string; missionTitle: string;
  ownerAgentId: string; now: Date;
}) {
  const sourceBefore = input.before.steps.find(row => row.id === input.sourceStepRunId)!;
  const artifactBefore = artifactDigest(input.artifactPath);
  const batch = await captureSixSupervisions(input.db, input.supervise);
  await input.settle();
  input.assertBoundaries();
  const observations = batch.results.map(result => result.missions.find(row => row.missionId === input.missionId)!);
  const after = await input.snapshot();
  const sourceAfter = after.steps.find(row => row.id === sourceBefore.id)!;
  assertNativeSupervisionEffects({ before: input.before, after, sourceBefore, sourceAfter,
    artifactPath: input.artifactPath, artifactBefore, artifactAfter: artifactDigest(input.artifactPath),
    observations, writes: batch.writes, companyId: input.companyId, missionId: input.missionId,
    missionTitle: input.missionTitle, ownerAgentId: input.ownerAgentId, now: input.now });
  return { batch, observations, after };
}

export function artifactDigest(file: string) {
  const bytes = readFileSync(file);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function assertNativeAssignmentObservation(input: {
  assignmentInputs: unknown[]; downstream: unknown; downstreamIssue: unknown;
  companyId: string; workflowRunId: string; issueId: string;
}) {
  assert.equal(input.assignmentInputs.length, 1);
  const assignment = input.assignmentInputs[0] as {
    issue: { id: string }; contextSource: string; contextSnapshot?: Record<string, unknown>;
  };
  const downstream = input.downstream as { id: string; workflowRunId: string; stepId: string; issueId: string | null; executionGeneration: number };
  const issue = input.downstreamIssue as { companyId: string; originKind: string | null; originRunId: string | null };
  assert.deepStrictEqual([assignment.issue.id, assignment.contextSource], [input.issueId, "workflow.dispatch"]);
  assert.deepStrictEqual([assignment.contextSnapshot?.taskId, assignment.contextSnapshot?.workflowRunId,
    assignment.contextSnapshot?.workflowStepId, assignment.contextSnapshot?.stepId],
  [input.issueId, input.workflowRunId, "summarize-stockflow", "summarize-stockflow"]);
  assert.deepStrictEqual([downstream.workflowRunId, downstream.stepId, downstream.issueId],
    [input.workflowRunId, "summarize-stockflow", input.issueId]);
  assert.deepStrictEqual([issue.originKind, issue.originRunId, issue.companyId], ["workflow_execution", input.workflowRunId, input.companyId]);
}

export function assertNativeBaseline(input: {
  before: LifecycleSnapshot; downstreamWakes: Array<{ id: string; runId: string | null; companyId: string; issueId: string | null;
    workflowStepRunId: string | null; workflowExecutionGeneration: number | null }>;
  downstream: { id: string; executionGeneration: number }; downstreamIssueId: string;
  sourceStepRunId: string; downstreamStepRunId: string; companyId: string; ownerAgentId: string;
}) {
  const { before, downstreamWakes } = input;
  assert.deepStrictEqual(before.steps.map(row => row.id).sort(), [input.sourceStepRunId, input.downstreamStepRunId].sort());
  assert.equal(before.runIssues.length, 1);
  assert.deepStrictEqual(before.runWakes, downstreamWakes);
  assert.equal(before.missionIssues.filter(row => row.originKind === "mission_main_executor_unblock").length, 1);
  assert.equal(before.cardWakes.length, 0);
  assert.equal(before.authorities.length, 0);
  assert.equal(before.heartbeats.length, 1);
  assert.deepStrictEqual([before.heartbeats[0]!.id, before.heartbeats[0]!.companyId, before.heartbeats[0]!.agentId,
    before.heartbeats[0]!.issueId, before.heartbeats[0]!.wakeupRequestId, before.heartbeats[0]!.workflowStepRunId,
    before.heartbeats[0]!.workflowExecutionGeneration, before.heartbeats[0]!.status],
  [downstreamWakes[0]!.runId, input.companyId, input.ownerAgentId, input.downstreamIssueId, downstreamWakes[0]!.id,
    input.downstream.id, input.downstream.executionGeneration, "running"]);
}

export function assertNativeDownstreamDrain(state: Awaited<ReturnType<typeof snapshotNativeDownstreamState>>,
  input: { companyId: string; missionId: string; workflowRunId: string; sourceStepRunId: string;
    downstreamStepRunId: string; downstreamIssueId: string; wakeId: string; ownerAgentId: string; generation: number }) {
  assert.deepStrictEqual([state.sourceStep.id, state.sourceStep.status, state.sourceStep.executionGeneration],
    [input.sourceStepRunId, "completed", 0]);
  assert.equal(state.wakes.length, 1);
  assert.equal(state.heartbeats.length, 1);
  assert.deepStrictEqual([state.wakes[0]!.id, state.wakes[0]!.companyId, state.wakes[0]!.missionId,
    state.wakes[0]!.issueId, state.wakes[0]!.runId, state.wakes[0]!.workflowRunId,
    state.wakes[0]!.workflowStepRunId, state.wakes[0]!.workflowExecutionGeneration, state.wakes[0]!.source, state.wakes[0]!.status],
  [input.wakeId, input.companyId, input.missionId, input.downstreamIssueId, state.heartbeats[0]?.id,
    input.workflowRunId, input.downstreamStepRunId, input.generation, "assignment", "completed"]);
  assert.deepStrictEqual([state.heartbeats[0]!.id, state.heartbeats[0]!.companyId, state.heartbeats[0]!.agentId,
    state.heartbeats[0]!.issueId, state.heartbeats[0]!.wakeupRequestId, state.heartbeats[0]!.workflowStepRunId,
    state.heartbeats[0]!.workflowExecutionGeneration, state.heartbeats[0]!.status, state.heartbeats[0]!.resultJson],
  [state.wakes[0]!.runId, input.companyId, input.ownerAgentId, input.downstreamIssueId, input.wakeId,
    input.downstreamStepRunId, input.generation, "succeeded", null]);
  assert.ok(state.downstreamStep.startedAt instanceof Date && state.downstreamStep.completedAt instanceof Date
    && state.downstreamStep.completedAt.getTime() >= state.downstreamStep.startedAt.getTime());
  assert.ok(state.run.completedAt instanceof Date
    && state.run.completedAt.getTime() >= state.downstreamStep.completedAt.getTime());
  assert.deepStrictEqual([state.downstreamStep.id, state.downstreamStep.workflowRunId, state.downstreamStep.stepId,
    state.downstreamStep.issueId, state.downstreamStep.executionGeneration, state.downstreamStep.status,
    state.run.id, state.run.missionId, state.run.status],
  [input.downstreamStepRunId, input.workflowRunId, "summarize-stockflow", input.downstreamIssueId, input.generation,
    "completed", input.workflowRunId, input.missionId, "completed"]);
}

export async function assertNativeDownstreamAfterDrain(db: Db, scenario: Scenario,
  issueId: string, wakeId: string, generation: number) {
  const state = await snapshotNativeDownstreamState(db, scenario);
  assertNativeDownstreamDrain(state, { companyId: scenario.companyId, missionId: scenario.missionId,
    workflowRunId: scenario.workflowRunId, sourceStepRunId: scenario.stepRunId,
    downstreamStepRunId: scenario.downstreamStepRunId, downstreamIssueId: issueId,
    wakeId, ownerAgentId: scenario.ownerAgentId, generation });
}

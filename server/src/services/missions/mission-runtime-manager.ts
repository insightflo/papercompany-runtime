import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  missionAgentRuntimes,
  missionIssueHandoffs,
  missionRollingState,
  missions,
  type MissionIssueHandoffEvidenceRef,
  type MissionIssueHandoffJson,
  type MissionRollingStateJson,
} from "@paperclipai/db";

export const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);
export const MISSION_RUNTIME_WORK_BLOCKING_STATUSES = new Set(["completed", "cancelled", "paused"]);
export const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);
export const ACTIVE_MISSION_RUNTIME_STATUSES = ["starting", "ready", "busy", "idle"] as const;

export type MissionAgentRuntimeStatus =
  | "starting"
  | "ready"
  | "busy"
  | "idle"
  | "stopping"
  | "stopped"
  | "crashed";

export function buildMissionRuntimeKey(input: {
  companyId: string;
  missionId: string;
  agentId: string;
  adapterType: string;
  workspaceKey?: string | null;
}): string {
  const workspaceKey = input.workspaceKey?.trim() || "default";
  return [
    `company:${input.companyId}`,
    `mission:${input.missionId}`,
    `agent:${input.agentId}`,
    `adapter:${input.adapterType}`,
    `workspace:${workspaceKey}`,
  ].join("|");
}

export function buildIssueEnvelopePolicy(input: {
  bootstrapRequired: boolean;
  supportsPersistentRuntime: boolean;
}) {
  return {
    bootstrapRequired: input.bootstrapRequired,
    fullContextInjection: input.bootstrapRequired || !input.supportsPersistentRuntime,
    issueEnvelopeOnly: !input.bootstrapRequired && input.supportsPersistentRuntime,
  };
}

export async function assertMissionRuntimeAcceptsWork(db: Db, input: {
  companyId: string;
  missionId: string | null | undefined;
}): Promise<void> {
  if (!input.missionId) return;
  const [mission] = await db
    .select({ status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)))
    .limit(1);
  if (mission && MISSION_RUNTIME_WORK_BLOCKING_STATUSES.has(mission.status)) {
    throw Object.assign(new Error(`Cannot enqueue or execute work for mission ${input.missionId} with status ${mission.status}`), {
      code: "mission_not_accepting_work",
      status: mission.status,
    });
  }
}

export async function ensureMissionAgentRuntime(db: Db, input: {
  companyId: string;
  missionId: string;
  agentId: string;
  adapterType: string;
  workspaceId?: string | null;
  workspaceKey?: string | null;
  currentIssueId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
}) {
  await assertMissionRuntimeAcceptsWork(db, {
    companyId: input.companyId,
    missionId: input.missionId,
  });

  const now = new Date();
  const workspaceKey = input.workspaceKey?.trim() || input.workspaceId || "default";
  const runtimeKey = buildMissionRuntimeKey({ ...input, workspaceKey });

  const existing = await db
    .select()
    .from(missionAgentRuntimes)
    .where(and(
      eq(missionAgentRuntimes.missionId, input.missionId),
      eq(missionAgentRuntimes.agentId, input.agentId),
      eq(missionAgentRuntimes.adapterType, input.adapterType),
      eq(missionAgentRuntimes.workspaceKey, workspaceKey),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const bootstrapRequired = !existing?.contextInjectedAt;

  const [runtime] = await db
    .insert(missionAgentRuntimes)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      runtimeKey,
      workspaceId: input.workspaceId ?? null,
      workspaceKey,
      status: "busy",
      currentIssueId: input.currentIssueId ?? null,
      lastRunId: input.runId ?? null,
      sessionId: input.sessionId ?? null,
      startedAt: now,
      lastIssueEnvelopeAt: now,
      stateJson: {
        runtimeKey,
        bootstrapContextInjected: !bootstrapRequired,
        bootstrapContextInjectedAt: existing?.contextInjectedAt ? existing.contextInjectedAt.toISOString() : null,
        lastIssueEnvelopeAt: now.toISOString(),
        workspaceKey,
      },
    })
    .onConflictDoUpdate({
      target: [
        missionAgentRuntimes.missionId,
        missionAgentRuntimes.agentId,
        missionAgentRuntimes.adapterType,
        missionAgentRuntimes.workspaceKey,
      ],
      set: {
        status: "busy",
        currentIssueId: input.currentIssueId ?? null,
        lastRunId: input.runId ?? null,
        sessionId: input.sessionId ?? existing?.sessionId ?? null,
        runtimeKey,
        workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
        lastIssueEnvelopeAt: now,
        stoppedAt: null,
        stopReason: null,
        updatedAt: now,
      },
    })
    .returning();

  return { runtime, bootstrapRequired };
}

export async function markMissionRuntimeBootstrapInjected(db: Db, runtimeId: string): Promise<void> {
  const now = new Date();
  await db
    .update(missionAgentRuntimes)
    .set({
      contextInjectedAt: now,
      stateJson: {
        bootstrapContextInjected: true,
        bootstrapContextInjectedAt: now.toISOString(),
      },
      updatedAt: now,
    })
    .where(eq(missionAgentRuntimes.id, runtimeId));
}

export async function completeMissionAgentRuntimeRun(db: Db, input: {
  runtimeId: string;
  status: string;
  sessionId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  error?: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .update(missionAgentRuntimes)
    .set({
      status: input.status === "succeeded" || input.status === "cancelled" ? "idle" : "crashed",
      currentIssueId: null,
      lastRunStatus: input.status,
      sessionId: input.sessionId ?? null,
      lastError: input.error ?? null,
      runCount: sql`${missionAgentRuntimes.runCount} + 1`,
      totalInputTokens: sql`${missionAgentRuntimes.totalInputTokens} + ${input.inputTokens ?? 0}`,
      totalOutputTokens: sql`${missionAgentRuntimes.totalOutputTokens} + ${input.outputTokens ?? 0}`,
      totalCostCents: sql`${missionAgentRuntimes.totalCostCents} + ${input.costCents ?? 0}`,
      updatedAt: now,
    })
    .where(eq(missionAgentRuntimes.id, input.runtimeId));
}

function terminateRuntimeProcess(pid: number | null): { attempted: boolean; error?: string } {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return { attempted: false };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { attempted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { attempted: true, error: message };
  }
}

export async function stopMissionRuntimesForMission(db: Db, input: {
  companyId: string;
  missionId: string;
  reason: string;
}): Promise<number> {
  const now = new Date();
  const activeRuntimes = await db
    .select({ id: missionAgentRuntimes.id, processPid: missionAgentRuntimes.processPid })
    .from(missionAgentRuntimes)
    .where(and(
      eq(missionAgentRuntimes.companyId, input.companyId),
      eq(missionAgentRuntimes.missionId, input.missionId),
      inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
    ));

  const killResults = activeRuntimes.map((runtime) => ({
    id: runtime.id,
    ...terminateRuntimeProcess(runtime.processPid),
  }));

  const stopped = await db
    .update(missionAgentRuntimes)
    .set({
      status: "stopped",
      currentIssueId: null,
      queueDepth: 0,
      stopReason: input.reason,
      lastError: killResults.find((result) => result.error)?.error ?? null,
      stateJson: {
        stopReason: input.reason,
        processTermination: killResults,
      },
      stoppedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(missionAgentRuntimes.companyId, input.companyId),
      eq(missionAgentRuntimes.missionId, input.missionId),
      inArray(missionAgentRuntimes.status, [...ACTIVE_MISSION_RUNTIME_STATUSES]),
    ))
    .returning({ id: missionAgentRuntimes.id });
  return stopped.length;
}

export function buildMissionIssueHandoffMarkdown(input: {
  missionId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  status: string;
  issueGoal?: string | null;
  summaryText?: string | null;
  decisions?: string[];
  caveats?: string[];
  remainingWork?: string[];
  evidenceRefs?: MissionIssueHandoffEvidenceRef[];
}): string {
  const evidence = input.evidenceRefs?.length
    ? input.evidenceRefs.map((ref) => `- ${ref.type}${ref.id ? `: ${ref.id}` : ""}${ref.path ? ` (${ref.path})` : ""}${ref.description ? ` — ${ref.description}` : ""}`)
    : ["- No explicit evidence refs captured by runtime; inspect heartbeat run result/log excerpts."];
  return [
    "# Issue Handoff",
    "",
    "## Identity",
    `- Mission ID: ${input.missionId}`,
    `- Issue ID: ${input.issueId ?? "none"}`,
    `- Agent ID: ${input.agentId}`,
    `- Run ID: ${input.runId}`,
    `- Status: ${input.status}`,
    `- Timestamp: ${new Date().toISOString()}`,
    "",
    "## Issue Goal",
    input.issueGoal?.trim() || "No issue goal captured.",
    "",
    "## Actions Taken",
    input.summaryText?.trim() || "See heartbeat run result/log excerpts.",
    "",
    "## Decisions Made",
    ...(input.decisions?.length ? input.decisions.map((item) => `- ${item}`) : ["- No explicit decisions captured."]),
    "",
    "## Evidence",
    ...evidence,
    "",
    "## Important Caveats",
    ...(input.caveats?.length ? input.caveats.map((item) => `- ${item}`) : ["- Treat this handoff as agent/runtime self-report until evidence is verified."]),
    "",
    "## Remaining Work - This Issue",
    ...(input.remainingWork?.length ? input.remainingWork.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## Remaining Work - Mission",
    "- Mission owner should reconcile this handoff with sibling issue handoffs before closeout.",
    "",
    "## Recommended Next Prompt",
    input.issueId
      ? `Continue mission ${input.missionId}; use handoff from issue ${input.issueId} only as verified context when evidence refs support it.`
      : `Continue mission ${input.missionId}; inspect latest mission state before choosing next work.`,
  ].join("\n");
}

export async function persistMissionIssueHandoff(db: Db, input: {
  companyId: string;
  missionId: string;
  issueId: string | null;
  agentId: string;
  runId: string;
  missionSessionId?: string | null;
  status: string;
  handoffMarkdown: string;
  handoffJson?: MissionIssueHandoffJson;
  evidenceRefsJson?: MissionIssueHandoffEvidenceRef[];
}) {
  const now = new Date();
  const [handoff] = await db
    .insert(missionIssueHandoffs)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      issueId: input.issueId,
      agentId: input.agentId,
      runId: input.runId,
      missionSessionId: input.missionSessionId ?? null,
      status: input.status,
      handoffMarkdown: input.handoffMarkdown,
      handoffJson: input.handoffJson ?? {},
      evidenceRefsJson: input.evidenceRefsJson ?? [],
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: missionIssueHandoffs.runId,
      set: {
        status: input.status,
        handoffMarkdown: input.handoffMarkdown,
        handoffJson: input.handoffJson ?? {},
        evidenceRefsJson: input.evidenceRefsJson ?? [],
        updatedAt: now,
      },
    })
    .returning();
  return handoff;
}

function mergeRollingState(previous: MissionRollingStateJson, input: {
  issueId: string | null;
  handoffId: string;
  status: string;
  summaryText?: string | null;
  createdAt: Date;
}): MissionRollingStateJson {
  const completedIssues = [...(previous.completedIssues ?? [])];
  if (input.issueId && input.status === "succeeded") {
    completedIssues.push({
      issueId: input.issueId,
      summary: input.summaryText?.slice(0, 500) || "Issue run succeeded.",
      handoffId: input.handoffId,
    });
  }
  const handoffIndex = [
    ...(previous.handoffIndex ?? []),
    {
      issueId: input.issueId,
      handoffId: input.handoffId,
      status: input.status,
      createdAt: input.createdAt.toISOString(),
    },
  ].slice(-50);
  return {
    ...previous,
    completedIssues: completedIssues.slice(-50),
    handoffIndex,
    blockers: input.status === "failed" || input.status === "timed_out"
      ? [...(previous.blockers ?? []), `Run handoff ${input.handoffId} ended with ${input.status}`].slice(-20)
      : previous.blockers,
  };
}

export function buildMissionStateMarkdown(input: {
  missionId: string;
  state: MissionRollingStateJson;
}): string {
  const state = input.state;
  return [
    "# Mission State",
    "",
    `Mission ID: ${input.missionId}`,
    "",
    "## Mission Goal",
    state.missionGoal ?? "Not captured.",
    "",
    "## Current Plan",
    state.currentPlan ?? "Not captured.",
    "",
    "## Completed Issues",
    ...(state.completedIssues?.length ? state.completedIssues.map((item) => `- ${item.issueId}: ${item.summary}`) : ["- None captured."]),
    "",
    "## Active Decisions",
    ...(state.activeDecisions?.length ? state.activeDecisions.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## Known Constraints",
    ...(state.knownConstraints?.length ? state.knownConstraints.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## Open Questions",
    ...(state.openQuestions?.length ? state.openQuestions.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## Blockers",
    ...(state.blockers?.length ? state.blockers.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## Handoff Index",
    ...(state.handoffIndex?.length ? state.handoffIndex.map((item) => `- ${item.issueId ?? "mission"}: ${item.handoffId} (${item.status})`) : ["- None captured."]),
  ].join("\n");
}

export async function updateMissionRollingStateFromHandoff(db: Db, input: {
  companyId: string;
  missionId: string;
  runId: string;
  issueId: string | null;
  handoffId: string;
  status: string;
  summaryText?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
}) {
  const now = new Date();
  const existing = await db
    .select()
    .from(missionRollingState)
    .where(eq(missionRollingState.missionId, input.missionId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const nextState = mergeRollingState(existing?.stateJson ?? {}, {
    issueId: input.issueId,
    handoffId: input.handoffId,
    status: input.status,
    summaryText: input.summaryText,
    createdAt: now,
  });
  const stateMarkdown = buildMissionStateMarkdown({ missionId: input.missionId, state: nextState });

  const [row] = await db
    .insert(missionRollingState)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      revision: 1,
      status: "active",
      stateJson: nextState,
      stateMarkdown,
      lastRunId: input.runId,
      lastCompactedAt: now,
      totalRuns: 1,
      totalInputTokens: input.inputTokens ?? 0,
      totalOutputTokens: input.outputTokens ?? 0,
      totalCostCents: input.costCents ?? 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: missionRollingState.missionId,
      set: {
        revision: sql`${missionRollingState.revision} + 1`,
        status: "active",
        stateJson: nextState,
        stateMarkdown,
        lastRunId: input.runId,
        lastCompactedAt: now,
        totalRuns: sql`${missionRollingState.totalRuns} + 1`,
        totalInputTokens: sql`${missionRollingState.totalInputTokens} + ${input.inputTokens ?? 0}`,
        totalOutputTokens: sql`${missionRollingState.totalOutputTokens} + ${input.outputTokens ?? 0}`,
        totalCostCents: sql`${missionRollingState.totalCostCents} + ${input.costCents ?? 0}`,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function listRecentMissionHandoffs(db: Db, input: {
  companyId: string;
  missionId: string;
  limit?: number;
}) {
  return await db
    .select()
    .from(missionIssueHandoffs)
    .where(and(eq(missionIssueHandoffs.companyId, input.companyId), eq(missionIssueHandoffs.missionId, input.missionId)))
    .orderBy(desc(missionIssueHandoffs.createdAt))
    .limit(input.limit ?? 10);
}

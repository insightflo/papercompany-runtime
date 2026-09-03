import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  missionAgentRuntimes,
  missionIssueHandoffs,
  missionRollingState,
  missions,
  issues,
  type MissionIssueHandoffDecisionUpdate,
  type MissionIssueHandoffEvidenceRef,
  type MissionIssueHandoffJson,
  type MissionRollingDecisionRecord,
  type MissionRollingStateJson,
} from "@paperclipai/db";
import { sha256Text } from "../issue-execution-cards/hash.js";
import { truncateHandoffText } from "./handoff-text-cap.js";
import type { SessionHandoffDecisionLogPointer } from "../session-handoff-artifact.js";

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

export function capHandoffJsonText(json: MissionIssueHandoffJson | undefined): MissionIssueHandoffJson {
  if (!json) return {};
  const capped: MissionIssueHandoffJson = { ...json };
  if (typeof capped.issueGoal === "string") {
    capped.issueGoal = truncateHandoffText(capped.issueGoal);
  }
  if (Array.isArray(capped.actionsTaken)) {
    capped.actionsTaken = capped.actionsTaken.map((item) => truncateHandoffText(String(item)));
  }
  if (Array.isArray(capped.decisionUpdates)) {
    capped.decisionUpdates = capped.decisionUpdates.map((update) => ({
      ...update,
      summary: typeof update?.summary === "string" ? truncateHandoffText(update.summary) : update?.summary,
    }));
  }
  return capped;
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
  decisionUpdates?: MissionIssueHandoffDecisionUpdate[];
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
    truncateHandoffText(input.issueGoal) || "No issue goal captured.",
    "",
    "## Actions Taken",
    truncateHandoffText(input.summaryText) || "See heartbeat run result/log excerpts.",
    "",
    "## Decisions Made",
    ...(input.decisionUpdates?.length
      ? input.decisionUpdates
          .filter((update) => typeof update?.id === "string" && update.id.trim().length > 0)
          .map((update) => {
            const label = update.status ? `[${update.status}] ` : "";
            const supersedes = update.supersedes ? ` (supersedes ${update.supersedes})` : "";
            return `- ${label}${update.id}: ${update.summary ?? "(no summary)"}${supersedes}`;
          })
      : input.decisions?.length
        ? input.decisions.map((item) => `- ${item}`)
        : ["- No explicit decisions captured."]),
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
  const contentHash = sha256Text(input.handoffMarkdown);
  const cappedHandoffJson = capHandoffJsonText(input.handoffJson);
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
      contentHash,
      handoffMarkdown: input.handoffMarkdown,
      handoffJson: cappedHandoffJson,
      evidenceRefsJson: input.evidenceRefsJson ?? [],
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: missionIssueHandoffs.runId,
      set: {
        status: input.status,
        contentHash,
        handoffMarkdown: input.handoffMarkdown,
        handoffJson: cappedHandoffJson,
        evidenceRefsJson: input.evidenceRefsJson ?? [],
        updatedAt: now,
      },
    })
    .returning();
  return handoff;
}

export const MISSION_DECISION_LOG_CAP = 50;

/**
 * [결정 로그 결정론 병합 — A안 2026-09-05]
 * 핸드오프의 구조화된 decisionUpdates 를 롤링 상태 결정 로그에 반영한다.
 * 병합은 런타임이 결정론적으로 수행한다(SKILL.state 분업: 모델은 제안만, 병합은
 * 결정론 런타임). 순서 규칙:
 * - 유효하지 않은 항목(빈 id, summary 없는 신규 생성)은 결정론적으로 버린다.
 * - 기존 id: 주어진 필드만 갱신(status/summary/supersedes), 출처 handoffId/updatedAt 최신화.
 * - 신규 id: under_review 기본으로 추가.
 * - supersedes 로 지목된 기존 결정은 retired 로 전환되고 로그에 남는다
 *   (폐기된 결정까지 붙들어야 지금이 보인다).
 * - 상한 MISSION_DECISION_LOG_CAP(50) — 오래된 순서로 잘린다.
 * 규칙 8: 결과는 다음 에이전트 맥락 전달용 상태일 뿐, 실행 통제가 이를 읽지 않는다.
 */
export function mergeDecisionRecords(
  previous: MissionRollingDecisionRecord[] | undefined,
  updates: MissionIssueHandoffDecisionUpdate[] | undefined,
  input: { handoffId: string | null; now: Date },
): MissionRollingDecisionRecord[] {
  if (!updates || updates.length === 0) {
    return previous ?? [];
  }
  const merged: MissionRollingDecisionRecord[] = (previous ?? []).map((record) => ({ ...record }));
  const byId = new Map(merged.map((record) => [record.id, record]));

  for (const update of updates) {
    const id = typeof update?.id === "string" ? update.id.trim() : "";
    if (!id) continue;
    const summary = typeof update.summary === "string" && update.summary.trim().length > 0
      ? update.summary.trim()
      : undefined;
    const existing = byId.get(id);
    if (!existing) {
      if (!summary) continue;
      const record: MissionRollingDecisionRecord = {
        id,
        summary,
        status: update.status ?? "under_review",
        supersedes: update.supersedes ?? null,
        handoffId: input.handoffId,
        updatedAt: input.now.toISOString(),
      };
      merged.push(record);
      byId.set(id, record);
    } else {
      if (summary) existing.summary = summary;
      if (update.status) existing.status = update.status;
      if (update.supersedes !== undefined) existing.supersedes = update.supersedes;
      existing.handoffId = input.handoffId;
      existing.updatedAt = input.now.toISOString();
    }
    if (update.supersedes) {
      const superseded = byId.get(update.supersedes);
      if (superseded && superseded.id !== id) {
        superseded.status = "retired";
        superseded.handoffId = input.handoffId;
        superseded.updatedAt = input.now.toISOString();
      }
    }
  }

  return merged.slice(-MISSION_DECISION_LOG_CAP);
}

export function mergeRollingState(previous: MissionRollingStateJson, input: {
  issueId: string | null;
  handoffId: string;
  status: string;
  summaryText?: string | null;
  decisionUpdates?: MissionIssueHandoffDecisionUpdate[];
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
  const decisions = mergeDecisionRecords(
    previous.decisions,
    input.decisionUpdates,
    { handoffId: input.handoffId, now: input.createdAt },
  );
  return {
    ...previous,
    completedIssues: completedIssues.slice(-50),
    handoffIndex,
    ...(decisions.length > 0 || (previous.decisions ?? []).length > 0 ? { decisions } : {}),
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
    "## Decision Log",
    ...(state.decisions?.length
      ? state.decisions.map((item) =>
          `- [${item.status}] ${item.id}: ${item.summary}${item.supersedes ? ` (supersedes ${item.supersedes})` : ""}`)
      : ["- None captured."]),
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
  decisionUpdates?: MissionIssueHandoffDecisionUpdate[];
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
    decisionUpdates: input.decisionUpdates,
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

/**
 * [결정원장 포인터 — A안] 세션 회전 핸드오프가 권위 있는 결정 로그를
 * '미션 + 판번호(revision)'로 가리키게 하는 조회. 롤링 상태 행이 없으면 null.
 * 규칙 8: 포인터는 맥락 전달용 표시물 — 소비자는 구조 레코드를 읽어야 하며
 * 이 포인터 자체를 실행 판단 근거로 쓰지 않는다.
 */
export async function resolveMissionDecisionLogPointer(
  db: Db,
  missionId: string,
): Promise<SessionHandoffDecisionLogPointer | null> {
  const [row] = await db
    .select({ revision: missionRollingState.revision })
    .from(missionRollingState)
    .where(eq(missionRollingState.missionId, missionId))
    .limit(1);
  return row ? { missionId, revision: row.revision } : null;
}

export const MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT = 5 * 60 * 1000;
export const MISSION_RUNTIME_BUSY_REAP_SWEEP_LIMIT = 50;

/**
 * [백킹 런 판정 — 회수기·라이브니스 표시 공용 원천]
 * runtime의 busy를 뒷받침하는 비종료(queued/running) heartbeat run 존재 여부.
 * 1) runtime.currentIssueId와 같은 이슈의 런
 * 2) 같은 미션 소속 이슈의 런(미션 중복 실행 방지와 정합 유지)
 * 3) 이슈 없는 런만 있을 때: currentIssueId가 없는 busy는 이 런일 수 있으므로 보호
 */
export async function hasBackingHeartbeatRun(db: Db, runtime: {
  agentId: string;
  missionId: string;
  currentIssueId: string | null;
}): Promise<boolean> {
  const activeRuns = await db
    .select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.agentId, runtime.agentId),
      inArray(heartbeatRuns.status, ["queued", "running"]),
    ))
    .limit(20);

  if (activeRuns.length === 0) return false;
  if (runtime.currentIssueId && activeRuns.some((run) => run.issueId === runtime.currentIssueId)) {
    return true;
  }
  const runIssueIds = activeRuns
    .map((run) => run.issueId)
    .filter((issueId): issueId is string => typeof issueId === "string" && issueId.length > 0);
  if (runIssueIds.length === 0) {
    // 비종료 런이 있지만 이슈가 없는 런(시스템 실행)만 있을 때: currentIssueId가 없는
    // busy는 이 런일 수 있으므로 건드리지 않는다.
    return !runtime.currentIssueId;
  }
  const siblingRuns = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      inArray(issues.id, runIssueIds),
      eq(issues.missionId, runtime.missionId),
    ))
    .limit(1);
  return siblingRuns.length > 0;
}

/**
 * [백킹 런 상세 — 라이브니스 표시용] 판정은 hasBackingHeartbeatRun과 같은 기준으로
 * 우선순위(같은 이슈 > 같은 미션 형제 이슈)로 대표 런을 골라 상세를 반환한다.
 */
export async function findBackingHeartbeatRunDetail(db: Db, runtime: {
  agentId: string;
  missionId: string;
  currentIssueId: string | null;
}): Promise<{
  id: string;
  status: string;
  issueId: string | null;
  startedAt: Date | null;
  updatedAt: Date;
} | null> {
  const activeRuns = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      issueId: heartbeatRuns.issueId,
      startedAt: heartbeatRuns.startedAt,
      updatedAt: heartbeatRuns.updatedAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.agentId, runtime.agentId),
      inArray(heartbeatRuns.status, ["queued", "running"]),
    ))
    .orderBy(desc(heartbeatRuns.updatedAt))
    .limit(20);
  if (activeRuns.length === 0) return null;

  const sameIssue = runtime.currentIssueId
    ? activeRuns.find((run) => run.issueId === runtime.currentIssueId) ?? null
    : null;
  if (sameIssue) return sameIssue;

  const runIssueIds = activeRuns
    .map((run) => run.issueId)
    .filter((issueId): issueId is string => typeof issueId === "string" && issueId.length > 0);
  if (runIssueIds.length === 0) {
    return !runtime.currentIssueId ? activeRuns[0] ?? null : null;
  }
  const siblingIssueIds = new Set((await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      inArray(issues.id, runIssueIds),
      eq(issues.missionId, runtime.missionId),
    ))
    .limit(20)).map((row) => row.id));
  return activeRuns.find((run) => run.issueId && siblingIssueIds.has(run.issueId)) ?? null;
}

export interface ReapedMissionRuntime {
  runtimeId: string;
  companyId: string;
  missionId: string;
  agentId: string;
  issueId: string | null;
}

export interface ReapStaleBusyMissionRuntimesResult {
  reaped: ReapedMissionRuntime[];
  skippedActiveRun: number;
  skippedTerminalMission: number;
  casLost: number;
}

/**
 * [mission-runtime busy 고착 회수기 — 2026-09-01]
 *
 * mission_agent_runtimes.status='busy'는 beginMissionAgentRuntimeRun(디스패치 준비)에서
 * 설정되고 completeMissionAgentRuntimeRun(하트비트 런 종료 처리)에서만 해제된다. 완료 처리가
 * 누락되는 경로(서버 크래시 타이밍, 종료 처리 예외 등)에 빠지면 busy가 영구 고착되어 해당
 * 미션 에이전트 런타임이 새 이슈를 받지 못한다("같은 죽음의 반복" 사고군).
 *
 * 이 회수기는 recovery lane에서 주기적으로 돌며:
 * 1) busy 상태가 grace(기본 5분) 이상 경과했고
 * 2) 그 busy를 뒷받침하는 비종료(queued/running) heartbeat run이 없으며
 *    (runtime.currentIssueId가 있으면 같은 이슈의 런, 없으면 해당 에이전트의 아무 비종료 런,
 *     같은 미션 소속 이슈의 런도 뒷받침으로 인정)
 * 3) CAS(id+status+updatedAt 일치)로만 busy→idle 전환한다.
 *
 * 판정 의미 불변(규칙 7): 실행 중인 런의 판정/큐/상태를 건드리지 않는다. 회수는 런타임
 * 예약(bookkeeping) 행만 idle로 돌리고, 끊긴 이슈는 onReaped 콜백(웨이크업 재요청)로
 * 정상 디스패치 경로를 타게 한다. 동시 완료와 겹치면 CAS가 지므로 완료의 기록이 이긴다.
 */
export async function reapStaleBusyMissionRuntimes(db: Db, opts?: {
  now?: Date;
  graceMs?: number;
  onReaped?: (input: ReapedMissionRuntime) => Promise<void> | void;
}): Promise<ReapStaleBusyMissionRuntimesResult> {
  const now = opts?.now ?? new Date();
  const graceMs = opts?.graceMs ?? MISSION_RUNTIME_BUSY_REAP_GRACE_MS_DEFAULT;
  const cutoff = new Date(now.getTime() - graceMs);
  const result: ReapStaleBusyMissionRuntimesResult = {
    reaped: [],
    skippedActiveRun: 0,
    skippedTerminalMission: 0,
    casLost: 0,
  };

  const busyRuntimes = await db
    .select()
    .from(missionAgentRuntimes)
    .where(and(
      eq(missionAgentRuntimes.status, "busy"),
      lt(missionAgentRuntimes.updatedAt, cutoff),
    ))
    .limit(MISSION_RUNTIME_BUSY_REAP_SWEEP_LIMIT);

  for (const runtime of busyRuntimes) {
    const backed = await hasBackingHeartbeatRun(db, runtime);
    if (backed) {
      result.skippedActiveRun += 1;
      continue;
    }

    let missionTerminal = false;
    if (runtime.missionId) {
      const [mission] = await db
        .select({ status: missions.status })
        .from(missions)
        .where(eq(missions.id, runtime.missionId))
        .limit(1);
      missionTerminal = TERMINAL_MISSION_STATUSES.has(mission?.status ?? "");
    }

    const previousState = runtime.stateJson
      && typeof runtime.stateJson === "object"
      && !Array.isArray(runtime.stateJson)
      ? { ...(runtime.stateJson as Record<string, unknown>) }
      : {};
    const updated = await db
      .update(missionAgentRuntimes)
      .set({
        status: "idle",
        currentIssueId: null,
        lastError: `stale_busy_reaped: no queued/running heartbeat run backed this runtime for over ${Math.round(graceMs / 1000)}s`,
        stateJson: {
          ...previousState,
          busyReaper: {
            reapedAt: now.toISOString(),
            graceMs,
            previousStatus: "busy",
            previousCurrentIssueId: runtime.currentIssueId,
          },
        },
        updatedAt: now,
      })
      .where(and(
        eq(missionAgentRuntimes.id, runtime.id),
        eq(missionAgentRuntimes.status, "busy"),
        eq(missionAgentRuntimes.updatedAt, runtime.updatedAt),
      ))
      .returning({ id: missionAgentRuntimes.id });
    if (updated.length === 0) {
      // 동시 완료(completeMissionAgentRuntimeRun)가 이겼거나 상태가 이미 바뀜 — 개입 없음.
      result.casLost += 1;
      continue;
    }

    const reaped: ReapedMissionRuntime = {
      runtimeId: runtime.id,
      companyId: runtime.companyId,
      missionId: runtime.missionId,
      agentId: runtime.agentId,
      issueId: runtime.currentIssueId ?? null,
    };
    result.reaped.push(reaped);
    if (!missionTerminal && runtime.currentIssueId) {
      await opts?.onReaped?.(reaped);
    } else if (missionTerminal) {
      result.skippedTerminalMission += 1;
    }
  }
  return result;
}

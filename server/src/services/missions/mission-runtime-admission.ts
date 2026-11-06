import { and, eq, sql } from "drizzle-orm";
import { missionAgentRuntimes, missions, type Db } from "@paperclipai/db";

export const MISSION_RUNTIME_WORK_BLOCKING_STATUSES = new Set(["completed", "cancelled", "paused"]);

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

async function ensureMissionAgentRuntimeLocked(db: Db, input: {
  companyId: string;
  missionId: string;
  agentId: string;
  adapterType: string;
  workspaceId?: string | null;
  workspaceKey?: string | null;
  currentIssueId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  /** Request-specific runtime identity; never reuse a pre-resume row or session. */
  resumeContext?: { resumeRequestId: string };
}) {
  await assertMissionRuntimeAcceptsWork(db, {
    companyId: input.companyId,
    missionId: input.missionId,
  });

  const now = new Date();
  const physicalWorkspaceKey = input.workspaceKey?.trim() || input.workspaceId || "default";
  const workspaceKey = input.resumeContext
    ? `resume-runtime:${JSON.stringify([physicalWorkspaceKey, input.resumeContext.resumeRequestId])}`
    : physicalWorkspaceKey;
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
  const resumeMarker = input.resumeContext?.resumeRequestId ?? null;

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
      sessionId: input.resumeContext ? null : input.sessionId ?? null,
      startedAt: now,
      lastIssueEnvelopeAt: now,
      stateJson: {
        runtimeKey,
        bootstrapContextInjected: !bootstrapRequired,
        bootstrapContextInjectedAt: existing?.contextInjectedAt ? existing.contextInjectedAt.toISOString() : null,
        lastIssueEnvelopeAt: now.toISOString(),
        workspaceKey,
        ...(resumeMarker ? { resumeRequestId: resumeMarker } : {}),
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
        sessionId: input.resumeContext
          ? sql`${missionAgentRuntimes.sessionId}`
          : input.sessionId ?? existing?.sessionId ?? null,
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

/** Take the mission foreign-key lock before the runtime unique key. Resume transactions
 * already hold the mission FOR UPDATE; ordinary callers must wait before their INSERT.
 * Nested transactions are savepoints, so a caller's outer rollback still owns the write.
 */
export async function ensureMissionAgentRuntime(db: Db, input: Parameters<typeof ensureMissionAgentRuntimeLocked>[1]) {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    // The runtime FK references mission ID alone, even for a mismatched company input.
    await scoped.select({ id: missions.id }).from(missions)
      .where(eq(missions.id, input.missionId))
      .for("key share");
    return ensureMissionAgentRuntimeLocked(scoped, input);
  });
}

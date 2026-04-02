/**
 * Mission Session Store
 *
 * Manages mission_sessions lifecycle.
 * - 30-day idle timeout (company configurable)
 * - Expired sessions are compacted into a summary note
 * - Reuses resolveSessionCompactionPolicy from adapter-utils
 *
 * @see adapter-utils/src/session-compaction.ts
 */

import { and, eq, gt, lt, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecrets,
  missionSessions,
} from "@paperclipai/db";
import { notFound } from "../../errors.js";
import {
  resolveSessionCompactionPolicy,
  hasSessionCompactionThresholds,
} from "@paperclipai/adapter-utils";
import { missionSessionEvents } from "../../routes/metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * MissionSession row type.
 */
export type MissionSessionRow = typeof missionSessions.$inferSelect;

/**
 * Input to create a new mission session.
 */
export interface CreateMissionSessionInput {
  missionId: string;
  agentId: string;
  companyId: string;
  sessionSecretId: string;
  adapterType: string;
}

/**
 * Filter for listing sessions.
 */
export interface ListMissionSessionsFilter {
  missionId?: string;
  agentId?: string;
  companyId?: string;
  status?: string;
  includeExpired?: boolean;
}

/**
 * Session with resolved agent name.
 */
export interface MissionSessionWithAgent extends MissionSessionRow {
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default idle timeout: 30 days in milliseconds.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Grace period after expiresAt before the session is considered truly expired.
 * Gives the system time to clean up without race conditions.
 */
const EXPIRY_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function missionSessionStore(db: Db) {
  /**
   * Create a new mission session.
   */
  async function create(input: CreateMissionSessionInput): Promise<MissionSessionRow> {
    // Verify agent exists
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!agent) throw notFound(`Agent not found: ${input.agentId}`);

    // Verify secret exists
    const [secret] = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(eq(companySecrets.id, input.sessionSecretId))
      .limit(1);
    if (!secret) throw notFound(`Secret not found: ${input.sessionSecretId}`);

    const expiresAt = new Date(Date.now() + DEFAULT_IDLE_TIMEOUT_MS);

    const [session] = await db
      .insert(missionSessions)
      .values({
        missionId: input.missionId,
        agentId: input.agentId,
        companyId: input.companyId,
        sessionSecretId: input.sessionSecretId,
        adapterType: input.adapterType,
        status: "active",
        lastActiveAt: new Date(),
        runCount: 0,
        expiresAt,
      })
      .returning();

    return session;
  }

  /**
   * Get a session by ID.
   */
  async function getById(id: string): Promise<MissionSessionRow> {
    const [session] = await db
      .select()
      .from(missionSessions)
      .where(eq(missionSessions.id, id))
      .limit(1);

    if (!session) throw notFound(`Mission session not found: ${id}`);
    return session;
  }

  /**
   * Get or create a session for a mission + agent + adapter combination.
   * If an active, non-expired session exists, returns it.
   * Otherwise creates a new session.
   *
   * This is the main entry point for session reuse.
   */
  async function getOrCreate(input: CreateMissionSessionInput): Promise<{
    session: MissionSessionRow;
    isNew: boolean;
  }> {
    // Look for an existing active session
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - EXPIRY_GRACE_PERIOD_MS);

    const [existing] = await db
      .select()
      .from(missionSessions)
      .where(
        and(
          eq(missionSessions.missionId, input.missionId),
          eq(missionSessions.agentId, input.agentId),
          eq(missionSessions.adapterType, input.adapterType),
          eq(missionSessions.status, "active"),
        ),
      )
      .orderBy(asc(missionSessions.createdAt))
      .limit(1);

    if (existing) {
      const expiresAt = existing.expiresAt ?? new Date(0);
      const isExpired = expiresAt < graceCutoff;

      if (!isExpired) {
        // P9-T5: session reused
        missionSessionEvents.inc({ event: "reused" });
        return { session: existing, isNew: false };
      }

      // Session is expired — compact it and create new
      await compactSession(existing.id, input);
      return {
        session: await getById(existing.id),
        isNew: true,
      };
    }

    // No existing session — create new
    const [session] = await db
      .insert(missionSessions)
      .values({
        missionId: input.missionId,
        agentId: input.agentId,
        companyId: input.companyId,
        sessionSecretId: input.sessionSecretId,
        adapterType: input.adapterType,
        status: "active",
        lastActiveAt: now,
        runCount: 0,
        expiresAt: new Date(now.getTime() + DEFAULT_IDLE_TIMEOUT_MS),
      })
      .returning();

    // P9-T5: new session created
    missionSessionEvents.inc({ event: "new" });
    return { session, isNew: true };
  }

  /**
   * Compact an expired session and create a replacement.
   * This records summary information about the old session.
   */
  async function compactSession(
    expiredSessionId: string,
    newSessionInput: CreateMissionSessionInput,
  ): Promise<MissionSessionRow> {
    // Mark old session as compacted (or just update status)
    await db
      .update(missionSessions)
      .set({
        status: "compacted",
        expiresAt: new Date(),
      })
      .where(eq(missionSessions.id, expiredSessionId));

    // Create new session
    const now = new Date();
    const [newSession] = await db
      .insert(missionSessions)
      .values({
        missionId: newSessionInput.missionId,
        agentId: newSessionInput.agentId,
        companyId: newSessionInput.companyId,
        sessionSecretId: newSessionInput.sessionSecretId,
        adapterType: newSessionInput.adapterType,
        status: "active",
        lastActiveAt: now,
        runCount: 0,
        expiresAt: new Date(now.getTime() + DEFAULT_IDLE_TIMEOUT_MS),
      })
      .returning();

    return newSession;
  }

  /**
   * Update last active timestamp and increment run count.
   * Called on each heartbeat / activity.
   */
  async function touch(id: string): Promise<MissionSessionRow> {
    const session = await getById(id);

    // Check if session should be compacted based on policy
    const resolvedPolicy = resolveSessionCompactionPolicy(session.adapterType, null);

    if (
      hasSessionCompactionThresholds(resolvedPolicy.policy) &&
      resolvedPolicy.policy.enabled
    ) {
      const shouldCompact =
        resolvedPolicy.policy.maxSessionRuns > 0 &&
        session.runCount >= resolvedPolicy.policy.maxSessionRuns;

      if (shouldCompact) {
        // Mark this session as needing compaction
        await db
          .update(missionSessions)
          .set({ status: "compacted" })
          .where(eq(missionSessions.id, id));
        // Return the compacted session (caller should get a new one)
        return getById(id);
      }
    }

    // Normal touch — just update lastActiveAt
    const [updated] = await db
      .update(missionSessions)
      .set({
        lastActiveAt: new Date(),
        runCount: session.runCount + 1,
      })
      .where(eq(missionSessions.id, id))
      .returning();

    return updated;
  }

  /**
   * List sessions with optional filters.
   */
  async function list(filter: ListMissionSessionsFilter): Promise<MissionSessionWithAgent[]> {
    const conditions = [];

    if (filter.missionId) conditions.push(eq(missionSessions.missionId, filter.missionId));
    if (filter.agentId) conditions.push(eq(missionSessions.agentId, filter.agentId));
    if (filter.companyId) conditions.push(eq(missionSessions.companyId, filter.companyId));
    if (filter.status) conditions.push(eq(missionSessions.status, filter.status));

    const rows = await db
      .select({
        row: missionSessions,
        agentName: agents.name,
      })
      .from(missionSessions)
      .leftJoin(agents, eq(missionSessions.agentId, agents.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(missionSessions.createdAt));

    return rows.map((r: { row: MissionSessionRow; agentName: string | null }) => ({ ...r.row, agentName: r.agentName ?? undefined }));
  }

  /**
   * Mark a session as expired.
   */
  async function expire(id: string): Promise<MissionSessionRow> {
    const [updated] = await db
      .update(missionSessions)
      .set({ status: "expired" })
      .where(eq(missionSessions.id, id))
      .returning();

    return updated;
  }

  /**
   * Delete a session.
   */
  async function deleteSession(id: string): Promise<void> {
    await db.delete(missionSessions).where(eq(missionSessions.id, id));
  }

  /**
   * Find sessions that have been idle beyond their expiresAt.
   * Used by cleanup jobs.
   */
  async function findExpiredSessions(companyId: string): Promise<MissionSessionRow[]> {
    const cutoff = new Date(Date.now() - EXPIRY_GRACE_PERIOD_MS);

    return db
      .select()
      .from(missionSessions)
      .where(
        and(
          eq(missionSessions.companyId, companyId),
          eq(missionSessions.status, "active"),
          lt(missionSessions.expiresAt, cutoff),
        ),
      );
  }

  /**
   * Check if a session should be compacted based on session compaction policy.
   */
  async function shouldCompact(id: string): Promise<boolean> {
    const session = await getById(id);
    const resolvedPolicy = resolveSessionCompactionPolicy(session.adapterType, null);

    if (!resolvedPolicy.policy.enabled) return false;

    if (resolvedPolicy.policy.maxSessionRuns > 0 && session.runCount >= resolvedPolicy.policy.maxSessionRuns) {
      return true;
    }

    return false;
  }

  return {
    create,
    getById,
    getOrCreate,
    compactSession,
    touch,
    list,
    expire,
    delete: deleteSession,
    findExpiredSessions,
    shouldCompact,
  };
}

export type MissionSessionStore = ReturnType<typeof missionSessionStore>;

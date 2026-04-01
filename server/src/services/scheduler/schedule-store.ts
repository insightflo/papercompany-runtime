/**
 * Schedule Store
 *
 * Database access layer for schedules.
 * Provides CRUD operations for agent wakeup schedules.
 */

import type { Db } from "@paperclipai/db";
import { schedules } from "@paperclipai/db";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { computeNextRun } from "./cron-wakeup.js";
import type {
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
} from "./types.js";

/**
 * Schedule store service.
 */
export const scheduleStore = {
  /**
   * Create a new schedule.
   */
  async createSchedule(db: Db, input: CreateScheduleInput): Promise<Schedule> {
    const id = crypto.randomUUID();
    const now = new Date();

    // Compute the first next run time
    const nextRunAt = computeNextRun(
      input.cronExpression,
      input.timezone ?? "UTC",
      now,
    );

    await db.insert(schedules).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      cronExpression: input.cronExpression,
      timezone: input.timezone ?? "UTC",
      missionId: input.missionId ?? null,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });

    const result = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);

    if (!result[0]) {
      throw new Error("Failed to create schedule");
    }

    return toSchedule(result[0]);
  },

  /**
   * Get a schedule by ID.
   */
  async getScheduleById(db: Db, id: string): Promise<Schedule | null> {
    const result = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);

    if (!result[0]) return null;
    return toSchedule(result[0]);
  },

  /**
   * List schedules for a company.
   */
  async listSchedules(
    db: Db,
    companyId: string,
    options: { enabled?: boolean; agentId?: string } = {},
  ): Promise<Schedule[]> {
    const conditions = [eq(schedules.companyId, companyId)];

    if (options.enabled !== undefined) {
      conditions.push(eq(schedules.enabled, options.enabled));
    }

    if (options.agentId) {
      conditions.push(eq(schedules.agentId, options.agentId));
    }

    const results = await db
      .select()
      .from(schedules)
      .where(and(...conditions))
      .orderBy(desc(schedules.nextRunAt));

    return results.map(toSchedule);
  },

  /**
   * Update a schedule.
   */
  async updateSchedule(
    db: Db,
    id: string,
    updates: UpdateScheduleInput,
  ): Promise<Schedule | null> {
    const existing = await this.getScheduleById(db, id);
    if (!existing) return null;

    const updateData: Partial<Schedule> = {
      ...updates,
      updatedAt: new Date(),
    };

    // If cron expression or timezone changed, recompute next run
    if (updates.cronExpression || updates.timezone) {
      const cronExpression = updates.cronExpression ?? existing.cronExpression;
      const timezone = updates.timezone ?? existing.timezone;
      const nextRunAt = computeNextRun(cronExpression, timezone, new Date());
      updateData.nextRunAt = nextRunAt as Date | null;
    }

    await db
      .update(schedules)
      .set(updateData)
      .where(eq(schedules.id, id));

    return this.getScheduleById(db, id);
  },

  /**
   * Delete a schedule.
   */
  async deleteSchedule(db: Db, id: string): Promise<boolean> {
    const result = await db
      .delete(schedules)
      .where(eq(schedules.id, id));

    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Get the scheduler state summary.
   */
  async getSchedulerState(db: Db): Promise<{
    activeScheduleCount: number;
    totalScheduleCount: number;
  }> {
    const [activeResult, totalResult] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schedules)
        .where(eq(schedules.enabled, true)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schedules),
    ]);

    return {
      activeScheduleCount: activeResult[0]?.count ?? 0,
      totalScheduleCount: totalResult[0]?.count ?? 0,
    };
  },
};

/**
 * Convert database row to Schedule type.
 */
function toSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: String(row.id),
    companyId: String(row.companyId),
    agentId: String(row.agentId),
    cronExpression: String(row.cronExpression),
    timezone: String(row.timezone),
    missionId: (row.missionId as string | null) ?? null,
    enabled: Boolean(row.enabled),
    lastRunAt: (row.lastRunAt as Date | null) ?? null,
    nextRunAt: (row.nextRunAt as Date | null) ?? null,
    createdAt: new Date(row.createdAt as Date),
    updatedAt: new Date(row.updatedAt as Date),
  };
}

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { pluginJobRuns, pluginJobs, type Db } from "@paperclipai/db";
import type { PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";
import { notFound } from "../errors.js";

export interface CreateJobRunInput {
  jobId: string;
  pluginId: string;
  trigger: PluginJobRunTrigger;
}

export interface CompleteJobRunInput {
  status: PluginJobRunStatus;
  error?: string | null;
  durationMs?: number | null;
}

export function pluginJobRunStore(db: Db) {
  return {
    async createRun(input: CreateJobRunInput): Promise<typeof pluginJobRuns.$inferSelect> {
      const [run] = await db.insert(pluginJobRuns).values({
        jobId: input.jobId,
        pluginId: input.pluginId,
        trigger: input.trigger,
        status: "queued",
      }).returning();
      return run!;
    },

    async createOrReuseQueuedScheduledRun(
      input: Omit<CreateJobRunInput, "trigger">,
    ): Promise<{ run: typeof pluginJobRuns.$inferSelect; created: boolean }> {
      return db.transaction(async (tx) => {
        const [job] = await tx.select({ id: pluginJobs.id }).from(pluginJobs).where(and(
          eq(pluginJobs.id, input.jobId),
          eq(pluginJobs.pluginId, input.pluginId),
        )).for("update").limit(1);
        if (!job) throw notFound(`Plugin job not found: ${input.jobId}`);

        const [queued] = await tx.select().from(pluginJobRuns).where(and(
          eq(pluginJobRuns.jobId, input.jobId),
          eq(pluginJobRuns.pluginId, input.pluginId),
          or(
            eq(pluginJobRuns.status, "running"),
            and(
              eq(pluginJobRuns.trigger, "schedule"),
              eq(pluginJobRuns.status, "queued"),
              isNull(pluginJobRuns.startedAt),
            ),
          ),
        )).orderBy(asc(pluginJobRuns.createdAt), asc(pluginJobRuns.id)).limit(1);
        if (queued) return { run: queued, created: false };

        const [run] = await tx.insert(pluginJobRuns).values({
          ...input,
          trigger: "schedule",
          status: "queued",
        }).returning();
        return { run: run!, created: true };
      });
    },

    async claimQueuedRun(
      runId: string,
      startedAt = new Date(),
    ): Promise<(typeof pluginJobRuns.$inferSelect) | null> {
      return db.transaction(async (tx) => {
        const [candidate] = await tx.select({ jobId: pluginJobRuns.jobId }).from(pluginJobRuns)
          .where(eq(pluginJobRuns.id, runId)).limit(1);
        if (!candidate) return null;
        await tx.select({ id: pluginJobs.id }).from(pluginJobs)
          .where(eq(pluginJobs.id, candidate.jobId)).for("update").limit(1);
        const [running] = await tx.select({ id: pluginJobRuns.id }).from(pluginJobRuns).where(and(
          eq(pluginJobRuns.jobId, candidate.jobId),
          eq(pluginJobRuns.status, "running"),
        )).limit(1);
        if (running) return null;
        const [claimed] = await tx.update(pluginJobRuns).set({ status: "running", startedAt, claimToken: randomUUID() }).where(and(
          eq(pluginJobRuns.id, runId),
          eq(pluginJobRuns.status, "queued"),
          isNull(pluginJobRuns.startedAt),
          isNull(pluginJobRuns.finishedAt),
        )).returning();
        return claimed ?? null;
      });
    },

    async releaseUnstartedClaim(runId: string, claimToken: string): Promise<boolean> {
      const [released] = await db.update(pluginJobRuns).set({ status: "queued", startedAt: null, claimToken: null }).where(and(
        eq(pluginJobRuns.id, runId),
        eq(pluginJobRuns.status, "running"),
        eq(pluginJobRuns.claimToken, claimToken),
        isNull(pluginJobRuns.finishedAt),
      )).returning({ id: pluginJobRuns.id });
      return Boolean(released);
    },

    async markRunning(runId: string): Promise<void> {
      await db.update(pluginJobRuns).set({ status: "running", startedAt: new Date() })
        .where(eq(pluginJobRuns.id, runId));
    },

    async completeRun(runId: string, input: CompleteJobRunInput): Promise<void> {
      await db.update(pluginJobRuns).set({
        status: input.status,
        error: input.error ?? null,
        durationMs: input.durationMs ?? null,
        finishedAt: new Date(),
      }).where(eq(pluginJobRuns.id, runId));
    },

    async getRunById(runId: string): Promise<(typeof pluginJobRuns.$inferSelect) | null> {
      const [run] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, runId));
      return run ?? null;
    },

    async listRunsByJob(jobId: string, limit = 50): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      return db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId))
        .orderBy(desc(pluginJobRuns.createdAt)).limit(limit);
    },

    async listRunsByPlugin(
      pluginId: string,
      status?: PluginJobRunStatus,
      limit = 50,
    ): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      const conditions = [eq(pluginJobRuns.pluginId, pluginId)];
      if (status) conditions.push(eq(pluginJobRuns.status, status));
      return db.select().from(pluginJobRuns).where(and(...conditions))
        .orderBy(desc(pluginJobRuns.createdAt)).limit(limit);
    },

    async listQueuedRunsByPlugin(
      pluginId: string,
      limit = 50,
    ): Promise<(typeof pluginJobRuns.$inferSelect)[]> {
      return db.select().from(pluginJobRuns).where(and(
        eq(pluginJobRuns.pluginId, pluginId),
        eq(pluginJobRuns.status, "queued"),
        isNull(pluginJobRuns.startedAt),
        isNull(pluginJobRuns.finishedAt),
      ))
        .orderBy(asc(pluginJobRuns.createdAt), asc(pluginJobRuns.id)).limit(limit);
    },
  };
}

export type PluginJobRunStore = ReturnType<typeof pluginJobRunStore>;

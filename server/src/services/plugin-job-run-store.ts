import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { pluginJobRuns, pluginJobs, type Db } from "@paperclipai/db";
import type { PluginJobRunStatus, PluginJobRunTrigger } from "@paperclipai/shared";
import { admitScheduledRun, finalizeClaimedRun, type ClaimedRunCompletion } from "./plugin-job-scheduled-store.js";

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

const replayable = () => and(
  eq(pluginJobRuns.status, "queued"),
  isNull(pluginJobRuns.startedAt), isNull(pluginJobRuns.finishedAt),
  isNull(pluginJobRuns.claimToken), isNull(pluginJobRuns.completionUncertainty),
  or(eq(pluginJobRuns.trigger, "manual"), eq(pluginJobRuns.trigger, "retry"), and(
    eq(pluginJobRuns.trigger, "schedule"),
    isNotNull(pluginJobRuns.scheduledAt), isNotNull(pluginJobRuns.scheduledCron),
  )),
);

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
    ) {
      return admitScheduledRun(db, input);
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
          replayable(),
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
        isNull(pluginJobRuns.completionUncertainty),
      )).returning({ id: pluginJobRuns.id });
      return Boolean(released);
    },

    async markCompletionUncertain(runId: string, claimToken: string): Promise<boolean> {
      const [run] = await db.update(pluginJobRuns).set({
        completionUncertainty: "external_execution_sent_or_unknown",
      }).where(and(
        eq(pluginJobRuns.id, runId), eq(pluginJobRuns.claimToken, claimToken),
        eq(pluginJobRuns.status, "running"), isNull(pluginJobRuns.finishedAt),
      )).returning({ id: pluginJobRuns.id });
      return Boolean(run);
    },

    async finalizeClaimedRun(runId: string, claimToken: string, input: ClaimedRunCompletion) {
      return finalizeClaimedRun(db, runId, claimToken, input);
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
        replayable(),
      ))
        .orderBy(asc(pluginJobRuns.createdAt), asc(pluginJobRuns.id)).limit(limit);
    },
  };
}

export type PluginJobRunStore = ReturnType<typeof pluginJobRunStore>;

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { pluginJobRuns, pluginJobs, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { nextCronTick, parseCron, validateCron } from "./cron.js";

type Run = typeof pluginJobRuns.$inferSelect;

export type ScheduledAdmission =
  | { kind: "available"; run: Run; created: boolean }
  | { kind: "held"; run: null; created: false; reason: "missing_slot" | "not_due" | "slot_recorded" };

export type ClaimedRunCompletion = {
  status: "succeeded" | "failed";
  error?: string | null;
  durationMs?: number | null;
};

export async function admitScheduledRun(
  db: Db,
  input: { jobId: string; pluginId: string },
): Promise<ScheduledAdmission> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(pluginJobs).where(and(
      eq(pluginJobs.id, input.jobId), eq(pluginJobs.pluginId, input.pluginId),
    )).for("update").limit(1);
    if (!job) throw notFound(`Plugin job not found: ${input.jobId}`);

    const [existing] = await tx.select().from(pluginJobRuns).where(and(
      eq(pluginJobRuns.jobId, input.jobId), eq(pluginJobRuns.pluginId, input.pluginId),
      or(
        eq(pluginJobRuns.status, "running"),
        and(eq(pluginJobRuns.trigger, "schedule"), eq(pluginJobRuns.status, "queued")),
      ),
    )).orderBy(asc(pluginJobRuns.createdAt), asc(pluginJobRuns.id)).limit(1);
    if (existing) {
      if (existing.trigger === "schedule" && (!existing.scheduledAt || !existing.scheduledCron)) {
        return { kind: "held", run: null, created: false, reason: "missing_slot" };
      }
      return { kind: "available", run: existing, created: false };
    }
    if (!job.nextRunAt || !job.schedule) {
      return { kind: "held", run: null, created: false, reason: "missing_slot" };
    }
    if (job.nextRunAt.getTime() > Date.now()) {
      return { kind: "held", run: null, created: false, reason: "not_due" };
    }
    const [recorded] = await tx.select({ id: pluginJobRuns.id }).from(pluginJobRuns).where(and(
      eq(pluginJobRuns.jobId, job.id), eq(pluginJobRuns.trigger, "schedule"),
      eq(pluginJobRuns.scheduledAt, job.nextRunAt),
    )).limit(1);
    if (recorded) return { kind: "held", run: null, created: false, reason: "slot_recorded" };

    const [run] = await tx.insert(pluginJobRuns).values({
      ...input, trigger: "schedule", status: "queued",
      scheduledAt: job.nextRunAt, scheduledCron: job.schedule,
    }).returning();
    return { kind: "available", run: run!, created: true };
  });
}

export async function finalizeClaimedRun(
  db: Db,
  runId: string,
  claimToken: string,
  input: ClaimedRunCompletion,
): Promise<"finalized" | "already_finalized" | "rejected"> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ jobId: pluginJobRuns.jobId }).from(pluginJobRuns)
      .where(eq(pluginJobRuns.id, runId)).limit(1);
    if (!candidate) return "rejected";
    const [job] = await tx.select().from(pluginJobs).where(eq(pluginJobs.id, candidate.jobId))
      .for("update").limit(1);
    if (!job) return "rejected";

    const finishedAt = new Date();
    const [run] = await tx.update(pluginJobRuns).set({
      status: input.status, error: input.error ?? null, durationMs: input.durationMs ?? null,
      finishedAt, completionUncertainty: null,
    }).where(and(
      eq(pluginJobRuns.id, runId), eq(pluginJobRuns.claimToken, claimToken),
      eq(pluginJobRuns.status, "running"), isNull(pluginJobRuns.finishedAt),
    )).returning();
    if (!run) {
      const [terminal] = await tx.select().from(pluginJobRuns).where(and(
        eq(pluginJobRuns.id, runId), eq(pluginJobRuns.claimToken, claimToken),
        or(eq(pluginJobRuns.status, "succeeded"), eq(pluginJobRuns.status, "failed")),
      )).limit(1);
      return terminal?.finishedAt ? "already_finalized" : "rejected";
    }

    if (run.trigger === "schedule" && run.scheduledAt && run.scheduledCron &&
        job.nextRunAt?.getTime() === run.scheduledAt.getTime() && job.schedule === run.scheduledCron &&
        !validateCron(run.scheduledCron)) {
      const nextRunAt = nextCronTick(parseCron(run.scheduledCron), finishedAt);
      await tx.update(pluginJobs).set({ lastRunAt: finishedAt, nextRunAt, updatedAt: finishedAt })
        .where(and(
          eq(pluginJobs.id, run.jobId), eq(pluginJobs.nextRunAt, run.scheduledAt),
          eq(pluginJobs.schedule, run.scheduledCron),
        ));
    }
    return "finalized";
  });
}

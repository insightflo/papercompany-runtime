import {
  and, eq, inArray, isNotNull, isNull, notInArray, or, sql,
} from "drizzle-orm";
import { pluginJobRuns, pluginWebhookDeliveries, type Db } from "@paperclipai/db";
import { HttpError, notFound } from "../errors.js";

type PurgeTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PurgeMode = "plugin" | "jobs";
type PurgeConflictReason = "protected_job_run" | "protected_webhook" | "lock_not_available";

const terminalRunStatuses: ("succeeded" | "failed" | "cancelled")[] = ["succeeded", "failed", "cancelled"];
const terminalWebhookStatuses: ("success" | "failed")[] = ["success", "failed"];

export class PluginPurgeConflict extends HttpError {
  readonly code = "PLUGIN_PURGE_CONFLICT";

  constructor(readonly reason: PurgeConflictReason) {
    super(409, purgeConflictMessage(reason), {
      code: "PLUGIN_PURGE_CONFLICT",
      reason,
      ...(reason === "lock_not_available" ? { sqlState: "55P03" } : {}),
    });
    this.name = "PluginPurgeConflict";
  }
}

function purgeConflictMessage(reason: PurgeConflictReason): string {
  if (reason === "lock_not_available") return "Plugin purge refused because target data is currently locked";
  if (reason === "protected_webhook") return "Plugin purge refused because webhook deliveries are unfinished";
  return "Plugin purge refused because job runs are not positively finalized";
}

function hasSqlState(error: unknown, wanted: string): boolean {
  const visited = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = current as { code?: unknown; cause?: unknown; originalError?: unknown };
    if (value.code === wanted) return true;
    current = value.cause ?? value.originalError;
  }
  return false;
}

function affectedRuns(pluginId: string, mode: PurgeMode, jobIds: string[]) {
  const jobScope = jobIds.length ? inArray(pluginJobRuns.jobId, jobIds) : sql`false`;
  return mode === "plugin"
    ? or(eq(pluginJobRuns.pluginId, pluginId), jobScope)!
    : jobScope;
}

export async function withPluginPurgeGuard<T>(
  db: Db,
  input: {
    pluginId: string;
    mode: PurgeMode;
    delete: (tx: PurgeTx) => Promise<T>;
  },
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      const plugin = await tx.execute(sql`SELECT id FROM plugins WHERE id = ${input.pluginId} FOR UPDATE NOWAIT`);
      if (plugin.length === 0) {
        if (input.mode === "plugin") throw notFound("Plugin not found");
        return undefined as T;
      }

      const jobs = await tx.execute(sql`SELECT id FROM plugin_jobs
        WHERE plugin_id = ${input.pluginId} ORDER BY id FOR UPDATE NOWAIT`);
      const jobIds = jobs.map((job) => String(job.id));
      const runScope = affectedRuns(input.pluginId, input.mode, jobIds);

      await tx.execute(sql`SELECT id FROM plugin_job_runs WHERE ${runScope} ORDER BY id FOR UPDATE NOWAIT`);

      if (input.mode === "plugin") {
        await tx.execute(sql`SELECT id FROM plugin_webhook_deliveries
          WHERE plugin_id = ${input.pluginId} ORDER BY id FOR UPDATE NOWAIT`);
      }

      const protectedRuns = await tx.select({ id: pluginJobRuns.id }).from(pluginJobRuns).where(and(
        runScope,
        or(
          isNull(pluginJobRuns.status),
          notInArray(pluginJobRuns.status, terminalRunStatuses),
          isNull(pluginJobRuns.finishedAt),
          isNotNull(pluginJobRuns.completionUncertainty),
        ),
      ));
      if (protectedRuns.length > 0) throw new PluginPurgeConflict("protected_job_run");

      if (input.mode === "plugin") {
        const protectedWebhooks = await tx.select({ id: pluginWebhookDeliveries.id })
          .from(pluginWebhookDeliveries).where(and(
            eq(pluginWebhookDeliveries.pluginId, input.pluginId),
            or(
              isNull(pluginWebhookDeliveries.status),
              notInArray(pluginWebhookDeliveries.status, terminalWebhookStatuses),
              isNull(pluginWebhookDeliveries.finishedAt),
            ),
          ));
        if (protectedWebhooks.length > 0) throw new PluginPurgeConflict("protected_webhook");
      }

      return input.delete(tx);
    });
  } catch (error) {
    if (error instanceof PluginPurgeConflict) throw error;
    if (hasSqlState(error, "55P03")) throw new PluginPurgeConflict("lock_not_available");
    throw error;
  }
}

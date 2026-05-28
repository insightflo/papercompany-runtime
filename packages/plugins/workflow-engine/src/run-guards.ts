import type { PluginContext } from "@paperclipai/plugin-sdk";

import { RUN_STATUSES } from "./constants.js";
import { formatDateKeyInTimezone } from "./workflow-store.js";
import { listWorkflowRunsByWorkflowId } from "./workflow-store.js";
import { toWorkflowRunRecord } from "./workflow-utils.js";

const BLOCKING_RUN_STATUSES = new Set<string>([
  RUN_STATUSES.running,
  RUN_STATUSES.completed,
]);

function toDayKey(value: string, timezone?: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return formatDateKeyInTimezone(new Date(parsed), timezone);
}

export interface DailyRunGuardResult {
  blocked: boolean;
  dayKey: string;
  existingRunId?: string;
  existingStatus?: string;
}

export async function checkDailyRunGuard(
  ctx: PluginContext,
  companyId: string,
  workflowId: string,
  referenceDate: Date = new Date(),
  timezone?: string,
): Promise<DailyRunGuardResult> {
  const dayKey = formatDateKeyInTimezone(referenceDate, timezone) ?? referenceDate.toISOString().slice(0, 10);
  const runs = await listWorkflowRunsByWorkflowId(ctx, companyId, workflowId);

  for (const runRecord of runs) {
    const run = toWorkflowRunRecord(runRecord);
    if (!BLOCKING_RUN_STATUSES.has(run.data.status)) {
      continue;
    }

    const runDay = toDayKey(run.data.startedAt, timezone);
    if (runDay !== dayKey) {
      continue;
    }

    return {
      blocked: true,
      dayKey,
      existingRunId: run.id,
      existingStatus: run.data.status,
    };
  }

  return {
    blocked: false,
    dayKey,
  };
}

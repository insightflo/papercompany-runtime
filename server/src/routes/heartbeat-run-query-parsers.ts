import { badRequest } from "../errors.js";
import { clampRunListLimit, clampAttentionLimit, clampStatsDays } from "../services/heartbeat-bounded-reads.js";

export const HEARTBEAT_RUN_STATUS_VALUES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export function parseOptionalAgentId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

export function parseRunListLimit(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest("Invalid limit");
  return clampRunListLimit(parsed);
}

export function parseRunStatsDays(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest("Invalid days");
  return clampStatsDays(parsed);
}

export function parseAttentionLimit(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest("Invalid limit");
  return clampAttentionLimit(parsed);
}

export function parseRunStatuses(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const statuses = value.split(",").map((status) => status.trim()).filter(Boolean);
  for (const status of statuses) {
    if (!HEARTBEAT_RUN_STATUS_VALUES.has(status)) throw badRequest(`Invalid status: ${status}`);
  }
  return statuses.length > 0 ? statuses : undefined;
}

export function parseRunCursor(value: unknown): { createdAt: Date; id: string } | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const raw = value.trim();
  const separatorIndex = raw.indexOf("_");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) throw badRequest("Invalid cursor");
  const createdAt = new Date(raw.slice(0, separatorIndex));
  const id = raw.slice(separatorIndex + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) throw badRequest("Invalid cursor");
  return { createdAt, id };
}

const MAX_DISMISSED_RUN_IDS = 200;

export function parseDismissedRunIds(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  return ids.slice(0, MAX_DISMISSED_RUN_IDS);
}

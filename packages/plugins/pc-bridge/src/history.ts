import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PcBridgeConfig } from "./config.js";
import type { BridgePublishResult } from "./bridge.js";
import type { ValidatedPublishRequest } from "./validate.js";

export type PublishSource = "tool" | "ui" | "webhook";

export type PublishHistoryEntry = {
  id: string;
  requestedAt: string;
  source: PublishSource;
  url: string;
  workflow: string | null;
  category: string | null;
  ok: boolean;
  httpStatus: number | null;
  permalink: string | null;
  title: string | null;
  imageCount: number | null;
  error: string | null;
  message: string | null;
  durationMs: number;
};

export type PublishOutcome = {
  entry: PublishHistoryEntry;
  result: BridgePublishResult;
};

const HISTORY_STATE_KEY = { scopeKind: "instance", stateKey: "publish-history" } as const;
// Upper bound read when rewriting history so a lowered historyLimit trims
// older entries on the next write.
const MAX_STORED = 500;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function listPublishHistory(
  ctx: PluginContext,
  limit: number,
): Promise<PublishHistoryEntry[]> {
  const stored = await ctx.state.get(HISTORY_STATE_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }

  return stored
    .filter((item): item is PublishHistoryEntry => Boolean(item) && typeof item === "object")
    .slice(0, Math.max(1, limit));
}

export function buildHistoryEntry(args: {
  source: PublishSource;
  request: ValidatedPublishRequest;
  result: BridgePublishResult;
  durationMs: number;
}): PublishHistoryEntry {
  const body = args.result.body;

  return {
    id: randomUUID(),
    requestedAt: new Date().toISOString(),
    source: args.source,
    url: args.request.url,
    workflow: args.request.workflow,
    category: asString(body?.category) ?? args.request.category,
    ok: args.result.ok,
    httpStatus: args.result.httpStatus,
    permalink: asString(body?.url),
    title: asString(body?.title),
    imageCount: asNumberOrNull(body?.image_count),
    error: args.result.error ?? asString(body?.error),
    message: asString(body?.message),
    durationMs: args.durationMs,
  };
}

export async function recordPublishHistory(
  ctx: PluginContext,
  config: PcBridgeConfig,
  entry: PublishHistoryEntry,
): Promise<void> {
  const existing = await listPublishHistory(ctx, MAX_STORED);
  const next = [entry, ...existing].slice(0, Math.max(1, config.historyLimit));
  await ctx.state.set(HISTORY_STATE_KEY, next);
}

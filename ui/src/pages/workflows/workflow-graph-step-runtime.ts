// Readers for workflow-step run state, retention records, edge metadata and container presentation.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphConcurrencyBlocked, WorkflowGraphEdgeMetadata, WorkflowGraphEdgeMetadataRecord, WorkflowGraphRetentionDeleted, WorkflowGraphStep, WorkflowGraphStepRunStatus, WorkflowGraphWorkProduct } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainerType } from "./workflow-graph-types-model.js";
import { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
import { normalizeGraphEdgeKind } from "./workflow-graph-edge-kind.js";

function buildStepMap<TStep extends WorkflowGraphStep>(steps: TStep[]): Map<string, TStep> {
  return new Map(steps.filter((step) => step.id.trim()).map((step) => [step.id.trim(), step]));
}

function readStepRunStatus(step: WorkflowGraphStep): WorkflowGraphStepRunStatus {
  const concurrencyBlocked = readConcurrencyBlocked(step.graphRunConcurrencyBlocked);
  const retentionDeleted = readRetentionDeleted(step.graphRunRetentionDeleted);
  return {
    status: normalizeGraphRunStatus(step.graphRunStatus),
    stepRunId: typeof step.graphRunStepRunId === "string" ? step.graphRunStepRunId.trim() : "",
    issueId: typeof step.graphRunIssueId === "string" ? step.graphRunIssueId.trim() : "",
    issueIdentifier: typeof step.graphRunIssueIdentifier === "string" ? step.graphRunIssueIdentifier.trim() : "",
    updatedAt: typeof step.graphRunUpdatedAt === "string" ? step.graphRunUpdatedAt.trim() : "",
    summary: typeof step.graphRunSummary === "string" ? step.graphRunSummary.trim() : "",
    startedAt: typeof step.graphRunStartedAt === "string" ? step.graphRunStartedAt.trim() : "",
    completedAt: typeof step.graphRunCompletedAt === "string" ? step.graphRunCompletedAt.trim() : "",
    lastDispatchAttemptAt: typeof step.graphRunLastDispatchAttemptAt === "string" ? step.graphRunLastDispatchAttemptAt.trim() : "",
    lastDispatchAcceptedAt: typeof step.graphRunLastDispatchAcceptedAt === "string" ? step.graphRunLastDispatchAcceptedAt.trim() : "",
    lastDispatchErrorAt: typeof step.graphRunLastDispatchErrorAt === "string" ? step.graphRunLastDispatchErrorAt.trim() : "",
    lastDispatchErrorSummary: typeof step.graphRunLastDispatchErrorSummary === "string" ? step.graphRunLastDispatchErrorSummary.trim() : "",
    lastDispatchRequestId: typeof step.graphRunLastDispatchRequestId === "string" ? step.graphRunLastDispatchRequestId.trim() : "",
    resultPreview: typeof step.graphRunResultPreview === "string" ? step.graphRunResultPreview.trim() : "",
    logPreview: typeof step.graphRunLogPreview === "string" ? step.graphRunLogPreview.trim() : "",
    workProducts: Array.isArray(step.graphRunWorkProducts) ? normalizeWorkProducts(step.graphRunWorkProducts) : [],
    retryCount: typeof step.graphRunRetryCount === "number" ? step.graphRunRetryCount : 0,
    retryMaxRetries: typeof step.graphRunRetryMaxRetries === "number" ? step.graphRunRetryMaxRetries : 0,
    retryState: typeof step.graphRunRetryState === "string" ? step.graphRunRetryState.trim() : "",
    retryNextEligibleAt: typeof step.graphRunRetryNextEligibleAt === "string" ? step.graphRunRetryNextEligibleAt.trim() : "",
    concurrencyBlocked,
    retentionDeleted,
    runtimeBadges: buildRuntimeBadges({
      concurrencyBlocked,
      retentionDeleted,
      resultPreview: typeof step.graphRunResultPreview === "string" ? step.graphRunResultPreview.trim() : "",
      logPreview: typeof step.graphRunLogPreview === "string" ? step.graphRunLogPreview.trim() : "",
    }),
    controlOutcome: typeof step.graphRunControlOutcome === "string" ? step.graphRunControlOutcome.trim() : "",
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function readConcurrencyBlocked(value: unknown): WorkflowGraphConcurrencyBlocked | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const concurrencyKey = readString(record.concurrencyKey);
  if (!concurrencyKey) return undefined;
  return {
    concurrencyKey,
    concurrencyLimit: readOptionalNumber(record.concurrencyLimit),
    runningCount: readOptionalNumber(record.runningCount),
    checkedAt: readString(record.checkedAt),
  };
}

function readRetentionDeleted(value: unknown): WorkflowGraphRetentionDeleted | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const deleteAfterUse = readOptionalBoolean(record.deleteAfterUse) ?? false;
  const toolName = readString(record.toolName);
  const deletedAt = readString(record.deletedAt);
  if (!deleteAfterUse && !toolName && !deletedAt) return undefined;
  return {
    deleteAfterUse,
    toolName,
    success: readOptionalBoolean(record.success),
    exitCode: readOptionalNumber(record.exitCode),
    deletedAt,
  };
}

function buildRuntimeBadges(input: {
  concurrencyBlocked?: WorkflowGraphConcurrencyBlocked;
  retentionDeleted?: WorkflowGraphRetentionDeleted;
  resultPreview?: string;
  logPreview?: string;
}): string[] {
  const badges: string[] = [];
  if (input.resultPreview) badges.push("Result preview");
  if (input.logPreview) badges.push("Log preview");
  if (input.concurrencyBlocked) badges.push(`Concurrency blocked: ${input.concurrencyBlocked.concurrencyKey}`);
  if (input.retentionDeleted?.deleteAfterUse) badges.push("Deleted after use");
  return badges;
}

function normalizeWorkProducts(value: unknown): WorkflowGraphWorkProduct[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!id || !title) return [];
    const product: WorkflowGraphWorkProduct = {
      id,
      title,
      type: typeof record.type === "string" ? record.type.trim() : undefined,
      url: typeof record.url === "string" ? record.url.trim() : null,
      status: typeof record.status === "string" ? record.status.trim() : undefined,
      summary: typeof record.summary === "string" ? record.summary.trim() : null,
    };
    if (typeof record.isPrimary === "boolean") {
      product.isPrimary = record.isPrimary;
    }
    return [product];
  });
}


function readGraphEdgeMetadata(step: WorkflowGraphStep, sourceId: string): WorkflowGraphEdgeMetadata {
  const record = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
    ? step.graphEdgeMetadata[sourceId]
    : undefined;
  return {
    kind: normalizeGraphEdgeKind(record?.kind),
    label: typeof record?.label === "string" ? record.label.trim() : "",
    condition: typeof record?.condition === "string" ? record.condition.trim() : "",
  };
}

function readForwardConditionalDependencies(step: WorkflowGraphStep): Array<{ stepId: string; when: string }> {
  const sources: unknown[] = [];
  if (Array.isArray(step.conditionalDependencies)) sources.push(...step.conditionalDependencies);
  const extra = step.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const extraEdges = (extra as Record<string, unknown>).conditionalDependencies;
    if (Array.isArray(extraEdges)) sources.push(...extraEdges);
  }
  const seen = new Set<string>();
  const result: Array<{ stepId: string; when: string }> = [];
  for (const edge of sources) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) continue;
    const value = edge as Record<string, unknown>;
    if (value.isBackEdge === true) continue;
    const stepId = typeof value.stepId === "string" ? value.stepId.trim() : "";
    const when = typeof value.when === "string" ? value.when.trim() : "success";
    if (!stepId) continue;
    const key = `${stepId}|${when}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ stepId, when });
  }
  return result;
}

function conditionalGraphEdgeMetadata(when: string): WorkflowGraphEdgeMetadata {
  if (when === "condition_true") return { kind: "conditional", label: "true", condition: "IF condition matched" };
  if (when === "condition_false") return { kind: "conditional", label: "false", condition: "IF condition did not match" };
  if (when === "failure") return { kind: "failure", label: "failure", condition: "upstream step failed" };
  if (when === "always") return { kind: "conditional", label: "always", condition: "upstream step reached a terminal state" };
  return { kind: "normal", label: "", condition: "" };
}

function readGraphPositionValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function compactGraphEdgeMetadata(metadata: WorkflowGraphEdgeMetadataRecord): WorkflowGraphEdgeMetadataRecord | undefined {
  const entries = Object.entries(metadata)
    .map(([sourceId, value]) => {
      const source = sourceId.trim();
      if (!source) return null;
      const kind = normalizeGraphEdgeKind(value?.kind);
      const label = typeof value?.label === "string" ? value.label.trim() : "";
      const condition = typeof value?.condition === "string" ? value.condition.trim() : "";
      if (kind === "normal" && !label && !condition) return null;
      return [source, { kind, label, condition }] as const;
    })
    .filter((entry): entry is readonly [string, WorkflowGraphEdgeMetadata] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeGraphContainerMode(type: WorkflowGraphContainerType, value: unknown): string {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (type === "loop") {
    return mode === "while" ? "while" : "for-each";
  }
  return mode === "branch-all" ? "branch-all" : "branch-one";
}

function buildContainerBadges(input: {
  type: WorkflowGraphContainerType;
  mode: string;
  condition: string;
  iterator: string;
  skipFailure: boolean;
  runInParallel: boolean;
  parallelism: number | null;
}): string[] {
  const badges: string[] = [];
  if (input.type === "branch") {
    badges.push(input.mode === "branch-all" ? "Branch all" : "Branch one");
    if (input.condition) badges.push("Conditional");
    return badges;
  }
  badges.push(input.mode === "while" ? "While" : "For each");
  if (input.runInParallel) badges.push(`Parallel x${input.parallelism ?? 0}`);
  if (input.skipFailure) badges.push("Skip failure");
  return badges;
}

export {
  buildStepMap,
  readStepRunStatus,
  readRecord,
  readString,
  readOptionalNumber,
  readOptionalBoolean,
  readConcurrencyBlocked,
  readRetentionDeleted,
  buildRuntimeBadges,
  normalizeWorkProducts,
  readGraphEdgeMetadata,
  readForwardConditionalDependencies,
  conditionalGraphEdgeMetadata,
  readGraphPositionValue,
  compactGraphEdgeMetadata,
  normalizeGraphContainerMode,
  buildContainerBadges,
};

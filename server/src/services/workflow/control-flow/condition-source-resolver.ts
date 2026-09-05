/**
 * [purpose] Resolve IF condition sources to parsed JSON roots, scoped to the current
 *   company + workflow run and restricted to forward-ancestor producer steps whose
 *   current completed attempt produced the artifact. Reuses the canonical local-file
 *   path resolver and the existing workflowStepRuns↔issue work-product join, then reads
 *   a bounded JSON file without logging its contents.
 * [safety] Fail-closed: a source step that is not a forward ancestor, a foreign run,
 *   an archived product, a stale prior-attempt artifact, an ambiguous equal-rank
 *   duplicate, an oversized/growing file, or invalid UTF-8/JSON throws — missing data
 *   must never silently route a run to completion. No raw work-product content is logged.
 * [links] Consumed by control-node-executor.ts. Depends on work-products.ts (path resolver),
 *   control-flow/types (ConditionalEdge), and the shared condition contract.
 */
import { open as fsOpen } from "node:fs/promises";
import { and, desc, eq, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowConditionSource, WorkflowToolJsonSource } from "@paperclipai/shared";
import type { ConditionalEdge } from "./types.js";
import { resolveWorkProductLocalFilePath } from "../../work-products.js";
import { secretService } from "../../secrets.js";
import { WorkProductConditionWaitableError } from "./waitable-condition-error.js";

export const WORKFLOW_IF_CONDITION_ERROR_PREFIX = "Workflow IF condition failed:";
const ERROR_PREFIX = WORKFLOW_IF_CONDITION_ERROR_PREFIX;
const MAX_CONDITION_SOURCE_BYTES = 1024 * 1024; // 1 MiB hard cap.
const READ_CHUNK_SIZE = Math.min(64 * 1024, MAX_CONDITION_SOURCE_BYTES);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ConditionResolverStep = {
  id: string;
  dependencies?: string[];
  dependsOn?: string[];
  conditionalDependencies?: ConditionalEdge[];
};

function fail(message: string): never {
  throw new Error(`${ERROR_PREFIX} ${message}`);
}

/** Builds the fail-closed error every IF condition failure must carry. */
export function workflowConditionFailure(message: string): never {
  fail(message);
}

/** Stable internal key for a source so the executor can look up the resolved root. */
export function workflowConditionSourceKey(source: WorkflowConditionSource): string {
  if (source.kind === "tool_json") {
    return `tool_json\u0000${source.stepId}\u0000${source.toolName}\u0000${stableStringify(source.parameters)}\u0000${source.path}`;
  }
  return `work_product_json\u0000${source.stepId}\u0000${source.title}\u0000${source.path}`;
}

/** Deterministic JSON string with sorted object keys (canonical tool-source dedupe key). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function buildForwardPredecessors(steps: ReadonlyArray<ConditionResolverStep>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const step of steps) {
    const preds = new Set<string>();
    const legacy = step.dependencies ?? step.dependsOn ?? [];
    for (const dep of legacy) {
      if (typeof dep === "string" && dep.length > 0) preds.add(dep);
    }
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge && edge.isBackEdge !== true && typeof edge.stepId === "string" && edge.stepId.length > 0) {
        preds.add(edge.stepId);
      }
    }
    map.set(step.id, preds);
  }
  return map;
}

/** Step IDs that can reach `startId` through forward (non-back-edge) edges. Excludes startId. */
function collectForwardAncestors(startId: string, steps: ReadonlyArray<ConditionResolverStep>): Set<string> {
  const predMap = buildForwardPredecessors(steps);
  const ancestors = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const preds = predMap.get(current);
    if (!preds) continue;
    for (const pred of preds) {
      if (!ancestors.has(pred)) {
        ancestors.add(pred);
        stack.push(pred);
      }
    }
  }
  return ancestors;
}

/**
 * Reads up to MAX_CONDITION_SOURCE_BYTES using position-based chunked reads (handles
 * short reads), rejects growth beyond the cap observed after the initial stat, validates
 * UTF-8 fatally, and parses JSON. Never logs file contents.
 */
async function readBoundedJsonFile(filePath: string, title: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
  try {
    handle = await fsOpen(filePath, "r");
    const stat = await handle.stat();
    if (stat.size > MAX_CONDITION_SOURCE_BYTES) {
      fail(`work product "${title}" (${stat.size} bytes) exceeds the ${MAX_CONDITION_SOURCE_BYTES}-byte limit`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      const { bytesRead } = await handle.read(buf, 0, READ_CHUNK_SIZE, total);
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
      if (total > MAX_CONDITION_SOURCE_BYTES) {
        fail(`work product "${title}" grew beyond the ${MAX_CONDITION_SOURCE_BYTES}-byte limit during read`);
      }
      chunks.push(buf.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks);
    let text: string;
    try {
      text = UTF8_DECODER.decode(buffer);
    } catch {
      fail(`work product "${title}" is not valid UTF-8`);
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(`work product "${title}" is not valid JSON`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(ERROR_PREFIX)) throw err;
    fail(`work product "${title}" could not be read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

type CandidateRow = {
  id: string;
  isPrimary: boolean;
  updatedAt: Date;
  path: string;
};

export type CurrentWorkProductCandidate = { path: string; updatedAt: Date };

/**
 * Resolves the single current-attempt local work-product candidate for one
 * (stepId, title) condition source, applying the freshness/ranking rules used at
 * gate evaluation. Fail-closed: a foreign run, non-ancestor step, archived product,
 * stale prior-attempt artifact, or ambiguous equal-rank duplicate throws.
 * Shared by IF evaluation and resume-time verdict staleness checks.
 */
export async function selectCurrentWorkProductCandidate(input: {
  db: Db;
  run: { id: string; companyId: string };
  ifStepId: string;
  workflowSteps: ReadonlyArray<ConditionResolverStep>;
  stepId: string;
  title: string;
}): Promise<CurrentWorkProductCandidate> {
  const { stepId, title } = input;
  const knownStepIds = new Set(input.workflowSteps.map((step) => step.id));
  const ancestors = collectForwardAncestors(input.ifStepId, input.workflowSteps);

  if (stepId === input.ifStepId) {
    fail(`IF step "${input.ifStepId}" cannot read its own output as a condition source`);
  }
  if (!knownStepIds.has(stepId)) {
    fail(`condition source step "${stepId}" does not exist in the workflow`);
  }
  if (!ancestors.has(stepId)) {
    fail(`condition source step "${stepId}" is not a forward ancestor of IF step "${input.ifStepId}"`);
  }

  const rows = await input.db
    .select({
      startedAt: workflowStepRuns.startedAt,
      id: issueWorkProducts.id,
      isPrimary: issueWorkProducts.isPrimary,
      updatedAt: issueWorkProducts.updatedAt,
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
    })
    .from(workflowStepRuns)
    .innerJoin(issueWorkProducts, eq(workflowStepRuns.issueId, issueWorkProducts.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.run.id),
      eq(workflowStepRuns.stepId, stepId),
      eq(workflowStepRuns.status, "completed"),
      eq(issueWorkProducts.companyId, input.run.companyId),
      eq(issueWorkProducts.title, title),
      not(eq(issueWorkProducts.status, "archived")),
    ))
    .orderBy(
      desc(issueWorkProducts.isPrimary),
      desc(issueWorkProducts.updatedAt),
      desc(issueWorkProducts.id),
    );

  if (rows.length === 0) {
    throw new WorkProductConditionWaitableError(
      `${ERROR_PREFIX} no completed-attempt local work product "${title}" found for ancestor step "${stepId}"`,
      { stepId, title },
    );
  }
  const attemptStartedAt = rows[0]!.startedAt;
  if (!attemptStartedAt) {
    // A completed producer without an attempt start time cannot establish artifact
    // freshness; fail closed rather than accept every (possibly stale) artifact.
    fail(`producer step "${stepId}" is completed but has no attempt start time; cannot establish work-product freshness`);
  }

  // Keep only current-attempt, local, path-resolvable candidates. Prior-attempt artifacts
  // (updatedAt before the current completed attempt started) are stale and ignored.
  const candidates: CandidateRow[] = [];
  for (const row of rows) {
    if (row.provider !== "local" && row.provider !== "local_file") continue;
    if (row.updatedAt.getTime() < attemptStartedAt.getTime()) continue;
    const localPath = resolveWorkProductLocalFilePath({ metadata: row.metadata, url: row.url });
    if (!localPath) continue;
    candidates.push({ id: row.id, isPrimary: row.isPrimary, updatedAt: row.updatedAt, path: localPath });
  }

  if (candidates.length === 0) {
    throw new WorkProductConditionWaitableError(
      `${ERROR_PREFIX} no completed-attempt local work product "${title}" found for ancestor step "${stepId}"`,
      { stepId, title },
    );
  }

  candidates.sort((a, b) => (
    Number(b.isPrimary) - Number(a.isPrimary)
    || b.updatedAt.getTime() - a.updatedAt.getTime()
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  ));
  const chosen = candidates[0]!;
  const tiedAtTop = candidates.some(
    (row, index) => index > 0
      && row.isPrimary === chosen.isPrimary
      && row.updatedAt.getTime() === chosen.updatedAt.getTime(),
  );
  if (tiedAtTop) {
    fail(`ambiguous work product "${title}" for step "${stepId}": multiple equally ranked current candidates`);
  }

  return { path: chosen.path, updatedAt: chosen.updatedAt };
}

/**
 * Resolves each condition source to its parsed JSON root. `work_product_json` sources
 * are read from the server-local work-product file; `tool_json` sources are measured
 * live through the injected tool executor (server-side execution). Returns a Map keyed
 * by workflowConditionSourceKey(source).
 */
export async function resolveWorkflowConditionSources(input: {
  db: Db;
  run: { id: string; companyId: string };
  ifStep: ConditionResolverStep;
  workflowSteps: ReadonlyArray<ConditionResolverStep>;
  sources: ReadonlyArray<WorkflowConditionSource>;
  resolveToolJsonSource?: (source: WorkflowToolJsonSource) => Promise<unknown>;
}): Promise<Map<string, unknown>> {
  const ancestors = collectForwardAncestors(input.ifStep.id, input.workflowSteps);
  const out = new Map<string, unknown>();

  // Deduplicate work-product sources by (stepId, title); the same file is read once.
  const uniquePairs = new Map<string, { stepId: string; title: string }>();
  for (const source of input.sources) {
    if (source.kind === "tool_json") continue;
    const pairKey = `${source.stepId}\u0000${source.title}`;
    if (!uniquePairs.has(pairKey)) uniquePairs.set(pairKey, { stepId: source.stepId, title: source.title });
  }

  for (const { stepId, title } of uniquePairs.values()) {
    const chosen = await selectCurrentWorkProductCandidate({
      db: input.db,
      run: input.run,
      ifStepId: input.ifStep.id,
      workflowSteps: input.workflowSteps,
      stepId,
      title,
    });
    const parsed = await readBoundedJsonFile(chosen.path, title);

    for (const source of input.sources) {
      if (source.kind !== "tool_json" && source.stepId === stepId && source.title === title) {
        out.set(workflowConditionSourceKey(source), parsed);
      }
    }
  }

  // Group tool sources by (toolName, canonical parameters): equal groups execute once,
  // then the measured root is stored under every member's own key (paths may differ).
  const toolGroups = new Map<string, WorkflowToolJsonSource[]>();
  for (const source of input.sources) {
    if (source.kind !== "tool_json") continue;
    const groupKey = `${source.toolName}\u0000${stableStringify(source.parameters)}`;
    const group = toolGroups.get(groupKey);
    if (group) group.push(source);
    else toolGroups.set(groupKey, [source]);
  }

  for (const groupSources of toolGroups.values()) {
    const representative = groupSources[0]!;
    if (!ancestors.has(representative.stepId)) {
      fail(`condition source step "${representative.stepId}" is not a forward ancestor of IF step "${input.ifStep.id}"`);
    }
    const executor = input.resolveToolJsonSource;
    if (!executor) {
      fail(`tool source "${representative.toolName}" cannot be executed in this context`);
    }
    const data = await executor(representative);
    for (const source of groupSources) {
      out.set(workflowConditionSourceKey(source), data);
    }
  }

  return out;
}

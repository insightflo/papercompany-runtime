// server/src/services/workflow/control-flow/rework-producer-context.ts
//
// [purpose] Load producer-issue-scoped context for QA rework handoff.
//   - loadProducerOwnReworkContext: the producer issue's own original instruction
//     (issues.title + description) and its active prior workProducts.
//   - loadProducerDependencyArtifacts: upstream dependency step workProducts the
//     producer consumes (kept SEPARATE from own products).
// [contract] Every query is company+mission+run scoped. Text/counts bounded.
//   If the issue fails scope, ALL downstream queries are skipped — no products
//   are returned for an unverified issue.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues, workflowStepRuns } from "@paperclipai/db";
import type { ProducerWorkProductRef } from "./rework-contract.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

const MAX_INSTRUCTION_CHARS = 4000;
const MAX_OWN_PRODUCTS = 12;

const META_PATH_KEYS = ["path", "filePath", "artifactPath", "outputPath"] as const;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function extractMetaPath(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  for (const key of META_PATH_KEYS) {
    const raw = metadata[key];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/**
 * [purpose] Producer issue's OWN original instruction (title + description) and
 *   active prior workProducts. These are what the fresh rework session must see
 *   directly so it does not re-derive the task or lose track of prior outputs.
 * [scope] Company + mission + workflowRunId verified before ANY product query.
 *   If the issue fails scope, returns empty — never leaks same-company products
 *   from an issue that does not belong to this mission/run/producer stepRun.
 */
export async function loadProducerOwnReworkContext(input: {
  db: Db;
  companyId: string;
  missionId?: string | null;
  workflowRunId?: string | null;
  producerStepId?: string | null;
  producerIssueId: string | null;
}): Promise<{ instruction: string | null; workProducts: readonly ProducerWorkProductRef[] }> {
  if (!input.producerIssueId) return { instruction: null, workProducts: [] };

  // Guard 1: verify the issue belongs to this company (+ mission when provided).
  const issueConditions = [
    eq(issues.id, input.producerIssueId),
    eq(issues.companyId, input.companyId),
  ];
  if (input.missionId) issueConditions.push(eq(issues.missionId, input.missionId));
  const [issueRow] = await input.db
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(and(...issueConditions))
    .limit(1);

  // CRITICAL: issue failed scope → return empty, do NOT query products.
  if (!issueRow) return { instruction: null, workProducts: [] };

  // Guard 2: verify the producer issue is tied to a step run in the workflow run.
  if (input.workflowRunId) {
    const srConditions = [
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.issueId, input.producerIssueId),
    ];
    if (input.producerStepId) srConditions.push(eq(workflowStepRuns.stepId, input.producerStepId));
    const [srRow] = await input.db
      .select({ id: workflowStepRuns.id })
      .from(workflowStepRuns)
      .where(and(...srConditions))
      .limit(1);
    if (!srRow) return { instruction: null, workProducts: [] };
  }

  // Instruction = title + description.
  const titlePart = typeof issueRow.title === "string" && issueRow.title.trim() ? issueRow.title.trim() : null;
  const descPart = typeof issueRow.description === "string" && issueRow.description.trim() ? issueRow.description.trim() : null;
  const rawInstruction = [titlePart, descPart].filter(Boolean).join("\n\n");
  const instruction = rawInstruction ? truncate(rawInstruction, MAX_INSTRUCTION_CHARS) : null;

  // Products: SQL-level status='active' filter + deterministic order + limit.
  const products = await input.db
    .select({
      title: issueWorkProducts.title,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.issueId, input.producerIssueId),
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.status, "active"),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.createdAt), desc(issueWorkProducts.id))
    .limit(MAX_OWN_PRODUCTS);

  const workProducts: ProducerWorkProductRef[] = [];
  for (const product of products) {
    const ref = product.url ?? product.externalId ?? extractMetaPath(product.metadata);
    if (!ref || ref.trim().length === 0) continue;
    workProducts.push({ title: product.title, ref: ref.trim() });
  }

  return { instruction, workProducts };
}

/**
 * [purpose] Current upstream (dependency) step workProducts for the producer step.
 *   Kept as a SEPARATE section from producer-own products so the agent knows which
 *   inputs come from predecessors vs. which are its own prior outputs.
 * [scope] Company-scoped via issueWorkProducts.companyId filter.
 */
export async function loadProducerDependencyArtifacts(input: {
  db: Db;
  companyId: string;
  stepRunMap: Map<string, StepRun>;
  producerStep: { dependencies?: string[] };
}): Promise<string | null> {
  const depStepIds = Array.isArray(input.producerStep.dependencies) ? input.producerStep.dependencies : [];
  if (depStepIds.length === 0) return null;
  const issueToStepId = new Map<string, string>();
  const depIssueIds: string[] = [];
  for (const depStepId of depStepIds) {
    const issueId = input.stepRunMap.get(depStepId)?.issueId;
    if (typeof issueId === "string" && issueId.length > 0) {
      depIssueIds.push(issueId);
      issueToStepId.set(issueId, depStepId);
    }
  }
  if (depIssueIds.length === 0) return null;
  const products = await input.db
    .select({
      issueId: issueWorkProducts.issueId,
      title: issueWorkProducts.title,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(and(
      inArray(issueWorkProducts.issueId, depIssueIds),
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.status, "active"),
    ))
    .orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id));
  const byStepId = new Map<string, string[]>();
  for (const product of products) {
    const stepId = issueToStepId.get(product.issueId);
    if (!stepId) continue;
    const ref = product.url ?? product.externalId ?? extractMetaPath(product.metadata);
    if (!ref || ref.trim().length === 0) continue;
    const arr = byStepId.get(stepId) ?? [];
    arr.push(`${product.title} → ${ref}`);
    byStepId.set(stepId, arr);
  }
  const lines = ["### Current upstream artifacts (refreshed for this rework — use THESE paths, not previous-run files):"];
  let any = false;
  for (const depStepId of depStepIds) {
    const arr = byStepId.get(depStepId);
    if (arr && arr.length > 0) {
      lines.push(`- ${depStepId}: ${arr.join("; ")}`);
      any = true;
    } else {
      lines.push(`- ${depStepId}: (no active workProduct registered)`);
    }
  }
  return any ? lines.join("\n") : null;
}

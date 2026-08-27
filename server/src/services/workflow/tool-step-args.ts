import path from "node:path";
import { and, desc, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import { resolveWorkProductLocalFilePath } from "../work-products.js";

type WorkflowArgStep = {
  id: string;
  dependencies?: string[];
  dependsOn?: string[];
  toolArgs?: unknown;
};

type WorkflowArgRun = {
  id: string;
  companyId: string;
  runDate?: string | null;
  metadata?: Record<string, unknown> | null;
};

const STEP_ARTIFACT_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;
const RUN_METADATA_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;

/**
 * 문자열이 아닌 run metadata 값을 템플릿 치환 문자열로 변환.
 * undefined(키 부재와 동급)는 null을 반환해 호출자가 토큰을 유지하게 한다.
 */
export function stringifyWorkflowRunMetadataValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : null;
}

export async function resolveWorkflowToolStepArgs(input: {
  db: Db;
  run: WorkflowArgRun;
  step: WorkflowArgStep;
  workflowSteps: WorkflowArgStep[];
}): Promise<unknown> {
  const args = input.step.toolArgs ?? {};
  const runMetadata = input.run.metadata ?? {};
  const references = collectArtifactReferences(args);
  if (references.size === 0) return renderTemplates(args, input.run.runDate ?? "", new Map(), runMetadata);

  const ancestors = collectAncestorStepIds(input.step.id, input.workflowSteps);
  for (const stepId of references) {
    if (!ancestors.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" may only reference ancestor workProducts; "${stepId}" is not an ancestor.`);
    }
  }

  const products = await input.db
    .select({
      stepId: workflowStepRuns.stepId,
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
    })
    .from(workflowStepRuns)
    .innerJoin(issueWorkProducts, eq(workflowStepRuns.issueId, issueWorkProducts.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.run.id),
      inArray(workflowStepRuns.stepId, Array.from(references)),
      eq(issueWorkProducts.companyId, input.run.companyId),
      not(eq(issueWorkProducts.status, "archived")),
    ))
    .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id));

  const pathsByStepId = new Map<string, string>();
  for (const product of products) {
    if (pathsByStepId.has(product.stepId)) continue;
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    const localPath = resolveWorkProductLocalFilePath(product);
    if (localPath) pathsByStepId.set(product.stepId, path.resolve(localPath));
  }
  for (const stepId of references) {
    if (!pathsByStepId.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" could not resolve an active local workProduct for ancestor step "${stepId}".`);
    }
  }

  return renderTemplates(args, input.run.runDate ?? "", pathsByStepId, runMetadata);
}

function collectArtifactReferences(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_ARTIFACT_TOKEN)) {
      if (match[1]) result.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectArtifactReferences(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectArtifactReferences(item, result);
  }
  return result;
}

function collectAncestorStepIds(currentStepId: string, steps: WorkflowArgStep[]): Set<string> {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependencies ?? step.dependsOn ?? []]));
  const ancestors = new Set<string>();
  const visit = (stepId: string) => {
    for (const dependencyId of dependencies.get(stepId) ?? []) {
      if (ancestors.has(dependencyId)) continue;
      ancestors.add(dependencyId);
      visit(dependencyId);
    }
  };
  visit(currentStepId);
  return ancestors;
}

function renderTemplates(value: unknown, runDate: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("{$runDate}", runDate)
      .replaceAll("{$date}", runDate)
      .replace(STEP_ARTIFACT_TOKEN, (token, stepId: string, field: string) => {
        const workProductPath = pathsByStepId.get(stepId);
        if (!workProductPath) return token;
        if (field === "workProductPath") return workProductPath;
        if (field === "siblingAssetsDir") return path.join(path.dirname(workProductPath), "assets");
        return path.dirname(workProductPath);
      })
      .replace(RUN_METADATA_TOKEN, (token, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(runMetadata, key)) return token;
        const rendered = stringifyWorkflowRunMetadataValue(runMetadata[key]);
        return rendered === null ? token : rendered;
      });
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, runDate, pathsByStepId, runMetadata));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplates(item, runDate, pathsByStepId, runMetadata)]));
  }
  return value;
}

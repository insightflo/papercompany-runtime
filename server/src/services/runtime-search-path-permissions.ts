import path from "node:path";
import { and, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueExecutionCards,
  issueWorkProducts,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { defaultMissionSearchScopes, normalizeMissionSearchScopes } from "./runtime-search-scopes.js";
import { resolveWorkProductLocalFilePath } from "./work-products.js";

export type RuntimeSearchPathPermissions = {
  version: 1;
  workingDirectory: string;
  outputDirectory: string | null;
  dependencyFiles: string[];
  dependencyDirectories: string[];
  allowedSearchScopes: string[];
  qaType: string | null;
  qaInputScope: string | null;
};

export async function buildRuntimeSearchPathPermissions(input: {
  db: Db;
  companyId: string;
  issueId: string;
  workingDirectory: string;
}): Promise<RuntimeSearchPathPermissions | null> {
  const permissions: RuntimeSearchPathPermissions = {
    version: 1,
    workingDirectory: path.resolve(input.workingDirectory),
    outputDirectory: null,
    dependencyFiles: [],
    dependencyDirectories: [],
    allowedSearchScopes: defaultMissionSearchScopes(),
    qaType: null,
    qaInputScope: null,
  };
  const card = await input.db
    .select({
      workflowRunId: issueExecutionCards.workflowRunId,
      cardJson: issueExecutionCards.cardJson,
    })
    .from(issueExecutionCards)
    .where(and(
      eq(issueExecutionCards.companyId, input.companyId),
      eq(issueExecutionCards.issueId, input.issueId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!card) return null;

  permissions.qaType = card.cardJson.workflow?.qaType ?? null;
  permissions.qaInputScope = card.cardJson.workflow?.qaInputScope ?? null;
  permissions.allowedSearchScopes = normalizeMissionSearchScopes(
    card.cardJson.toolPermissionContract?.allowedSearchScopes,
  );
  if (permissions.allowedSearchScopes.length === 0) {
    permissions.allowedSearchScopes = defaultMissionSearchScopes();
  }

  const outputDirectory = card.cardJson.requiredOutputs.workProduct.outputDir;
  permissions.outputDirectory = typeof outputDirectory === "string" && path.isAbsolute(outputDirectory)
    ? path.resolve(outputDirectory)
    : null;

  if (!card.workflowRunId) return permissions;

  const currentStep = await input.db
    .select({ stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, card.workflowRunId),
      eq(workflowStepRuns.issueId, input.issueId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!currentStep) return permissions;

  const workflow = await input.db
    .select({ stepsJson: workflowDefinitions.stepsJson })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.id, card.workflowRunId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowDefinitions.companyId, input.companyId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const dependencyStepIds = collectDependencyStepIds(workflow?.stepsJson, currentStep.stepId);
  if (dependencyStepIds.length === 0) return permissions;

  const linkedIssueIds = await input.db
    .select({ issueId: workflowStepRuns.issueId })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, card.workflowRunId),
      inArray(workflowStepRuns.stepId, dependencyStepIds),
    ))
    .then((rows) => rows.flatMap((row) => row.issueId ? [row.issueId] : []));
  if (linkedIssueIds.length === 0) return permissions;

  const products = await input.db
    .select({
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
    })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      inArray(issueWorkProducts.issueId, linkedIssueIds),
      not(eq(issueWorkProducts.status, "archived")),
    ));

  permissions.dependencyFiles = Array.from(new Set(products.flatMap((product) => {
    if (product.provider !== "local" && product.provider !== "local_file") return [];
    const localPath = resolveWorkProductLocalFilePath(product);
    return localPath ? [path.resolve(localPath)] : [];
  })));
  permissions.dependencyDirectories = Array.from(new Set(
    permissions.dependencyFiles
      .map((file) => path.dirname(file))
      .filter((directory) => isPathInside(directory, permissions.workingDirectory)),
  ));
  return permissions;
}

function isPathInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectDependencyStepIds(rawSteps: unknown, currentStepId: string) {
  if (!Array.isArray(rawSteps)) return [];
  const dependenciesByStepId = new Map<string, string[]>();
  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || typeof rawStep.id !== "string") continue;
    const dependencies = readStringArray(rawStep.dependencies ?? rawStep.dependsOn);
    const conditionalDependencies = Array.isArray(rawStep.conditionalDependencies)
      ? rawStep.conditionalDependencies.flatMap((edge) => {
        if (!isRecord(edge) || typeof edge.stepId !== "string") return [];
        return [edge.stepId];
      })
      : [];
    dependenciesByStepId.set(rawStep.id, Array.from(new Set([
      ...dependencies,
      ...conditionalDependencies,
    ])));
  }

  const collected = new Set<string>();
  const visit = (stepId: string) => {
    for (const dependencyStepId of dependenciesByStepId.get(stepId) ?? []) {
      if (collected.has(dependencyStepId)) continue;
      collected.add(dependencyStepId);
      visit(dependencyStepId);
    }
  };
  visit(currentStepId);
  return Array.from(collected);
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

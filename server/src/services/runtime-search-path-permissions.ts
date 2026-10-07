import path from "node:path";
import { and, asc, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueExecutionCards,
  issueWorkProducts,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { MISSION_SEARCH_SCOPES, defaultMissionSearchScopes, missionSearchScopesAllowRepo, normalizeMissionSearchScopes } from "./runtime-search-scopes.js";
import { isBroadSearchAllowed } from "./runtime-broad-search-flag.js";
import { resolveWorkProductLocalFilePath } from "./work-products.js";
import { ensurePlanQaWorkProduct } from "./missions/plan-qa-work-product.js";
import { loadExecutionDefinition } from "./workflow/execution-definition.js";

export type RuntimeSearchPathPermissions = {
  version: 1;
  workingDirectory: string;
  outputDirectory: string | null;
  dependencyFiles: string[];
  dependencyDirectories: string[];
  allowedSearchScopes: string[];
  broadScanRepoAllowed: boolean;
  broadSearchOverride: "experimental_allow" | null;
  qaType: string | null;
  qaInputScope: string | null;
};

type PermissionInput = { db: Db; companyId: string; issueId: string; workingDirectory: string; agentId?: string | null };
type ScopedIssue = { missionId: string | null; originKind: string | null } | null;

export async function buildRuntimeSearchPathPermissions(input: PermissionInput): Promise<RuntimeSearchPathPermissions | null> {
  const issue = await input.db
    .select({ missionId: issues.missionId, originKind: issues.originKind })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const permissions = await buildBasePermissions(input, issue);
  // Every path shares this finalizer. Unsupported/no-permission paths remain null.
  if (permissions && await isBroadSearchAllowed(input.db, {
    companyId: input.companyId, missionId: issue?.missionId ?? null, agentId: input.agentId ?? null,
  })) {
    permissions.allowedSearchScopes = [...MISSION_SEARCH_SCOPES];
    permissions.broadScanRepoAllowed = true;
    permissions.broadSearchOverride = "experimental_allow";
  }
  return permissions;
}

async function buildBasePermissions(input: PermissionInput, noCardIssue: ScopedIssue): Promise<RuntimeSearchPathPermissions | null> {
  const permissions: RuntimeSearchPathPermissions = {
    version: 1,
    workingDirectory: path.resolve(input.workingDirectory),
    outputDirectory: null,
    dependencyFiles: [],
    dependencyDirectories: [],
    allowedSearchScopes: defaultMissionSearchScopes(),
    broadScanRepoAllowed: false,
    broadSearchOverride: null,
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
  if (!card) {
    if (noCardIssue?.originKind === "mission_main_executor_plan") {
      // PLAN gets server-side repo discovery, but direct broad scans remain denied by default.
      permissions.allowedSearchScopes = ["repo"];
      permissions.broadScanRepoAllowed = false;
      return permissions;
    }
    if (noCardIssue?.originKind === "mission_plan_qa") {
      // PLAN-QA defaults to declared work products/output, not broad scans.
      // Project/register the accepted plan for this scoped issue; an explicit miss
      // leaves dependencies empty. FS/registration failures still abort preparation.
      if (noCardIssue.missionId) {
        const planQaWorkProduct = await ensurePlanQaWorkProduct({
          db: input.db,
          companyId: input.companyId,
          planQaIssueId: input.issueId,
          missionId: noCardIssue.missionId,
        });
        if (planQaWorkProduct) {
          permissions.dependencyFiles = [planQaWorkProduct.filePath];
          permissions.dependencyDirectories = [planQaWorkProduct.fileDirectory];
        }
      }
      return permissions;
    }
    return buildMissionRecoverySearchPermissions(input, permissions, noCardIssue);
  }

  permissions.qaType = card.cardJson.workflow?.qaType ?? null;
  permissions.qaInputScope = card.cardJson.workflow?.qaInputScope ?? null;
  permissions.allowedSearchScopes = normalizeMissionSearchScopes(
    card.cardJson.toolPermissionContract?.allowedSearchScopes,
  );
  if (permissions.allowedSearchScopes.length === 0) {
    permissions.allowedSearchScopes = defaultMissionSearchScopes();
  }
  permissions.broadScanRepoAllowed = missionSearchScopesAllowRepo(normalizeMissionSearchScopes(permissions.allowedSearchScopes));

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
    .select({ workflowRunId: workflowRuns.id })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.id, card.workflowRunId),
      eq(workflowRuns.companyId, input.companyId),
      eq(workflowDefinitions.companyId, input.companyId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workflow) return permissions;
  // [Task5a2c] scoped linked run: dependency steps come from the frozen execution definition
  //   (snapshot), never from live stepsJson — an editor rewiring/removing dependencies cannot
  //   widen or redirect search rights. Missing/corrupt expected snapshots fail closed (422)
  //   before any permissions are returned. collectDependencyStepIds keeps projecting/traversing
  //   the (already normalized) edges, including conditional/transitive edges.
  const execution = await loadExecutionDefinition(input.db, workflow.workflowRunId, { requireHistorical: false });
  const dependencyStepIds = collectDependencyStepIds(execution.steps, currentStep.stepId);
  if (dependencyStepIds.length === 0) return permissions;
  const dependencyToolArtifactPaths = card.cardJson.evidenceRefs.flatMap((ref) => {
    if (ref.type !== "dependency_tool_artifact" || typeof ref.path !== "string" || !path.isAbsolute(ref.path)) {
      return [];
    }
    const candidate = path.resolve(ref.path);
    return isPathInside(candidate, permissions.workingDirectory) ? [candidate] : [];
  });

  const linkedIssueIds = await input.db
    .select({ issueId: workflowStepRuns.issueId })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, card.workflowRunId),
      inArray(workflowStepRuns.stepId, dependencyStepIds),
    ))
    .then((rows) => rows.flatMap((row) => row.issueId ? [row.issueId] : []));
  const products = linkedIssueIds.length > 0
    ? await input.db
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
    ))
    : [];

  permissions.dependencyFiles = Array.from(new Set([
    ...dependencyToolArtifactPaths,
    ...products.flatMap((product) => {
      if (product.provider !== "local" && product.provider !== "local_file") return [];
      const localPath = resolveWorkProductLocalFilePath(product);
      return localPath ? [path.resolve(localPath)] : [];
    }),
  ]));
  permissions.dependencyDirectories = Array.from(new Set(
    permissions.dependencyFiles
      .map((file) => path.dirname(file))
      .filter((directory) => isPathInside(directory, permissions.workingDirectory)),
  ));
  return permissions;
}

async function buildMissionRecoverySearchPermissions(
  input: { db: Db; companyId: string; issueId: string; workingDirectory: string },
  permissions: RuntimeSearchPathPermissions,
  issueRow: { missionId: string | null; originKind: string | null } | null,
): Promise<RuntimeSearchPathPermissions | null> {
  if (issueRow?.originKind !== "mission_main_executor_unblock" || !issueRow.missionId) {
    return null;
  }
  const recoveryMissionId = issueRow.missionId;

  const products = await input.db
    .select({
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
    })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, recoveryMissionId),
      not(eq(issueWorkProducts.status, "archived")),
    ))
    .orderBy(asc(issueWorkProducts.createdAt), asc(issueWorkProducts.id));

  permissions.allowedSearchScopes = ["workProduct"];
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

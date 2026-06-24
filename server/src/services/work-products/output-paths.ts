import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, projectWorkspaces } from "@paperclipai/db";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRoot(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const normalized = path.resolve(raw);
  return path.isAbsolute(normalized) ? normalized : null;
}

export function safeWorkProductPathSegment(value: string) {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned || "unknown";
}

export function isPathInsideOrEqual(candidatePath: string, rootPath: string) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveCompanyWorkProductRoot(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    projectId?: string | null;
  },
) {
  const [company] = await db
    .select({ workProductRoot: companies.workProductRoot })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);

  const configuredRoot = normalizeRoot(company?.workProductRoot);
  if (configuredRoot) return configuredRoot;

  const workspaceConditions = [eq(projectWorkspaces.companyId, input.companyId)];
  if (input.projectId) workspaceConditions.push(eq(projectWorkspaces.projectId, input.projectId));

  const [workspace] = await db
    .select({ cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces)
    .where(and(...workspaceConditions))
    .orderBy(desc(projectWorkspaces.isPrimary), desc(projectWorkspaces.updatedAt))
    .limit(1);

  const workspaceCwd = normalizeRoot(workspace?.cwd);
  return workspaceCwd ? path.join(workspaceCwd, "produced_work") : null;
}

export function buildMissionWorkProductPaths(input: {
  workProductRoot: string;
  missionId: string;
  workflowRunId?: string | null;
  stepId?: string | null;
}) {
  const missionOutputDir = path.join(input.workProductRoot, "missions", input.missionId);
  const runOutputDir = input.workflowRunId
    ? path.join(missionOutputDir, "runs", input.workflowRunId)
    : null;
  const stepOutputDir = input.stepId
    ? path.join(runOutputDir ?? missionOutputDir, "steps", safeWorkProductPathSegment(input.stepId))
    : null;
  return {
    workProductRoot: input.workProductRoot,
    missionOutputDir,
    runOutputDir,
    stepOutputDir,
  };
}

export async function resolveMissionWorkProductPaths(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    missionId?: string | null;
    projectId?: string | null;
    workflowRunId?: string | null;
    stepId?: string | null;
  },
) {
  if (!input.missionId) return null;
  const workProductRoot = await resolveCompanyWorkProductRoot(db, input);
  if (!workProductRoot) return null;
  return buildMissionWorkProductPaths({
    workProductRoot,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    stepId: input.stepId,
  });
}


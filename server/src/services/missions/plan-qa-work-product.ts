import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, missionPlanArtifacts } from "@paperclipai/db";
import {
  isPathInsideOrEqual,
  resolveMissionWorkProductPaths,
} from "../work-products/output-paths.js";
import { workProductService } from "../work-products.js";

/**
 * PLAN-QA work product projection.
 *
 * A PLAN-QA issue (originKind "mission_plan_qa") owns no execution card: it
 * reviews an accepted owner plan decision, it does not run a workflow step.
 * The reviewer needs the exact accepted plan to review, but that plan lives in
 * the control plane (mission_plan_artifacts.refs), not on the review
 * filesystem. Before the runtime returns search-path permissions, this module
 * deterministically projects the accepted plan to a stable JSON file under the
 * mission output root and registers one local_file work product for the current
 * PLAN-QA issue/path.
 *
 * Fail-closed contract (contract point 9):
 * - Explicit miss (no active plan tied to this issue, missing decisionHash, or
 *   no resolvable work product root) returns null. The caller keeps the safe
 *   minimal permissions (empty dependencyFiles, scopes workProduct/missionOutput,
 *   no repo/secret access) — this never widens scope.
 * - Filesystem write or work product registration failure THROWS. The exception
 *   propagates through buildRuntimeSearchPathPermissions so the invocation
 *   preparation itself fails rather than silently starting an under-declared
 *   review with no readable plan.
 */

const PROJECTION_SCHEMA_VERSION = 1;
const WORK_PRODUCT_PROVIDER = "local_file";
const PLAN_QA_DIR_SEGMENT = "plan-qa";
const PLAN_FILE_NAME = "plan.json";
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export type PlanQaWorkProduct = {
  filePath: string;
  fileDirectory: string;
};

type MissionPlanRow = typeof missionPlanArtifacts.$inferSelect;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlanQaDecisionHash(refs: unknown): string | null {
  if (!isPlainObject(refs)) return null;
  const planQa = refs.planQa;
  if (!isPlainObject(planQa)) return null;
  const decisionHash = planQa.decisionHash;
  // The decisionHash is used directly as the plan-qa/<decisionHash> directory
  // segment. It must be an exact SHA-256 hex digest (64 lowercase hex chars) so
  // it can never collapse the path (e.g. "..") or escape the intended directory.
  // safeWorkProductPathSegment alone is insufficient: it keeps ".", so ".."
  // survives and collapses out of plan-qa while staying inside missionOutputDir.
  // Anything else is an explicit miss: return null, never widen permissions.
  return typeof decisionHash === "string" && SHA256_HEX_RE.test(decisionHash) ? decisionHash : null;
}

/**
 * Selects the single active mission plan artifact whose refs.planQa.issueId
 * matches the current PLAN-QA issue. Rejects cross-issue, cross-mission,
 * cross-company, and stale/superseded plans.
 */
async function findActivePlanForPlanQaIssue(input: {
  db: Db;
  companyId: string;
  missionId: string;
  planQaIssueId: string;
}): Promise<MissionPlanRow | null> {
  const [plan] = await input.db
    .select()
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, input.companyId),
      eq(missionPlanArtifacts.missionId, input.missionId),
      eq(missionPlanArtifacts.status, "active"),
      sql`${missionPlanArtifacts.refs}->'planQa'->>'issueId' = ${input.planQaIssueId}`,
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.updatedAt))
    .limit(1);
  return plan ?? null;
}

function buildPlanQaProjection(plan: MissionPlanRow, decisionHash: string, missionId: string) {
  const refs = isPlainObject(plan.refs) ? plan.refs : {};
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    missionId,
    missionPlanArtifactId: plan.id,
    revision: plan.revision,
    decisionHash,
    missionGoal: plan.missionGoal,
    refs: {
      selectedExecutionUnits: refs.selectedExecutionUnits ?? [],
      planTemplates: refs.planTemplates ?? null,
      ownerPlanDecision: refs.ownerPlanDecision ?? null,
      dynamicMissionPlanning: refs.dynamicMissionPlanning ?? null,
    },
    steps: plan.steps ?? [],
    requiredInputs: plan.requiredInputs ?? [],
    successCriteria: plan.successCriteria ?? [],
    risks: plan.risks ?? [],
  };
}

function resolvePlanQaFilePath(missionOutputDir: string, decisionHash: string): string {
  // decisionHash is already validated as an exact 64-char lowercase hex digest,
  // so it is filesystem-safe by construction and cannot collapse the path.
  return path.join(missionOutputDir, PLAN_QA_DIR_SEGMENT, decisionHash, PLAN_FILE_NAME);
}

async function writePlanJsonAtomically(filePath: string, projection: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${PLAN_FILE_NAME}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(tempPath, JSON.stringify(projection), { mode: 0o600 });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function findExistingPlanQaWorkProduct(input: {
  db: Db;
  companyId: string;
  planQaIssueId: string;
  filePath: string;
}) {
  const [row] = await input.db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, input.planQaIssueId),
      eq(issueWorkProducts.provider, WORK_PRODUCT_PROVIDER),
      eq(issueWorkProducts.externalId, input.filePath),
      eq(issueWorkProducts.status, "active"),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Idempotently registers one active local_file work product for the current
 * PLAN-QA issue/path. Only an ACTIVE existing row counts as already registered;
 * a non-active same-path row (e.g. superseded) is ignored so a fresh active row
 * is created, keeping the "exactly one active row per issue/path" invariant. If
 * a new row is needed but registration (file validation) fails, this throws so
 * the invocation preparation fails rather than starting an under-declared review.
 */
async function registerPlanQaWorkProduct(input: {
  db: Db;
  companyId: string;
  planQaIssueId: string;
  filePath: string;
}): Promise<void> {
  const existing = await findExistingPlanQaWorkProduct({
    db: input.db,
    companyId: input.companyId,
    planQaIssueId: input.planQaIssueId,
    filePath: input.filePath,
  });
  if (existing) return;

  const product = await workProductService(input.db).createForIssue(input.planQaIssueId, input.companyId, {
    projectId: null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "document",
    provider: WORK_PRODUCT_PROVIDER,
    externalId: input.filePath,
    title: "PLAN-QA review plan projection",
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: "Deterministic projection of the accepted owner plan decision for PLAN-QA review.",
    metadata: {
      path: input.filePath,
      registeredVia: "plan_qa_work_product",
      schemaVersion: PROJECTION_SCHEMA_VERSION,
    },
    createdByRunId: null,
  });
  if (!product) {
    throw new Error(
      "PLAN-QA work product registration failed: file validation rejected the projection path; refusing to start an under-declared review",
    );
  }
}

/**
 * Ensures a server-derived PLAN-QA plan projection exists for the current
 * PLAN-QA issue and registers one active local_file work product. Returns the
 * absolute file path and its parent directory so the caller can scope
 * dependencyFiles/dependencyDirectories. Returns null on an explicit miss (no
 * active plan tied to this issue, missing decisionHash, or no resolvable root)
 * so the caller keeps the safe minimal permissions. Throws on filesystem write
 * or registration failure so the invocation preparation fails closed.
 */
export async function ensurePlanQaWorkProduct(input: {
  db: Db;
  companyId: string;
  planQaIssueId: string;
  missionId: string;
}): Promise<PlanQaWorkProduct | null> {
  const plan = await findActivePlanForPlanQaIssue({
    db: input.db,
    companyId: input.companyId,
    missionId: input.missionId,
    planQaIssueId: input.planQaIssueId,
  });
  if (!plan) return null;

  const decisionHash = readPlanQaDecisionHash(plan.refs);
  if (!decisionHash) return null;

  const paths = await resolveMissionWorkProductPaths(input.db, {
    companyId: input.companyId,
    missionId: input.missionId,
  });
  if (!paths) return null;

  const filePath = resolvePlanQaFilePath(paths.missionOutputDir, decisionHash);
  if (!isPathInsideOrEqual(filePath, paths.missionOutputDir)) return null;

  const projection = buildPlanQaProjection(plan, decisionHash, input.missionId);
  await writePlanJsonAtomically(filePath, projection);
  await registerPlanQaWorkProduct({
    db: input.db,
    companyId: input.companyId,
    planQaIssueId: input.planQaIssueId,
    filePath,
  });

  return { filePath, fileDirectory: path.dirname(filePath) };
}

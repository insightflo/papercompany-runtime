import { and, desc, eq, not } from "drizzle-orm";
import { issueWorkProducts, workflowLateEvidenceSubmissions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { resolveWorkProductLocalFilePath } from "../../work-products.js";
import { validateExactArtifact, validateExactSubmission, EXACT_REGISTERED_VIA } from "../exact-artifact-validation.js";
import { WORKFLOW_IF_CONDITION_ERROR_PREFIX, workflowConditionFailure as fail } from "./condition-source-file.js";
import { WorkProductConditionWaitableError } from "./waitable-condition-error.js";

export type CurrentWorkProductCandidate = { path: string; updatedAt: Date; expectedHash?: string };
type Product = typeof issueWorkProducts.$inferSelect;
type Attempt = typeof workflowStepRuns.$inferSelect;

async function exactHash(db: Db, product: Product, attempt: Attempt, run: { id: string; companyId: string; missionId: string | null }) {
  // Do not company-filter this association: a foreign linked submission must not downgrade to legacy.
  const linked = await db.select().from(workflowLateEvidenceSubmissions).where(eq(workflowLateEvidenceSubmissions.artifactId, product.id));
  const marked = product.metadata?.registeredVia === EXACT_REGISTERED_VIA
    || Object.prototype.hasOwnProperty.call(product.metadata ?? {}, "exactProducer");
  if (!marked && linked.length === 0) return { legacy: true } as const;
  if (linked.length !== 1 || !run.missionId || !attempt.issueId) return null;
  const submission = linked[0];
  try {
    const validated = await validateExactSubmission(db, { companyId: run.companyId, missionId: run.missionId,
      workflowRunId: run.id, stepRunId: attempt.id, stepId: attempt.stepId, issueId: attempt.issueId,
      executionGeneration: attempt.executionGeneration, specSha256: submission.specSha256, submissionId: submission.id });
    const verified = await validateExactArtifact(db, validated);
    if (verified.id !== product.id) return null;
    return { expectedHash: validated.submission.readbackHash! };
  } catch {
    return null; // Ineligible, never legacy fallback for this artifact.
  }
}

/** Select attempt independently of products. Never use artifact updatedAt to identify its producer. */
export async function selectAttemptWorkProduct(input: {
  db: Db; run: { id: string; companyId: string }; stepId: string; title: string;
}): Promise<CurrentWorkProductCandidate> {
  const { db, stepId, title } = input;
  const unavailable = (): never => {
    throw new WorkProductConditionWaitableError(
      `${WORKFLOW_IF_CONDITION_ERROR_PREFIX} no completed-attempt local work product "${title}" found for ancestor step "${stepId}"`,
      { stepId, title });
  };
  const attempts = await db.select({ step: workflowStepRuns, missionId: workflowRuns.missionId }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, input.run.companyId), eq(workflowStepRuns.stepId, stepId)))
    .orderBy(desc(workflowStepRuns.iterationIndex), desc(workflowStepRuns.startedAt));
  if (!attempts.length) return unavailable();
  const attempt = attempts[0].step;
  if (!attempt.startedAt) fail(`producer step "${stepId}" has no attempt start time; cannot establish work-product freshness`);
  if (attempts.slice(1).some(({ step }) => step.iterationIndex === attempt.iterationIndex
    && step.startedAt?.getTime() === attempt.startedAt!.getTime())) fail(`ambiguous current attempt for producer step "${stepId}"`);
  if (attempt.status !== "completed" || !attempt.issueId) return unavailable();
  const products = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.issueId, attempt.issueId),
    eq(issueWorkProducts.companyId, input.run.companyId), eq(issueWorkProducts.title, title), not(eq(issueWorkProducts.status, "archived"))));
  const candidates: Array<CurrentWorkProductCandidate & { id: string; isPrimary: boolean }> = [];
  for (const product of products) {
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    if (product.updatedAt.getTime() < attempt.startedAt.getTime()) continue;
    const localPath = resolveWorkProductLocalFilePath({ metadata: product.metadata, url: product.url });
    if (!localPath) continue;
    const eligibility = await exactHash(db, product, attempt, { ...input.run, missionId: attempts[0].missionId });
    if (!eligibility) continue;
    candidates.push({ id: product.id, isPrimary: product.isPrimary, path: localPath, updatedAt: product.updatedAt,
      ...("expectedHash" in eligibility ? { expectedHash: eligibility.expectedHash } : {}) });
  }
  if (!candidates.length) return unavailable();
  candidates.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.updatedAt.getTime() - a.updatedAt.getTime()
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const chosen = candidates[0];
  if (candidates.slice(1).some(row => row.isPrimary === chosen.isPrimary && row.updatedAt.getTime() === chosen.updatedAt.getTime())) {
    fail(`ambiguous work product "${title}" for step "${stepId}": multiple equally ranked current candidates`);
  }
  return { path: chosen.path, updatedAt: chosen.updatedAt, ...(chosen.expectedHash ? { expectedHash: chosen.expectedHash } : {}) };
}

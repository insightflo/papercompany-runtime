import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { missionPlanQaVerdicts } from "@paperclipai/db";
import { checkResultSchema, planQaScopeSchema, planQaVerdictStateSchema } from "@paperclipai/shared";
import { hashContract, type QualityDb } from "../quality/contract.js";
import { readPlanQaGateEvidence } from "./plan-qa-evidence-registry.js";
import { combinePlanQa, type VerifiedPlanQaGate } from "./plan-qa-addendum-gate.js";
import { assertCurrentPlanQaScope } from "./plan-qa-current-attempt.js";
import { inspectPlanQaChecks } from "./plan-qa-check-evidence.js";
import { blockedPlanQaTemplates, readPlanQaManifestForIssue } from "./plan-qa-addendum-manifest.js";

export const planQaSubmissionDocumentSchema = z.object({
  schemaVersion: z.literal(2), kind: z.literal("plan_qa_submission"), scope: planQaScopeSchema,
  baseVerdict: z.enum(["pass", "request_changes"]), checks: z.array(checkResultSchema),
}).strict();
export const planQaGateReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("plan_qa_gate"), scopeHash: z.string(),
  status: z.enum(["pass", "request_changes"]), baseVerdict: z.enum(["pass", "request_changes"]),
  submissionSha256: z.string(),
}).strict();

/** Read the immutable submission and receipt, not mutable verdict/ref display fields. */
export async function readVerifiedPlanQaGate(db: QualityDb, scopeInput: unknown): Promise<VerifiedPlanQaGate | null> {
  const parsed = planQaScopeSchema.safeParse(scopeInput);
  if (!parsed.success) return null;
  const scope = parsed.data;
  try {
    await assertCurrentPlanQaScope(db, scope);
    const [row] = await db.select().from(missionPlanQaVerdicts).where(and(
      eq(missionPlanQaVerdicts.companyId, scope.companyId), eq(missionPlanQaVerdicts.planQaIssueId, scope.issueId),
      eq(missionPlanQaVerdicts.decisionHash, scope.decisionHash),
    )).limit(1);
    const parsedState = planQaVerdictStateSchema.safeParse(row?.qualityContract);
    if (!parsedState.success || !parsedState.data.verdict || row?.sourceCommentId !== null) return null;
    const state = parsedState.data;
    const verdict = state.verdict!;
    if (hashContract(state.scope) !== hashContract(scope) || hashContract(verdict.scope) !== hashContract(scope)) return null;
    const { submissionBytes, receiptBytes } = await readPlanQaGateEvidence(db, { scope,
      evidenceRefId: verdict.evidenceRefId, receiptRef: verdict.receiptRef, submissionRef: verdict.submissionRef });
    const document = planQaSubmissionDocumentSchema.parse(JSON.parse(submissionBytes.toString("utf8")));
    const receipt = planQaGateReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    if (hashContract(document.scope) !== hashContract(scope) || receipt.scopeHash !== hashContract(scope)
      || receipt.submissionSha256 !== verdict.submissionRef.sha256 || receipt.baseVerdict !== document.baseVerdict
      || verdict.baseVerdict !== document.baseVerdict || receipt.status !== verdict.status
      || new Set(document.checks.map((check) => check.checkId)).size !== document.checks.length
      || hashContract(verdict.checkStatuses) !== hashContract(document.checks.map(({ checkId, status }) => ({ checkId, status })))) return null;
    const manifest = await readPlanQaManifestForIssue(db as Parameters<typeof readPlanQaManifestForIssue>[0], scope.companyId, scope.issueId, scope.manifestRef);
    if (blockedPlanQaTemplates(manifest).length || manifest.missionId !== scope.missionId
      || manifest.planArtifactId !== scope.planArtifactId || manifest.decisionHash !== scope.decisionHash
      || manifest.reviewGeneration !== scope.reviewGeneration) return null;
    const inspected = await inspectPlanQaChecks(db, scope, manifest, state, document.checks);
    if (inspected.reasons.length || hashContract(inspected.defects) !== hashContract(verdict.defects)
      || combinePlanQa(document.baseVerdict === "pass", document.checks.map((check) => check.status)) !== verdict.status) return null;
    return { verdict: verdict.status, evidenceRefId: verdict.evidenceRefId };
  } catch { return null; }
}

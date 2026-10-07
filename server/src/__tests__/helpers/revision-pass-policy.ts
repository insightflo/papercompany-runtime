import { createHash, randomUUID } from "node:crypto";
import { missionPlanTemplates, qualityPolicyVersions, type Db } from "@paperclipai/db";

/** One real strict read check, pinned by the ordinary PLAN-QA binding producer. */
export async function revisionPassPolicy(db: Db, companyId: string) {
  const id = randomUUID(), body = "Revision report verification", now = new Date();
  await db.insert(missionPlanTemplates).values({ id, companyId, key: "revision-pass", name: "Revision PASS",
    selectionDescription: body, instructions: body, origin: "company_custom", enabled: true });
  await db.insert(qualityPolicyVersions).values({ companyId, version: 1, approvedByUserId: "test-reviewer",
    approvedAt: now, enabledAt: now, definition: {
      targets: [{ companyId, templateId: id, baseHash: createHash("sha256").update(body).digest("hex"), required: [{
        checkId: "revision-read", requirementRefs: [{ attachmentId: randomUUID(), sha256: "10".repeat(32) }],
        applicability: { op: "always" }, expectedEvidenceKinds: ["read"], instructions: "Read the frozen plan",
      }] }],
      authorAgentIds: [randomUUID()], verifierAgentIds: [randomUUID()], allowedToolIds: [],
      reviewerUserIds: ["test-reviewer"], rollbackUserIds: ["test-rollback"],
      requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "11".repeat(32) }],
      caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "12".repeat(32) }],
      nativeOwnership: "native-active-plugin-disabled", maxActions: 5, maxCandidatesPerAction: 2,
      maxEvaluationsPerCandidate: 2, maxOuterCycles: 2, maxEvidenceResubmissions: 2, maxExecutionAttempts: 4,
      maxCostCentsPerGroup: 100, maxCostCentsPerPeriod: 1000, maxElapsedSeconds: 3600,
      decisionTtlSeconds: 900, observationSeconds: 86_400, reconcileBatchSize: 10,
      periodStart: now.toISOString(), periodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
    } });
  return id;
}

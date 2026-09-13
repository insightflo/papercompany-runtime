import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  authUsers,
  companyMemberships,
  companies,
  missions,
  missionPlanTemplates,
  qualityActionGroups,
  qualityActions,
  type Db,
} from "@paperclipai/db";
import type { QualityHumanActor } from "@paperclipai/shared";
import { hashContract } from "../../services/quality/contract.js";
import { activateQualityPolicy, createQualityPolicy } from "../../services/quality/policy.js";

/**
 * [TEST DATA — 운영 기본값 아님] T1 브리프가 명시한 테스트 수치.
 * 후보2 / 평가2 / 바깥반복2 / 증거재요청1 / 실행4 / 조치예산100센트 / 기간예산1000센트 / 기간1일.
 */
export const QUALITY_TEST_POLICY_NUMBERS = {
  maxActions: 5,
  maxCandidatesPerAction: 2,
  maxEvaluationsPerCandidate: 2,
  maxOuterCycles: 2,
  maxEvidenceResubmissions: 1,
  maxExecutionAttempts: 4,
  maxCostCentsPerGroup: 100,
  maxCostCentsPerPeriod: 1000,
  maxElapsedSeconds: 3600,
  decisionTtlSeconds: 900,
  observationSeconds: 86_400,
  reconcileBatchSize: 10,
} as const;

export const qualityFixtureBoardActor: QualityHumanActor = {
  userId: "local-board",
  source: "local_implicit",
  keyId: null,
};

export type QualityFixture = {
  companyId: string;
  otherCompanyId: string;
  authorAgentId: string;
  verifierAgentId: string;
  sourceMissionId: string;
  templateId: string;
  policyVersionId: string;
  groupId: string;
  actionId: string;
  intentKey: string;
  baseHash: string;
};

export function buildFixturePolicy(input: {
  companyId: string;
  templateId: string;
  baseHash: string;
  authorAgentId: string;
  verifierAgentId: string;
}) {
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
  return {
    targets: [
      {
        companyId: input.companyId,
        templateId: input.templateId,
        baseHash: input.baseHash,
        required: [
          {
            checkId: "check-fixture-evidence",
            requirementRefs: [
              { attachmentId: randomUUID(), sha256: "10".repeat(32) },
            ],
            applicability: { op: "selected_templates_all" as const, templateIds: [input.templateId] },
            expectedEvidenceKinds: ["evaluation_receipt"],
            instructions: "테스트용 추가 검사 항목이다.",
          },
        ],
      },
    ],
    authorAgentIds: [input.authorAgentId],
    verifierAgentIds: [input.verifierAgentId],
    allowedToolIds: [],
    reviewerUserIds: ["quality-reviewer-1"],
    rollbackUserIds: ["quality-rollback-1"],
    requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "11".repeat(32) }],
    caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "12".repeat(32) }],
    nativeOwnership: "native-active-plugin-disabled" as const,
    ...QUALITY_TEST_POLICY_NUMBERS,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

/** 고유 회사 2개, author/verifier 에이전트, 완료된 원본 mission, 선택 템플릿, 정책, group/action을 만든다. */
export async function seedQualityFixture(db: Db): Promise<QualityFixture> {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  await db.insert(companies).values([
    { id: companyId, name: "Quality Fixture Co", issuePrefix: `QF${companyId.slice(0, 4)}` },
    { id: otherCompanyId, name: "Quality Other Co", issuePrefix: `QO${otherCompanyId.slice(0, 4)}` },
  ]);
  const authorAgentId = randomUUID();
  const verifierAgentId = randomUUID();
  await db.insert(agents).values([
    { id: authorAgentId, companyId, name: "Quality Fixture Author" },
    { id: verifierAgentId, companyId, name: "Quality Fixture Verifier" },
  ]);
  const sourceMissionId = randomUUID();
  await db.insert(missions).values({
    id: sourceMissionId,
    companyId,
    ownerAgentId: authorAgentId,
    title: "Quality fixture source mission",
    status: "completed",
    startedAt: new Date(Date.now() - 60_000),
    completedAt: new Date(),
  });
  const templateId = randomUUID();
  await db.insert(missionPlanTemplates).values({
    id: templateId,
    companyId,
    key: `quality-fixture-${templateId.slice(0, 8)}`,
    name: "Quality Fixture Template",
    selectionDescription: "테스트용으로 선택된 PLAN-QA 템플릿이다.",
    instructions: "테스트용 템플릿 지침이다.",
    origin: "custom",
    enabled: true,
  });

  for (const userId of ["quality-reviewer-1", "quality-rollback-1"]) {
    await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });
  }
  const baseHash = createHash("sha256").update("테스트용 템플릿 지침이다.").digest("hex");
  const { policyVersionId } = await createQualityPolicy(db, qualityFixtureBoardActor, {
    companyId,
    policy: buildFixturePolicy({ companyId, templateId, baseHash, authorAgentId, verifierAgentId }),
  });
  await activateQualityPolicy(db, qualityFixtureBoardActor, {
    companyId,
    policyVersionId,
    expectedActivePolicyVersionId: null,
  });

  const groupId = randomUUID();
  await db.insert(qualityActionGroups).values({
    id: groupId,
    companyId,
    policyVersionId,
    rootOccurrenceSetHash: "21".repeat(32),
    usage: {},
    revision: 1,
  });

  const actionId = randomUUID();
  const intentKey = `quality-fixture-action-${actionId.slice(0, 8)}`;
  const target = {
    kind: "qa_addendum" as const,
    companyId,
    templateId,
    baseHash,
    requirementVersionId: randomUUID(),
    inputHash: "33".repeat(32),
    candidateVersionId: null,
    evaluationId: null,
    intentKey,
    execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
  };
  const effect = { kind: "hold" as const, remindAt: null, target };
  const retryEnvelope = {
    intentKey,
    effectHash: hashContract(effect),
    targetHash: hashContract(target),
    maxExecutorAttempts: QUALITY_TEST_POLICY_NUMBERS.maxExecutionAttempts,
    deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    groupId,
    policyVersionId,
    maxCumulativeCostCents: QUALITY_TEST_POLICY_NUMBERS.maxCostCentsPerGroup,
  };
  await db.insert(qualityActions).values({
    id: actionId,
    companyId,
    groupId,
    kind: "qa_addendum",
    occurrenceSetHash: "21".repeat(32),
    occurrenceIds: [],
    policyVersionId,
    scopeVersion: 1,
    target,
    targetHash: hashContract(target),
    effect,
    effectHash: hashContract(effect),
    retryEnvelope,
    revision: 1,
    state: "created",
    intentKey,
  });

  return {
    companyId,
    otherCompanyId,
    authorAgentId,
    verifierAgentId,
    sourceMissionId,
    templateId,
    policyVersionId,
    groupId,
    actionId,
    intentKey,
    baseHash,
  };
}

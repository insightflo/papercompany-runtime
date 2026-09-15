import { describe, expect, it } from "vitest";
import {
  addendumCheckSchema,
  applicabilitySchema,
  artifactRefSchema,
  finiteCount,
  qualityPolicySchema,
  type QualityPolicy,
} from "./quality-automation.js";

// [TEST DATA] 검증 대상 계약의 형태를 결정하는 최소한의 올바른 정책. 운영 기본값이 아니다.
const validPolicy = {
  targets: [
    {
      companyId: "11111111-1111-4111-8111-111111111111",
      templateId: "22222222-2222-4222-8222-222222222222",
      baseHash: "aa".repeat(32),
      required: [
        {
          checkId: "check-adoption-evidence",
          requirementRefs: [
            { attachmentId: "33333333-3333-4333-8333-333333333333", sha256: "bb".repeat(32) },
          ],
          applicability: {
            op: "selected_templates_all",
            templateIds: ["22222222-2222-4222-8222-222222222222"],
          },
          expectedEvidenceKinds: ["evaluation_receipt"],
          instructions: "적용 전 평가 영수증을 확인한다.",
        },
      ],
    },
  ],
  authorAgentIds: ["44444444-4444-4444-8444-444444444444"],
  verifierAgentIds: ["55555555-5555-4555-8555-555555555555"],
  allowedToolIds: [],
  reviewerUserIds: ["quality-reviewer-1"],
  rollbackUserIds: ["quality-rollback-1"],
  requirementSourceRefs: [
    { attachmentId: "66666666-6666-4666-8666-666666666666", sha256: "cc".repeat(32) },
  ],
  caseOracleRefs: [
    { attachmentId: "77777777-7777-4777-8777-777777777777", sha256: "dd".repeat(32) },
  ],
  nativeOwnership: "native-active-plugin-disabled",
  maxActions: 5,
  maxCandidatesPerAction: 2,
  maxEvaluationsPerCandidate: 2,
  maxOuterCycles: 2,
  maxEvidenceResubmissions: 1,
  maxExecutionAttempts: 4,
  maxCostCentsPerGroup: 100,
  maxCostCentsPerPeriod: 1000,
  periodStart: "2026-09-09T00:00:00.000Z",
  periodEnd: "2026-09-10T00:00:00.000Z",
  maxElapsedSeconds: 3600,
  decisionTtlSeconds: 900,
  observationSeconds: 86400,
  reconcileBatchSize: 10,
};

function policyIssues(value: unknown) {
  const result = qualityPolicySchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("unreachable");
  return result.error.issues;
}

describe("finiteCount", () => {
  it("rejects absent or unlimited counts without a default", () => {
    for (const n of [undefined, Infinity, -1, 1.5, "2"]) {
      expect(() => finiteCount(n, true)).toThrow("quality_invalid_limit");
    }
    expect(finiteCount(0, true)).toBe(0);
    expect(() => finiteCount(0, false)).toThrow("quality_invalid_limit");
  });
});

describe("qualityPolicySchema", () => {
  it("accepts an explicit finite policy", () => {
    const parsed = qualityPolicySchema.parse(validPolicy);
    expect(parsed.maxExecutionAttempts).toBe(4);
    expect(parsed.nativeOwnership).toBe("native-active-plugin-disabled");
  });

  it("rejects unknown extra fields (strict contract)", () => {
    expect(qualityPolicySchema.safeParse({ ...validPolicy, hiddenDefault: true }).success).toBe(false);
  });

  it("rejects missing required numeric and role fields", () => {
    for (const key of ["maxActions", "maxExecutionAttempts", "authorAgentIds", "targets", "periodStart"] as const) {
      const { [key]: _omitted, ...rest } = validPolicy;
      expect(qualityPolicySchema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("rejects unlimited, negative, fractional, and non-number counts with quality_invalid_limit", () => {
    for (const bad of [Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER * 2]) {
      const issues = policyIssues({ ...validPolicy, maxExecutionAttempts: bad });
      expect(issues.map((i) => i.message)).toContain("quality_invalid_limit");
    }
    expect(qualityPolicySchema.safeParse({ ...validPolicy, maxExecutionAttempts: "4" }).success).toBe(false);
  });

  it("allows zero only for retry-allowance counts and rejects zero for totals", () => {
    expect(qualityPolicySchema.parse({ ...validPolicy, maxEvidenceResubmissions: 0 }).maxEvidenceResubmissions).toBe(0);
    for (const key of ["maxActions", "maxExecutionAttempts", "maxCostCentsPerGroup", "reconcileBatchSize"] as const) {
      const issues = policyIssues({ ...validPolicy, [key]: 0 });
      expect(issues.map((i) => i.message)).toContain("quality_invalid_limit");
    }
  });

  it("rejects empty targets and duplicate array entries", () => {
    expect(policyIssues({ ...validPolicy, targets: [] }).map((i) => i.message)).toContain("quality_empty_targets");
    const issues = policyIssues({
      ...validPolicy,
      authorAgentIds: ["44444444-4444-4444-8444-444444444444", "44444444-4444-4444-8444-444444444444"],
    });
    expect(issues.map((i) => i.message)).toContain("quality_duplicate_entry");
  });

  it("rejects repeated requirements, references and evidence kinds", () => {
    const target = validPolicy.targets[0]!;
    const check = target.required[0]!;
    expect(qualityPolicySchema.safeParse({ ...validPolicy, targets: [{ ...target, required: [check, check] }] }).success).toBe(false);
    expect(qualityPolicySchema.safeParse({ ...validPolicy, requirementSourceRefs: [...validPolicy.requirementSourceRefs, ...validPolicy.requirementSourceRefs] }).success).toBe(false);
    expect(addendumCheckSchema.safeParse({ ...check, expectedEvidenceKinds: ["receipt", "receipt"] }).success).toBe(false);
  });

  it("rejects author/verifier role overlap", () => {
    const issues = policyIssues({
      ...validPolicy,
      verifierAgentIds: ["44444444-4444-4444-8444-444444444444"],
    });
    expect(issues.map((i) => i.message)).toContain("quality_policy_role_overlap");
  });

  it("cannot bypass role separation using another spelling of the same UUID", () => {
    const id = "abcdefab-1234-4567-89ab-abcdefabcdef";
    expect(id.toUpperCase()).not.toBe(id);
    expect(qualityPolicySchema.safeParse({ ...validPolicy, authorAgentIds: [id], verifierAgentIds: [id.toUpperCase()] }).success).toBe(false);
    expect(qualityPolicySchema.safeParse({ ...validPolicy, authorAgentIds: [id, id.toUpperCase()] }).success).toBe(false);
  });

  it("rejects multi-company targets and duplicate (templateId, baseHash) targets", () => {
    const otherCompany = {
      ...validPolicy.targets[0]!,
      companyId: "99999999-9999-4999-8999-999999999999",
    };
    expect(policyIssues({ ...validPolicy, targets: [...validPolicy.targets, otherCompany] }).map((i) => i.message))
      .toContain("quality_policy_company_mismatch");
    const duplicateTarget = { ...validPolicy.targets[0]!, required: validPolicy.targets[0]!.required.slice() };
    expect(
      policyIssues({ ...validPolicy, targets: [...validPolicy.targets, duplicateTarget] }).map((i) => i.message),
    ).toContain("quality_policy_duplicate_target");
  });

  it("rejects invalid period ranges and unsupported native ownership", () => {
    expect(policyIssues({ ...validPolicy, periodEnd: validPolicy.periodStart }).map((i) => i.message))
      .toContain("quality_policy_invalid_period");
    expect(qualityPolicySchema.safeParse({ ...validPolicy, nativeOwnership: "native-active" }).success).toBe(false);
    expect(qualityPolicySchema.safeParse({ ...validPolicy, nativeOwnership: "plugin" }).success).toBe(false);
  });

  it("rejects malformed hashes and refs", () => {
    expect(artifactRefSchema.safeParse({ attachmentId: "not-a-uuid", sha256: "aa".repeat(32) }).success).toBe(false);
    expect(artifactRefSchema.safeParse({ attachmentId: "33333333-3333-4333-8333-333333333333", sha256: "xyz" }).success)
      .toBe(false);
    expect(policyIssues({ ...validPolicy, targets: [{ ...validPolicy.targets[0]!, baseHash: "short" }] }).length)
      .toBeGreaterThan(0);
  });
});

describe("addendum check contracts", () => {
  it("accepts always/selected applicability and rejects unknown ops", () => {
    expect(applicabilitySchema.safeParse({ op: "always" }).success).toBe(true);
    expect(applicabilitySchema.safeParse({ op: "selected_templates_all", templateIds: [] }).success).toBe(false);
    expect(applicabilitySchema.safeParse({ op: "sometimes" }).success).toBe(false);

    const check = validPolicy.targets[0]!.required[0]!;
    expect(addendumCheckSchema.safeParse(check).success).toBe(true);
    expect(addendumCheckSchema.safeParse({ ...check, expectedEvidenceKinds: [] }).success).toBe(false);
    expect(addendumCheckSchema.safeParse({ ...check, extra: 1 }).success).toBe(false);
  });
});

describe("QualityPolicy type surface", () => {
  it("keeps every finite policy field in the parsed contract", () => {
    const parsed: QualityPolicy = qualityPolicySchema.parse(validPolicy);
    const keys: Array<keyof QualityPolicy> = [
      "targets", "authorAgentIds", "verifierAgentIds", "allowedToolIds", "reviewerUserIds",
      "rollbackUserIds", "requirementSourceRefs", "caseOracleRefs", "nativeOwnership", "maxActions",
      "maxCandidatesPerAction", "maxEvaluationsPerCandidate", "maxOuterCycles", "maxEvidenceResubmissions",
      "maxExecutionAttempts", "maxCostCentsPerGroup", "maxCostCentsPerPeriod", "periodStart", "periodEnd",
      "maxElapsedSeconds", "decisionTtlSeconds", "observationSeconds", "reconcileBatchSize",
    ];
    for (const key of keys) expect(parsed[key], key).toBeDefined();
  });
});

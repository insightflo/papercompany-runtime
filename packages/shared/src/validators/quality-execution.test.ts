import { describe, expect, it } from "vitest";
import {
  checkResultSchema,
  evidenceScopeSchema,
  missingEvidenceSchema,
  outputCorrectionScopeSchema,
} from "./quality-execution.js";

const artifactRef = {
  attachmentId: "33333333-3333-4333-8333-333333333333",
  sha256: "bb".repeat(32),
};

// [TEST DATA] 계약 형태 검증용 최소 스코프 예시. 운영 기본값이 아니다.
const evaluationScope = {
  kind: "evaluation" as const,
  companyId: "11111111-1111-4111-8111-111111111111",
  actionId: "22222222-2222-4222-8222-222222222222",
  evaluationId: "33333333-3333-4333-8333-333333333333",
  missionId: "44444444-4444-4444-8444-444444444444",
  workflowRunId: "55555555-5555-4555-8555-555555555555",
  stepRunId: "66666666-6666-4666-8666-666666666666",
  generation: 2,
  issueId: "77777777-7777-4777-8777-777777777777",
  heartbeatRunId: "88888888-8888-4888-8888-888888888888",
  executionEpoch: 1,
};

const planQaScope = {
  kind: "plan_qa" as const,
  companyId: "11111111-1111-4111-8111-111111111111",
  missionId: "44444444-4444-4444-8444-444444444444",
  planArtifactId: "99999999-9999-4999-8999-999999999999",
  issueId: "77777777-7777-4777-8777-777777777777",
  decisionHash: "ab".repeat(32),
  manifestRef: artifactRef,
  reviewGeneration: 1,
  heartbeatRunId: "88888888-8888-4888-8888-888888888888",
  executionEpoch: 1,
  workflow: { kind: "not_applicable" as const, reason: "mission_plan_qa_issue" as const },
};

const outputCorrectionScope = {
  kind: "output_correction" as const,
  companyId: "11111111-1111-4111-8111-111111111111",
  actionId: "22222222-2222-4222-8222-222222222222",
  source: {
    companyId: "11111111-1111-4111-8111-111111111111",
    issueId: "77777777-7777-4777-8777-777777777777",
    heartbeatRunId: "88888888-8888-4888-8888-888888888888",
    executionEpoch: 1,
    inputHash: "cd".repeat(32),
    mission: { kind: "mission" as const, id: "44444444-4444-4444-8444-444444444444" },
    workflow: { kind: "not_applicable" as const, reason: "not_a_workflow_source" as const },
  },
  verifierRunId: "88888888-8888-4888-8888-888888888888",
  verifierEpoch: 1,
};

describe("evidenceScopeSchema", () => {
  it("accepts evaluation, plan_qa, and output_correction scopes", () => {
    expect(evidenceScopeSchema.safeParse(evaluationScope).success).toBe(true);
    expect(evidenceScopeSchema.safeParse(planQaScope).success).toBe(true);
    expect(evidenceScopeSchema.safeParse(outputCorrectionScope).success).toBe(true);
  });

  it("rejects unknown scope kinds and strict-shape violations", () => {
    expect(evidenceScopeSchema.safeParse({ ...evaluationScope, kind: "wildcard" }).success).toBe(false);
    expect(evidenceScopeSchema.safeParse({ ...evaluationScope, extra: true }).success).toBe(false);
    expect(evidenceScopeSchema.safeParse({ ...planQaScope, decisionHash: "short" }).success).toBe(false);
    expect(evidenceScopeSchema.safeParse({ ...planQaScope, manifestRef: { attachmentId: "x" } }).success).toBe(false);
  });

  it("requires non-negative integer epochs and generations", () => {
    for (const bad of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(evidenceScopeSchema.safeParse({ ...evaluationScope, executionEpoch: bad }).success).toBe(false);
      expect(outputCorrectionScopeSchema.safeParse({ ...outputCorrectionScope, verifierEpoch: bad }).success)
        .toBe(false);
    }
    expect(evidenceScopeSchema.safeParse({ ...evaluationScope, executionEpoch: 0 }).success).toBe(true);
  });

  it("rejects company mixing inside correction scope", () => {
    const mixed = { ...outputCorrectionScope, source: { ...outputCorrectionScope.source, companyId: "99999999-9999-4999-8999-999999999999" } };
    expect(outputCorrectionScopeSchema.safeParse(mixed).success).toBe(false);
    expect(evidenceScopeSchema.safeParse(mixed).success).toBe(false);
  });

  it("keeps source attempts mission/workflow-discriminated", () => {
    expect(evidenceScopeSchema.safeParse({
      ...outputCorrectionScope,
      source: { ...outputCorrectionScope.source, mission: { kind: "mission" } },
    }).success).toBe(false);
    expect(evidenceScopeSchema.safeParse({
      ...outputCorrectionScope,
      source: { ...outputCorrectionScope.source, workflow: { kind: "workflow_step", runId: "x" } },
    }).success).toBe(false);
  });
});

describe("missingEvidenceSchema", () => {
  const validMissing = {
    status: "missing_evidence" as const,
    scope: evaluationScope,
    reasons: [
      { code: "quality_evidence_not_found", checkId: null, requiredKind: "evaluation_receipt", expectedHash: null },
    ],
    submission: { method: "POST" as const, path: "/api/agents/quality/evaluations", schemaVersion: 1 },
    remainingResubmissions: 1,
  };

  it("accepts a structured missing-evidence result", () => {
    expect(missingEvidenceSchema.safeParse(validMissing).success).toBe(true);
  });

  it("requires the dedicated POST submission contract", () => {
    expect(missingEvidenceSchema.safeParse({
      ...validMissing,
      submission: { ...validMissing.submission, method: "GET" },
    }).success).toBe(false);
    expect(missingEvidenceSchema.safeParse({
      ...validMissing,
      submission: { method: "POST", path: "/api/agents/quality/evaluations" },
    }).success).toBe(false);
  });

  it("allows zero remaining resubmissions but rejects negatives and fractions", () => {
    expect(missingEvidenceSchema.safeParse({ ...validMissing, remainingResubmissions: 0 }).success).toBe(true);
    for (const bad of [-1, 1.5, "2"]) {
      expect(missingEvidenceSchema.safeParse({ ...validMissing, remainingResubmissions: bad }).success).toBe(false);
    }
  });
});

describe("checkResultSchema", () => {
  const validResult = {
    checkId: "check-adoption-evidence",
    status: "satisfied" as const,
    readRef: artifactRef,
    evidence: [artifactRef],
  };

  it("accepts each declared status and rejects unknown statuses", () => {
    for (const status of ["satisfied", "defect", "insufficient_evidence", "execution_error", "excluded"]) {
      expect(checkResultSchema.safeParse({ ...validResult, status }).success, status).toBe(true);
    }
    expect(checkResultSchema.safeParse({ ...validResult, status: "passed" }).success).toBe(false);
  });

  it("requires the read reference artifact", () => {
    expect(checkResultSchema.safeParse({ ...validResult, readRef: null }).success).toBe(false);
    expect(checkResultSchema.safeParse({ ...validResult, readRef: { attachmentId: "bad" } }).success).toBe(false);
  });
});

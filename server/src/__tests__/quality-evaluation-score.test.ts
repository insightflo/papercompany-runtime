// server/src/__tests__/quality-evaluation-score.test.ts
//
// [purpose] T6 순수 판정: scoreEvaluation 최소 계약(brief 그대로)과 CheckResult→사례 판정 매핑.
// 서버는 고정 manifest join 으로 만든 Comparison 에만 이 함수를 쓴다(클라이언트 제출 배열 무관).

import { describe, expect, it } from "vitest";
import type { CheckResult } from "@paperclipai/shared";
import { caseVerdict, comparisonSchema, scoreEvaluation, type Comparison } from "../services/quality/evaluation-contract.js";

function result(checkId: string, status: CheckResult["status"]): CheckResult {
  return { checkId, status, readRef: { attachmentId: "00000000-0000-4000-8000-000000000001", sha256: "ab".repeat(32) }, evidence: [] };
}

describe("scoreEvaluation pure contract", () => {
  it("requires a reproduced miss and normal-case protection", () => {
    const f = { id: "f", group: "failure", expected: "request_changes",
      baseline: "pass", candidate: "request_changes", semantic: "verified" } as const;
    const n = { id: "n", group: "normal", expected: "pass",
      baseline: "pass", candidate: "pass", semantic: "verified" } as const;
    expect(scoreEvaluation([])).toBe("missing_evidence");
    expect(scoreEvaluation([f])).toBe("missing_evidence");
    expect(scoreEvaluation([f, n])).toBe("pass");
    expect(scoreEvaluation([{ ...f, baseline: "request_changes" }, n])).toBe("no_improvement");
  });

  it("fails on candidate defects even when the miss is reproduced", () => {
    const f = { id: "f", group: "failure", expected: "request_changes",
      baseline: "pass", candidate: "request_changes", semantic: "verified" } as const;
    const n = { id: "n", group: "normal", expected: "pass",
      baseline: "pass", candidate: "request_changes", semantic: "verified" } as const;
    expect(scoreEvaluation([f, n])).toBe("fail");
  });

  it.each([
    ["empty rows", [] as const],
    ["failure cases only", [{ id: "f", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "verified" }]],
    ["normal cases only", [{ id: "n", group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" }]],
    ["duplicate case ids", [
      { id: "n", group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
      { id: "n", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "verified" },
    ]],
    ["null variant outcome", [
      { id: "f", group: "failure", expected: "request_changes", baseline: null, candidate: "request_changes", semantic: "verified" },
      { id: "n", group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
    ]],
    ["missing semantic verification", [
      { id: "f", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "missing" },
      { id: "n", group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
    ]],
  ])("returns missing_evidence for %s", (_name, rows) => {
    expect(scoreEvaluation(rows as never)).toBe("missing_evidence");
  });

  it("fails on semantic mismatch even when statuses look perfect", () => {
    const rows: Comparison[] = [
      { id: "f", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "mismatch" },
      { id: "n", group: "normal", expected: "pass", baseline: "pass", candidate: "pass", semantic: "verified" },
    ];
    expect(scoreEvaluation(rows)).toBe("fail");
  });

  it("keeps the comparison contract strict and machine-validated", () => {
    expect(comparisonSchema.safeParse({ id: "f", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "verified" }).success).toBe(true);
    expect(comparisonSchema.safeParse({ id: "f", group: "failure", expected: "skip", baseline: "pass", candidate: "request_changes", semantic: "verified" }).success).toBe(false);
    expect(comparisonSchema.safeParse({ id: "f", group: "failure", expected: "request_changes", baseline: "pass", candidate: "request_changes", semantic: "verified", note: "표시용 메모" }).success).toBe(false);
  });
});

describe("caseVerdict mapping from CheckResult statuses", () => {
  it("maps defect to request_changes and full satisfaction to pass", () => {
    expect(caseVerdict([result("a", "satisfied")])).toBe("pass");
    expect(caseVerdict([result("a", "satisfied"), result("b", "defect")])).toBe("request_changes");
  });
  it("treats unproven outcomes as null (never a verdict)", () => {
    expect(caseVerdict([result("a", "insufficient_evidence")])).toBeNull();
    expect(caseVerdict([result("a", "execution_error")])).toBeNull();
    expect(caseVerdict([result("a", "excluded")])).toBeNull();
    expect(caseVerdict([])).toBeNull();
  });
});

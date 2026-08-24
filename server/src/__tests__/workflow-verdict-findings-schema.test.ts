// server/src/__tests__/workflow-verdict-findings-schema.test.ts
//
// [purpose] 단위: workflowVerdictSubmitSchema 의 findings(결함 계층 태그) 확장 검증.
//   - verdict=request_changes 와만 공존(그 외 verdict 에 findings 제출 → 거부).
//   - 항목 형식(id/summary/layer), 개수 상한(20), 경계값.
//   - 미제출 시 기존 동작 100% 유지(optional — fail-closed 기반 안전 장치).

import { describe, expect, it } from "vitest";
import { workflowVerdictSubmitSchema } from "@paperclipai/shared";

describe("workflowVerdictSubmitSchema — findings (qa defect layer)", () => {
  it("accepts request_changes with source_data/artifact findings", () => {
    const parsed = workflowVerdictSubmitSchema.parse({
      verdict: "request_changes",
      reason: "KR 데이터 완전성 결함",
      findings: [
        { id: "kr-index-missing", summary: "kr_index artifact absent", layer: "source_data" },
        { id: "table-overflow", summary: "mobile table overflow", layer: "artifact" },
      ],
    });
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings![0]!.layer).toBe("source_data");
  });

  it("rejects findings with verdict=pass (request_changes 전용)", () => {
    const result = workflowVerdictSubmitSchema.safeParse({
      verdict: "pass",
      findings: [{ id: "f1", summary: "x", layer: "source_data" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("findings"))).toBe(true);
    }
  });

  it("rejects findings with verdict=insufficient_evidence", () => {
    const result = workflowVerdictSubmitSchema.safeParse({
      verdict: "insufficient_evidence",
      reason: "artifact unreadable",
      findings: [{ id: "f1", summary: "x", layer: "artifact" }],
    });
    expect(result.success).toBe(false);
  });

  it("keeps legacy submissions (no findings) valid for every verdict", () => {
    expect(workflowVerdictSubmitSchema.safeParse({ verdict: "pass" }).success).toBe(true);
    expect(workflowVerdictSubmitSchema.safeParse({ verdict: "request_changes", reason: "broken" }).success).toBe(true);
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "insufficient_evidence",
      reason: "missing artifact",
    }).success).toBe(true);
  });

  it("enforces item bounds (id<=80, summary<=300) and count<=20", () => {
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: [{ id: "x".repeat(81), summary: "s", layer: "artifact" }],
    }).success).toBe(false);
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: [{ id: "x", summary: "s".repeat(301), layer: "artifact" }],
    }).success).toBe(false);
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, summary: "s", layer: "artifact" })),
    }).success).toBe(false);
  });

  it("rejects unknown layer values", () => {
    const result = workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: [{ id: "f1", summary: "s", layer: "infrastructure" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty id/summary strings", () => {
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: [{ id: "", summary: "s", layer: "artifact" }],
    }).success).toBe(false);
    expect(workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: [{ id: "f1", summary: "  ", layer: "artifact" }],
    }).success).toBe(false);
  });

  it("allows exactly 20 findings (boundary)", () => {
    const result = workflowVerdictSubmitSchema.safeParse({
      verdict: "request_changes",
      findings: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, summary: "s", layer: "source_data" })),
    });
    expect(result.success).toBe(true);
  });
});

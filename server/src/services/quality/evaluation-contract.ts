// server/src/services/quality/evaluation-contract.ts
//
// [purpose] T6 순수 평가 계약. Comparison/caseVerdict/scoreEvaluation 은 서버가
//   고정 manifest 를 join 해 만든 행에만 쓴다. 클라이언트가 제출한 요약 배열로는
//   PASS 를 만들 수 없다(이 모듈을 부르는 주체는 서버뿐이다).
// [authority] brief 가 지정한 scoreEvaluation 논리를 그대로 둔다. plan 입력은 고정
//   구조화 schema 로만 해석한다(자연문·stdout 파싱 금지).

import { z } from "zod";
import type { CheckResult } from "@paperclipai/shared";

export const comparisonSchema = z.object({
  id: z.string().min(1).max(200),
  group: z.enum(["failure", "normal"]),
  expected: z.enum(["pass", "request_changes"]),
  baseline: z.enum(["pass", "request_changes"]).nullable(),
  candidate: z.enum(["pass", "request_changes"]).nullable(),
  semantic: z.enum(["verified", "mismatch", "missing"]),
}).strict();
export type Comparison = z.infer<typeof comparisonSchema>;

export type EvaluationVerdict = "pass" | "fail" | "no_improvement";

export function scoreEvaluation(rows: readonly Comparison[]): EvaluationVerdict | "missing_evidence" {
  if (!rows.length || !rows.some((r) => r.group === "failure") || !rows.some((r) => r.group === "normal")
      || new Set(rows.map((r) => r.id)).size !== rows.length
      || rows.some((r) => r.baseline === null || r.candidate === null || r.semantic === "missing"))
    return "missing_evidence" as const;
  if (rows.some((r) => r.semantic === "mismatch" || r.candidate !== r.expected)) return "fail" as const;
  return rows.some((r) => r.group === "failure" && r.baseline !== r.expected)
    ? "pass" as const : "no_improvement" as const;
}

/** CheckResult 상태 → 사례 판정. 증명되지 않은 상태는 null(판정 아님)이다. */
export function caseVerdict(results: readonly CheckResult[]): "pass" | "request_changes" | null {
  if (!results.length) return null;
  let verdict: "pass" | "request_changes" | null = "pass";
  for (const result of results) {
    if (result.status === "defect") return "request_changes";
    if (result.status === "satisfied") continue;
    verdict = null; // insufficient_evidence / execution_error / excluded 는 판정 불성립
  }
  return verdict;
}

/** open 이 저장 bytes 를 다시 읽은 뒤 해석하는 고정 plan schema(버전 1). */
export const planDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  goal: z.string().min(1).max(2_000),
  steps: z.array(z.object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(2_000),
    detail: z.string().min(1).max(8_000),
  }).strict()).min(1).max(200),
}).strict();
export type PlanDocument = z.infer<typeof planDocumentSchema>;

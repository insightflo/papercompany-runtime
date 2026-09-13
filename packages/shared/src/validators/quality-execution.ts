// 증거 읽기·제출·실행 계약 재노출. 소유 모듈은 quality-plan-qa.ts (plan-qa scope 결합 +
// T8 재제출 dispatch 계약이 같은 모듈에서 정의된다). 기존 import 경로를 유지하기 위한 얇은 재노출.
export { checkResultSchema, type CheckResult } from "./quality-evaluation.js";
export {
  evidenceScopeSchema,
  missingEvidenceSchema,
  outputCorrectionScopeSchema,
  type EvidenceScope,
  type MissingEvidence,
  type OutputCorrectionScope,
} from "./quality-plan-qa.js";

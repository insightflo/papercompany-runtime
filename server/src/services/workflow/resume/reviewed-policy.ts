/**
 * [파일 목적] Task6a resume preview 의 검토된(resumed) 정책 불변 매니페스트 경계.
 *   검토 완료된 (company, definitionHash) 조합에 대해서만 step effect / tool binding /
 *   required gate / publication / generation 매핑을 선언한다.
 * [불변식]
 *   - 이 레지스트리는 사람 검토 결과의 컴파일 타임 불변 매니페스트다. client 입력, DB JSON,
 *     prose, env, 도구 이름 allowlist 로 policy 를 공급하는 경로는 존재하지 않는다.
 *   - toolBindings 는 "검토 시점의" registry 행 정확 참조(id/updatedAt ISO/configHash)다.
 *     configHash 는 hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema})
 *     이며, preview-policy 가 현재 DB registry 행과 대조한다. 이름만 같고 설정이 다른 행은
 *     resolve 되지 않는다(도구 효과 추론 금지).
 *   - 현재 REVIEWED_RESUME_POLICIES 는 비어 있다(상위 슬라이스가 독립 검토 후 정확한 policy 를
 *     직접 삽입). 이 파일의 로직은 없다 — 데이터 경계만 있다. 검토 없이 배열을 채우는 것은
 *     이 레지스트리의 계약 위반이다.
 * [수정시 주의] schemaVersion 은 1 고정. steps 의 key 는 frozen definition 의 stepId 다.
 */

export interface ReviewedResumePolicyToolBinding {
  id: string;
  updatedAt: string;
  configHash: string;
}

export interface ReviewedResumePolicyStep {
  effect: "none" | "read_only" | "external";
  toolBindings: ReviewedResumePolicyToolBinding[];
}

export interface ReviewedResumePolicy {
  schemaVersion: 1;
  companyId: string;
  definitionHash: string;
  steps: Record<string, ReviewedResumePolicyStep>;
  requiredGateStepIds: string[];
  publicationStepIds: string[];
  generationStepIds: string[];
}

/** [현재 상태] 비어 있음 — preview 는 항상 external_effect_unknown 으로 fail-closed 된다.
 *  이는 임시 conservative proof gap 이며, 상위 슬라이스가 검토된 policy 를 넣기 전까지
 *  resume 은 절대 eligible 이 되지 않는다. 부재를 적격으로 해석하지 않는다. */
export const REVIEWED_RESUME_POLICIES: readonly ReviewedResumePolicy[] = [];

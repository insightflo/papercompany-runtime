/**
 * [파일 목적] Task6a resume preview 의 검토된(resumed) 정책 불변 매니페스트 경계.
 *   검토 완료된 (company, definitionHash) 조합에 대해서만 step effect / tool binding /
 *   required gate / publication / generation 매핑을 선언한다.
 * [불변식]
 *   - 이 레지스트리는 사람 검토 결과의 컴파일 타임 불변 매니페스트다. client 입력, DB JSON,
 *     prose, env, 도구 이름 allowlist 로 policy 를 공급하는 경로는 존재하지 않는다.
 *   - 각 엔트리에는 검토 근거(원본 정의 식별·도구 실제 동작 요약·바인딩 채취 방법·날짜)를
 *     헤더 주석으로 남겨야 한다. 근거 주석 없는 엔트리는 계약 위반이다.
 *   - toolBindings 는 "검토 시점의" registry 행 정확 참조(id/updatedAt ISO/configHash)다.
 *     configHash 는 hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema})
 *     이며, preview-policy 가 현재 DB registry 행과 대조한다. 이름만 같고 설정이 다른 행은
 *     resolve 되지 않는다(도구 효과 추론 금지).
 *   - 이 파일의 로직은 없다 — 데이터 경계만 있다. 검토 없이 배열을 채우는 것은
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

/**
 * [현재 상태] 2026-10-22 youtube-report 검토 정책 1건 등록(회사 ff3e3efd, 미션 74a44d52
 *   의 run 8305cef9 frozen definition). 각 엔트리의 헤더 주석이 검토 근거(원본 정의·도구 실제
 *   동작·바인딩 채취 방법·날짜)이며, 근거 없는 엔트리 추가는 이 레지스트리의 계약 위반이다.
 *  [운영 주의] toolBindings 는 검토 시점 registry 행의 정확한 참조다. 해당 tool_definitions 행의
 *   enabled/updatedAt/설정(adapterConfig·inputSchema)이 바뀌면 bindingResolves 가 실패해 그
 *   스텝 effect 는 unknown 으로 되돌아가고(external_effect_unknown 재발) 정책은 자동 무효화된다.
 *   이는 의도된 fail-closed 동작이며, 도구 변경 후에는 이 매니페스트를 다시 검토·갱신해야 한다.
 */
export const REVIEWED_RESUME_POLICIES: readonly ReviewedResumePolicy[] = [
  /**
   * [검토 근거 — 2026-10-22] 원본 정의: workflow_definitions 006d48fe-c6b1-4161-8679-e9894a0c6ca8
   *   (youtube-report, updated 2026-10-17). 검토 대상 스냅샷: workflow_run_definitions run
   *   8305cef9-1ae8-4a9e-bb72-67e9a2f9be49 (definition_hash 아래, captured 2026-10-21, static_dag,
   *   9스텝). 스텝 효과는 frozen 스텝 서술·adapter_config·A1 실행 스크립트로 확인했다.
   *   - collect-youtube-evidence (http→n8n youtube-source-evidence): 유튜브 자막/Gemini 요약을
   *     읽어 artifact 를 런타임 워크스페이스에 저장. 외부 쓰기 없음 → read_only.
   *   - summarize-select-scenes (agent): 등록된 youtube-source-evidence.json 만 읽고 scene plan
   *     산출물 등록(스텝 서술 "입력: 등록된 youtube-source-evidence.json만 사용") → none.
   *   - stage-youtube-video (http→n8n stage-youtube-video): 영상 다운로드 후 A1 호스트 stagedPath
   *     파일 기록(응답 계약 bytes/stagedPath existingFile). 워크스페이스 밖 지속 쓰기 → external.
   *   - capture-youtube-frames (builtin python capture.py): staged 캐시 우선, 없으면 yt-dlp 직접
   *     다운로드(외부 읽기). frames/manifest 는 output-dir(워크스페이스)에만 기록 → read_only.
   *   - build-youtube-report-content (agent, report-for-beginners): 내부 산출물 입력 + "채널 정보는
   *     원본 영상 oEmbed에서 확인"(외부 읽기). content.json/assets 산출, 발행 없음 → read_only.
   *   - validate-youtube-report-content (agent QA): 등록된 content.json 대조 검증, PASS/
   *     REQUEST_CHANGES 반환, "발행 도구를 호출하지 않는다" → none.
   *   - qa-youtube-report-content (builtin manual-onboarding-qa.mjs qa): 등록 HTML 기계 검사,
   *     결과 JSON 을 워크스페이스에 기록. 외부 쓰기 없음 → none. 발행 직전 기계 게이트이므로
   *     requiredGateStepIds 에 등록(재개가 이 게이트를 건너뛰는 것을 금지).
   *   - publish-onboarding-manual (builtin manual-onboarding-publish): Cloudflare API 토큰·D1·
   *     사이트 루트(/srv/manual-onboarding-app)로 외부 발행 → external + publicationStepIds.
   *   - verify-onboarding-manual-publish (builtin manual-onboarding-verify): 공개 상태
   *     publicDetailStatus 200/indexHasEntry 확인 읽기 → read_only.
   *   generationStepIds: 새 콘텐츠/이미지를 산출하는 스텝(장면 구성·프레임 추출·보고서 초안).
   *     validate 는 판정만 반환하므로 제외했다.
   * [바인딩 채취] 2026-10-22 A1(127.0.0.1:54329 paperclip)에서 배포 런타임의
   *   hashStructuredValue({name,enabled,adapterType,adapterConfig,inputSchema}) 와 postgres.js
   *   updatedAt.toISOString() 로 계산. registry 행이 이 시점과 같아야 binding 이 resolve 된다.
   */
  {
    schemaVersion: 1,
    companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
    definitionHash: "d0b3eca4019e01d75ef97661351f6a9e03954eb585c0e610d71b69d8bf9a97c6",
    steps: {
      "collect-youtube-evidence": {
        effect: "read_only",
        toolBindings: [{
          id: "6090651e-f710-4c53-b874-2706a083bccd",
          updatedAt: "2026-08-26T02:19:43.611Z",
          configHash: "d1c9ffa152673df423d43d51100fb911f326ddf9724670c61e536e80daa519fa",
        }],
      },
      "summarize-select-scenes": { effect: "none", toolBindings: [] },
      "stage-youtube-video": {
        effect: "external",
        toolBindings: [{
          id: "84d0ca94-6b26-4903-995a-4292e62f5dcf",
          updatedAt: "2026-08-27T02:04:26.319Z",
          configHash: "243d2070a86fade821379f399a3d2ef2e6e8ff2cd7db0ebf01ebf1daf9790bf1",
        }],
      },
      "capture-youtube-frames": {
        effect: "read_only",
        toolBindings: [{
          id: "1238c3f7-7bba-4f85-ba02-4dec3519e14b",
          updatedAt: "2026-08-28T13:12:54.623Z",
          configHash: "af15397063aa980988491878739bb90b8a53a43fbb9cbb4b03f5ae57f9f8f3c8",
        }],
      },
      "build-youtube-report-content": { effect: "read_only", toolBindings: [] },
      "validate-youtube-report-content": { effect: "none", toolBindings: [] },
      "qa-youtube-report-content": {
        effect: "none",
        toolBindings: [{
          id: "9512da2f-46af-4ddb-86e4-21bd1c152094",
          updatedAt: "2026-10-02T00:02:12.308Z",
          configHash: "91be83e8546bf63c2b11c37873d6f0b5b7940f60e3ea02748b300f0822473f50",
        }],
      },
      "publish-onboarding-manual": {
        effect: "external",
        toolBindings: [{
          id: "db36b402-5e7c-4efe-a6d9-ee9bfa1fde43",
          updatedAt: "2026-10-03T07:21:49.187Z",
          configHash: "ec9bd5eda6af5c3e6db2c2f342e4899290f00cebf2d62b05c1056488589cb993",
        }],
      },
      "verify-onboarding-manual-publish": {
        effect: "read_only",
        toolBindings: [{
          id: "2523e587-77a8-4a93-ba2f-b1cac07bb777",
          updatedAt: "2026-10-02T00:02:12.723Z",
          configHash: "4f16e4ad1884ae70782afe12baf91075e066cef41187ef2fe373c5e16504eb3d",
        }],
      },
    },
    requiredGateStepIds: ["qa-youtube-report-content"],
    publicationStepIds: ["publish-onboarding-manual"],
    generationStepIds: [
      "summarize-select-scenes",
      "capture-youtube-frames",
      "build-youtube-report-content",
    ],
  },
];

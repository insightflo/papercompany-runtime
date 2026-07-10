import type { RecordFailureInput } from "./agent-wiki.js";
import { isActionableClaimedArtifactPath } from "./work-products/artifact-claim-paths.js";
import { isPathInsideOrEqual } from "./work-products/output-paths.js";

type FailureClassification = {
  readonly category: string;
  readonly reasonCode: string;
};

type WikiLesson = Pick<RecordFailureInput, "pattern" | "cause" | "solution" | "errorCode">;

export function buildHeartbeatFailureWikiLesson(input: {
  readonly classification: FailureClassification;
  readonly runStatus: string;
  readonly runErrorCode: string | null;
}): WikiLesson | null {
  if (
    input.runStatus === "failed" &&
    input.classification.reasonCode === "STEP_INPUT_MANIFEST_GUARDRAIL"
  ) {
    return {
      pattern: "Step Input Manifest 광범위 검색 차단",
      cause: "에이전트가 허용된 파일 경로 없이 rg/find/tree 같은 검색 명령을 실행해 Step Input Manifest 런타임 정책이 실행을 차단함.",
      solution: "저장소나 디렉터리를 검색하지 않는다. 현재 단계 출력 파일 또는 런타임에 등록된 선행 workProduct의 정확한 파일 경로만 검색한다. 디렉터리, 와일드카드, 파일명만 지정한 경로, 셸 변수 경로는 사용하지 않는다.",
      errorCode: "step_input_manifest_guardrail",
    };
  }

  if (
    input.runStatus === "failed" &&
    input.runErrorCode === "adapter_failed" &&
    input.classification.category !== "overload"
  ) {
    return {
      pattern: "adapter_failed (adapter 실행 실패)",
      cause: "adapter 실행이 실패해 run 종료. opencode models discovery timeout(20s), command 시작 실패(ENOENT), adapter 내부 에러 등.",
      solution: "opencode models timeout은 retry+stale serve로 완화. 반복 시 adapter command, PATH, 인증, 리소스를 점검하고 command 부재는 adapter 설정에서 수정한다.",
      errorCode: "adapter_failed",
    };
  }

  return null;
}

export function classifyWorkProductFailure(input: {
  readonly allowedArtifactRoot: string | null;
  readonly explicitArtifactPaths: readonly string[];
}): {
  readonly failureClass: "missing_work_product_registration" | "workproduct_path_outside_allowed_root";
  readonly wikiLesson: WikiLesson;
} {
  const allowedArtifactRoot = input.allowedArtifactRoot;
  const outsidePaths = allowedArtifactRoot
    ? input.explicitArtifactPaths
      .filter(isActionableClaimedArtifactPath)
      .filter((artifactPath) => !isPathInsideOrEqual(artifactPath, allowedArtifactRoot))
    : [];

  if (outsidePaths.length > 0) {
    return {
      failureClass: "workproduct_path_outside_allowed_root",
      wikiLesson: {
        pattern: "workProduct 경로 범위 오류",
        cause: `에이전트가 현재 실행에 할당된 산출물 루트 밖의 경로 ${outsidePaths.length}개를 workProduct로 선언함.`,
        solution: "실행 카드의 assigned output directory 아래에 산출물을 만들고 그 정확한 절대경로를 Workflow API에 등록한다. 이전 실행, agent workspace, 임의 프로젝트 경로의 파일은 재사용하지 않는다.",
        errorCode: "workproduct_path_outside_allowed_root",
      },
    };
  }

  return {
    failureClass: "missing_work_product_registration",
    wikiLesson: {
      pattern: "workProduct 미등록",
      cause: "run이 산출물 파일 경로를 보고했지만 issue에 공식 workProduct가 등록되지 않아 mission artifact gate가 해당 이슈를 block함.",
      solution: "산출물 파일을 지정된 출력 디렉터리에 만들고 Workflow API로 등록한다. API를 사용할 수 없을 때만 실행 출력 끝에 `[ARTIFACT]: <절대경로>` 한 줄을 남긴다.",
      errorCode: "workproduct_registration_missing",
    },
  };
}

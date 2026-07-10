import { describe, expect, it } from "vitest";
import {
  buildHeartbeatFailureWikiLesson,
  classifyWorkProductFailure,
} from "../services/heartbeat-failure-wiki.js";

describe("heartbeat failure wiki lessons", () => {
  it("uses a dedicated lesson when Step Input Manifest blocks a broad scan", () => {
    const lesson = buildHeartbeatFailureWikiLesson({
      classification: {
        category: "command",
        reasonCode: "STEP_INPUT_MANIFEST_GUARDRAIL",
      },
      runStatus: "failed",
      runErrorCode: "adapter_failed",
    });

    expect(lesson).toEqual(expect.objectContaining({
      pattern: "Step Input Manifest 광범위 검색 차단",
      errorCode: "step_input_manifest_guardrail",
    }));
    expect(lesson?.solution).toContain("현재 단계 출력 파일");
    expect(lesson?.solution).toContain("등록된 선행 workProduct");
  });

  it("uses the generic adapter lesson for an unclassified adapter failure", () => {
    expect(buildHeartbeatFailureWikiLesson({
      classification: {
        category: "adapter",
        reasonCode: "ADAPTER_RUN_FAILED",
      },
      runStatus: "failed",
      runErrorCode: "adapter_failed",
    })).toEqual(expect.objectContaining({
      pattern: "adapter_failed (adapter 실행 실패)",
      errorCode: "adapter_failed",
    }));
  });

  it("does not create a guardrail lesson for a non-failed run", () => {
    expect(buildHeartbeatFailureWikiLesson({
      classification: {
        category: "command",
        reasonCode: "STEP_INPUT_MANIFEST_GUARDRAIL",
      },
      runStatus: "succeeded",
      runErrorCode: null,
    })).toBeNull();
  });
});

describe("workProduct failure wiki lessons", () => {
  it("distinguishes an explicit artifact path outside the assigned output root", () => {
    const failure = classifyWorkProductFailure({
      allowedArtifactRoot: "/srv/papercompany/projects/inflo/produced_work/missions/mission-1",
      explicitArtifactPaths: ["/srv/papercompany/projects/inflo/old-run/report.md"],
    });

    expect(failure.failureClass).toBe("workproduct_path_outside_allowed_root");
    expect(failure.wikiLesson).toEqual(expect.objectContaining({
      pattern: "workProduct 경로 범위 오류",
      errorCode: "workproduct_path_outside_allowed_root",
    }));
    expect(failure.wikiLesson.cause).not.toContain("/srv/");
    expect(failure.wikiLesson.cause).toContain("1개");
  });

  it("keeps the missing-registration lesson when no explicit outside path exists", () => {
    const failure = classifyWorkProductFailure({
      allowedArtifactRoot: "/srv/papercompany/projects/inflo/produced_work/missions/mission-1",
      explicitArtifactPaths: [],
    });

    expect(failure.failureClass).toBe("missing_work_product_registration");
    expect(failure.wikiLesson).toEqual(expect.objectContaining({
      pattern: "workProduct 미등록",
      errorCode: "workproduct_registration_missing",
    }));
  });

  it("does not classify a non-deliverable instruction path as a workProduct path error", () => {
    const failure = classifyWorkProductFailure({
      allowedArtifactRoot: "/srv/papercompany/projects/inflo/produced_work/missions/mission-1",
      explicitArtifactPaths: ["/srv/papercompany/papercompany-runtime/node_modules/tool/README.md"],
    });

    expect(failure.failureClass).toBe("missing_work_product_registration");
  });
});

import { describe, expect, it } from "vitest";

import { responseTextFromRun } from "../services/hermes-chat.js";

describe("Hermes chat response extraction", () => {
  it("uses the raw run result instead of the 500-character run summary", () => {
    const longAnswer = [
      "현재 상태부터 다시 정리하면:",
      "",
      "1. 현재 상태",
      "- 미션은 completed 입니다.",
      "- 이슈 10개는 모두 done 입니다.",
      "- 워크플로우 런은 completed 입니다.",
      "",
      "2. 왜 이런 상태냐",
      "초기 QA인 RES-974가 한 번 REQUEST_CHANGES였지만 이후 수정과 재검증이 완료되었습니다.",
      "이 문장은 500자 뒤에도 보존되어야 합니다.",
      "x".repeat(650),
      "끝.",
    ].join("\n");

    const extracted = responseTextFromRun({
      status: "succeeded",
      resultJson: {
        result: longAnswer,
      },
      error: null,
    });

    expect(extracted).toBe(longAnswer);
    expect(extracted).toContain("이 문장은 500자 뒤에도 보존되어야 합니다.");
    expect(extracted.endsWith("끝.")).toBe(true);
  });
});

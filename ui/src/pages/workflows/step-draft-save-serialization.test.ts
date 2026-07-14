// @vitest-environment node

import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJsonForSave } from "./step-draft.js";

describe("workflow step save serialization", () => {
  it("rejects invalid tool args instead of replacing them with an empty object", () => {
    const [draft] = jsonToSteps([{
      id: "publish",
      title: "Publish report",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
    }]);
    draft.toolArgs = "```json\n{\"section\":\"tech-scout\"}\n```";

    const result = stepsToJsonForSave([draft]);

    expect(result).toEqual({
      error: expect.stringContaining('Tool step "publish"의 Tool Args JSON 파싱 실패:'),
    });
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { shouldShowWorkflowLoadingState } from "./workflow-page-states.js";

describe("workflow page loading state", () => {
  it("keeps the editor mounted while existing data is refreshed", () => {
    expect(shouldShowWorkflowLoadingState(true, true)).toBe(false);
  });

  it("shows the loading state during the initial load", () => {
    expect(shouldShowWorkflowLoadingState(true, false)).toBe(true);
  });
});

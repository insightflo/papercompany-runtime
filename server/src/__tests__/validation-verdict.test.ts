import { describe, expect, it } from "vitest";
import { readExplicitValidationVerdict } from "../services/validation-verdict.js";

describe("readExplicitValidationVerdict", () => {
  it("reads a terminal REQUEST_CHANGES verdict from the final non-empty line", () => {
    expect(readExplicitValidationVerdict([
      "## QA review",
      "",
      "The synthesis hides a fee contradiction.",
      "",
      "REQUEST_CHANGES: show both fee sources and mark the conflict.",
    ].join("\n"))).toBe("request_changes");
  });

  it("reads a terminal PASS verdict from a final verdict section", () => {
    expect(readExplicitValidationVerdict([
      "The prior REQUEST_CHANGES item was rechecked and fixed.",
      "",
      "### 판정",
      "PASS",
    ].join("\n"))).toBe("pass");
  });

  it("does not treat middle REQUEST_CHANGES or PASS mentions as a verdict", () => {
    expect(readExplicitValidationVerdict([
      "Previous reviewer wrote REQUEST_CHANGES: missing glossary.",
      "Another note says PASS was considered after a partial check.",
      "This comment is not a final verdict.",
    ].join("\n"))).toBeNull();
  });

  it("keeps heartbeat result compatibility for leading verdict plus detail lines", () => {
    expect(readExplicitValidationVerdict("REQUEST_CHANGES\n- fix hallucinated label", { allowLeadingVerdict: true })).toBe("request_changes");
    expect(readExplicitValidationVerdict("PASS\n- all checks complete", { allowLeadingVerdict: true })).toBe("pass");
  });
});

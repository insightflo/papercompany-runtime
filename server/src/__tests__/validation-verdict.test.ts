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

  it("reads a QA verdict section when evidence details follow the verdict line", () => {
    expect(readExplicitValidationVerdict([
      "## QA verdict",
      "",
      "REQUEST_CHANGES for [RES-980](/RES/issues/RES-980) HTML artifact before publication.",
      "",
      "- Verified file exists at the declared dependency workProduct path.",
      "- Not verified for publication-quality HTML: parser error remains.",
      "",
      "Required fixes:",
      "- Escape the Google Fonts query separator.",
      "- Replace local-only evidence paths in the user-facing page.",
    ].join("\n"))).toBe("request_changes");
  });

  it("keeps heartbeat result compatibility for leading verdict plus detail lines", () => {
    expect(readExplicitValidationVerdict("REQUEST_CHANGES\n- fix hallucinated label", { allowLeadingVerdict: true })).toBe("request_changes");
    expect(readExplicitValidationVerdict("PASS\n- all checks complete", { allowLeadingVerdict: true })).toBe("pass");
  });

  it("reads a labeled validator verdict from heartbeat result text", () => {
    expect(readExplicitValidationVerdict(
      "## Report Validator Verdict: **PASS**\n\nBoth requested fixes are verified.",
      { allowLeadingVerdict: true },
    )).toBe("pass");
  });

  it("ignores a leading markdown rule before a leading verdict", () => {
    expect(readExplicitValidationVerdict([
      "---",
      "",
      "**REQUEST_CHANGES: published URL points to the hub shell, not the detail page**",
      "",
      "The run succeeded, but delivery readback failed.",
    ].join("\n"), { allowLeadingVerdict: true })).toBe("request_changes");
  });
});

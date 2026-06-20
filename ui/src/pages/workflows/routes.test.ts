import { describe, expect, it } from "vitest";
import { buildIssueHref, buildMissionHref } from "./routes.js";

describe("workflow route helpers", () => {
  it("keeps mission links scoped to the current company route", () => {
    expect(buildMissionHref({
      missionId: "a64f67a3-bf73-40d1-80dd-3183401c4ed9",
      currentPathname: "/CMPA/workflows",
    })).toBe("/CMPA/missions/a64f67a3-bf73-40d1-80dd-3183401c4ed9");
  });

  it("falls back to unprefixed mission links outside company-scoped routes", () => {
    expect(buildMissionHref({
      missionId: "a64f67a3-bf73-40d1-80dd-3183401c4ed9",
      currentPathname: "/instance/settings/general",
    })).toBe("/missions/a64f67a3-bf73-40d1-80dd-3183401c4ed9");
  });

  it("preserves issue identifier routing for issue links", () => {
    expect(buildIssueHref({
      issueId: "issue-1",
      issueIdentifier: "CMPA-5230",
      currentPathname: "/RES/workflows",
    })).toBe("/CMPA/issues/issue-1");
  });
});

import { describe, expect, it } from "vitest";
import { stripShellEscapeResidue } from "../services/workflow/tool-step-args.ts";

describe("stripShellEscapeResidue", () => {
  it("strips a leading $ from bash ANSI-C residue paths ($/srv/...)", () => {
    expect(stripShellEscapeResidue({
      workflow: "agent-team-concept-radar",
      verifyResult: "$/srv/papercompany/projects/research-company/produced_work/missions/m1/runs/r1/steps/verify/manual.json",
    })).toEqual({
      workflow: "agent-team-concept-radar",
      verifyResult: "/srv/papercompany/projects/research-company/produced_work/missions/m1/runs/r1/steps/verify/manual.json",
    });
  });

  it("strips $' style residue", () => {
    expect(stripShellEscapeResidue("$'/srv/data/report.html'")).toBe("'/srv/data/report.html'");
  });

  it("leaves normal strings, shell vars without slash, and non-strings untouched", () => {
    expect(stripShellEscapeResidue("/srv/normal/path")).toBe("/srv/normal/path");
    expect(stripShellEscapeResidue("$HOME")).toBe("$HOME");
    expect(stripShellEscapeResidue("$$")).toBe("$$");
    expect(stripShellEscapeResidue(42)).toBe(42);
    expect(stripShellEscapeResidue(null)).toBe(null);
  });

  it("walks nested arrays and objects", () => {
    expect(stripShellEscapeResidue({
      a: ["$/tmp/x", "keep"],
      nested: { deep: "$/var/y" },
    })).toEqual({
      a: ["/tmp/x", "keep"],
      nested: { deep: "/var/y" },
    });
  });
});

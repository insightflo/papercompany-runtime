import { describe, expect, it } from "vitest";
import {
  buildAssignedIssueArtifactWorkflowText,
  buildArtifactOutputDirectoryLines,
  buildExistingArtifactRegistrationActionLines,
  buildMissingWorkProductRegistrationGateComment,
  buildWorkProductRegistrationContractLines,
} from "../services/work-products/artifact-registration-instructions.js";

describe("artifact registration instructions", () => {
  it("separates deliverable creation from workProduct registration", () => {
    const lines = buildWorkProductRegistrationContractLines();

    expect(lines.join("\n")).toContain(
      "Creating the deliverable file and registering the workProduct are separate steps.",
    );
    expect(lines.join("\n")).toContain("[ARTIFACT]: <absolute path>");
    expect(lines.join("\n")).toContain("If the deliverable file does not exist yet, create it");
    expect(lines.join("\n")).toContain("If it already exists, do not regenerate it");
    expect(lines.join("\n")).toContain("Prefer the Workflow API");
    expect(lines.join("\n")).toContain("/workflow/artifacts");
    expect(lines.join("\n")).toContain("Do not use the generic workProduct route");
  });

  it("points recovery runs at the existing file instead of regeneration", () => {
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/missions/m1/report.md";
    const lines = buildExistingArtifactRegistrationActionLines({ artifactPath });
    const text = lines.join("\n");

    expect(text).toContain("Required action:");
    expect(text).toContain(`The deliverable file already exists at \`${artifactPath}\``);
    expect(text).toContain(`[ARTIFACT]: ${artifactPath}`);
    expect(text).toContain("do not regenerate it");
  });

  it("pins producer output to the assigned directory", () => {
    const outputDir = "/srv/papercompany/projects/research-company/produced_work/missions/m1/runs/r1/steps/s1";
    const lines = buildArtifactOutputDirectoryLines({ outputDir });

    expect(lines).toEqual([
      "Deliverable output (use exactly this directory):",
      `- ${outputDir}`,
      "- Write or reuse deliverable file(s) only in that directory. Do not look under other produced_work paths, run dates, or sibling mission folders.",
    ]);
  });

  it("includes the shared contract in missing-registration gate comments", () => {
    const text = buildMissingWorkProductRegistrationGateComment({
      runId: "run-1",
      claimedArtifactPaths: ["/srv/papercompany/projects/research-company/produced_work/missions/m1/report.md"],
      allowedArtifactRoot: "/srv/papercompany/projects/research-company/produced_work/missions/m1",
    });

    expect(text).toContain("Mission artifact gate: workProduct registration missing");
    expect(text).toContain("Creating the deliverable file and registering the workProduct are separate steps.");
    expect(text).toContain("[ARTIFACT]: <absolute path>");
  });

  it("keeps assigned issue prompts explicit about create-or-register", () => {
    const text = buildAssignedIssueArtifactWorkflowText();

    expect(text).toContain("creating the file and registering the workProduct are separate");
    expect(text).toContain("If the file is missing, create it");
    expect(text).toContain("if it already exists, reuse it");
    expect(text).toContain("Register with the Workflow API first");
  });
});

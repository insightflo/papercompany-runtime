import { describe, expect, it } from "vitest";
import {
  buildAssignedIssueArtifactWorkflowText,
  buildArtifactOutputDirectoryLines,
  buildDelegatedWorkProductContractLines,
  buildExistingArtifactRegistrationActionLines,
  buildMissingWorkProductRegistrationGateComment,
  buildWorkProductRegistrationContractLines,
} from "../services/work-products/artifact-registration-instructions.js";

describe("artifact registration instructions", () => {
  it("separates deliverable creation from workProduct registration", () => {
    const text = buildWorkProductRegistrationContractLines().join("\n");

    expect(text).toContain(
      "Creating the deliverable file and registering the workProduct are separate steps.",
    );
    expect(text).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("This is the only registration authority.");
    expect(text).toContain("If the deliverable file does not exist yet, create it");
    expect(text).toContain("If it already exists, do not regenerate it");
    expect(text).toContain("Do not use the generic workProduct route");
    expect(text).toContain("or an `[ARTIFACT]` marker to register");
    expect(text).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(text).not.toMatch(/\[ARTIFACT\]:\s*<absolute path>/);
  });

  it("tells agents to register with a direct curl data-raw payload and forbids payload builders", () => {
    const text = buildWorkProductRegistrationContractLines().join("\n");

    // A literal inline JSON payload via --data-raw with an explicit content type is the
    // approved structured path (curl >= 7.55; works on the production 7.76.1 runtime).
    expect(text).toContain("--data-raw");
    expect(text).toContain("Content-Type: application/json");
    expect(text).not.toContain("curl --json");
    expect(text).toContain("$PAPERCLIP_API_URL/api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    expect(text).toContain("X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID");
    // Local-file title is server-controlled (basename); the recipe must not send a title.
    expect(text).toContain("omit the `title` field");
    // Payload builders that trigger the 60s approval are forbidden.
    expect(text).toContain("Do NOT build the JSON payload with Python");
    expect(text).toContain("a shell heredoc");
    expect(text).toContain("auto-denies after ~60s");
  });

  it("points recovery runs at the existing file instead of regeneration", () => {
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/missions/m1/report.md";
    const lines = buildExistingArtifactRegistrationActionLines({ artifactPath });
    const text = lines.join("\n");

    expect(text).toContain("Required action:");
    expect(text).toContain(`The deliverable file already exists at \`${artifactPath}\``);
    expect(text).toContain("do not regenerate it");
    expect(text).toContain("register that exact path via the Workflow API");
    expect(text).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("or an `[ARTIFACT]` marker to register");
    expect(text).not.toContain(`[ARTIFACT]: ${artifactPath}`);
  });

  it("pins producer output to the assigned directory", () => {
    const outputDir = "/srv/papercompany/projects/research-company/produced_work/missions/m1/runs/r1/steps/s1";
    const lines = buildArtifactOutputDirectoryLines({ outputDir });
    const text = lines.join("\n");

    expect(lines.slice(0, 3)).toEqual([
      "Deliverable output (use exactly this directory):",
      `- ${outputDir}`,
      "- Write or reuse deliverable file(s) only in that directory. Do not look under other produced_work paths, run dates, or sibling mission folders.",
    ]);
    expect(text).toContain("Evidence explanation quality");
    expect(text).toContain("source content -> observation -> interpretation -> conclusion");
    expect(text).toContain("storage details");
    expect(text).toContain("private traceability");
  });

  it("keeps delegated issue workProduct contracts focused on evidence chains", () => {
    const text = buildDelegatedWorkProductContractLines().join("\n");

    expect(text).toContain("source content -> observation -> interpretation -> conclusion");
    expect(text).toContain("workProducts as traceability, not the proof itself");
    expect(text).toContain("source workflow will copy those registered workProducts back");
    expect(text).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("or an `[ARTIFACT]` marker");
    expect(text).toContain("Only the Workflow API registers a work product");
  });

  it("includes the shared contract in missing-registration gate comments", () => {
    const text = buildMissingWorkProductRegistrationGateComment({
      runId: "run-1",
      claimedArtifactPaths: ["/srv/papercompany/projects/research-company/produced_work/missions/m1/report.md"],
      allowedArtifactRoot: "/srv/papercompany/projects/research-company/produced_work/missions/m1",
    });

    expect(text).toContain("Mission artifact gate: workProduct registration missing");
    expect(text).toContain("Creating the deliverable file and registering the workProduct are separate steps.");
    expect(text).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("or an `[ARTIFACT]` marker to register");
    expect(text).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(text).not.toMatch(/\[ARTIFACT\]:\s*<absolute path>/);
  });

  it("keeps assigned issue prompts explicit about create-or-register", () => {
    const text = buildAssignedIssueArtifactWorkflowText();

    expect(text).toContain("creating the file and registering the workProduct are separate");
    expect(text).toContain("source content -> observation -> interpretation -> conclusion");
    expect(text).toContain("workProducts as traceability, not the proof itself");
    expect(text).toContain("If the file is missing, create it");
    expect(text).toContain("if it already exists, reuse it");
    expect(text).toContain("Register the workProduct only with the Workflow API");
    expect(text).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(text).toContain("Do not rely on comments, stdout, or an `[ARTIFACT]` marker");
    expect(text).toContain("those are not registration authority");
  });
});

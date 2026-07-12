import { describe, expect, it } from "vitest";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";

describe("mission search scopes", () => {
  it("allows repo-wide rg and find only when repo scope is declared", () => {
    const context = {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory: "/repo",
        outputDirectory: null,
        dependencyFiles: [],
        dependencyDirectories: [],
        allowedSearchScopes: ["repo"],
      },
      paperclipStepInputManifest: {
        version: 1,
        guardrails: { broadScanAllowed: false, allowedSearchScopes: ["repo"] },
      },
    };

    expect(evaluateCodexCommand("rg -n TODO", context).blocked).toBe(false);
    expect(evaluateCodexCommand("rg -n TODO .", context).blocked).toBe(false);
    expect(evaluateCodexCommand("find . -type f", context).blocked).toBe(false);
    expect(evaluateCodexCommand("git ls-files", context).blocked).toBe(false);
  });

  it("keeps document-style missions restricted to declared paths", () => {
    const context = {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory: "/repo",
        outputDirectory: "/repo/out",
        dependencyFiles: ["/repo/out/evidence.json"],
        dependencyDirectories: ["/repo/out"],
        allowedSearchScopes: ["workProduct", "missionOutput"],
      },
      paperclipStepInputManifest: {
        version: 1,
        guardrails: {
          broadScanAllowed: false,
          allowedSearchScopes: ["workProduct", "missionOutput"],
        },
      },
    };

    expect(evaluateCodexCommand("rg -n TODO out/evidence.json", context).blocked).toBe(false);
    expect(evaluateCodexCommand("rg -n TODO", context).blocked).toBe(true);
    expect(evaluateCodexCommand("find . -type f", context).blocked).toBe(true);
  });

  it("records missionSearch guidance in the step input manifest", () => {
    const manifest = buildStepInputManifest({
      taskKey: "issue-1",
      context: {
        issueId: "issue-1",
        paperclipRuntimeSearchPaths: {
          allowedSearchScopes: ["repo", "logs"],
        },
      },
    });

    expect(manifest.guardrails.allowedSearchScopes).toEqual(["repo", "logs"]);
    expect(manifest.guardrails.broadScanAllowed).toBe(true);
    expect(manifest.inputs.missionSearch.guidance.join("\n")).toContain("missionSearch");
  });

  it("stores allowedSearchScopes on workflow execution cards", () => {
    const card = buildWorkflowIssueExecutionCard({
      title: "Develop feature",
      description: "Implement code changes.",
      companyId: "company-1",
      workflowDefinitionId: "workflow-1",
      workflowRunId: "run-1",
      step: {
        id: "implement",
        dependencies: [],
        allowedSearchScopes: ["repo", "config"],
      },
      isQaStep: false,
    });

    expect(card.toolPermissionContract?.allowedSearchScopes).toEqual(["repo", "config"]);
  });
});

function evaluateCodexCommand(command: string, context: Record<string, unknown>) {
  return evaluateRuntimeBroadScanToolGuard({
    adapterType: "codex_local",
    line: JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command,
        status: "in_progress",
      },
    }),
    ts: new Date().toISOString(),
    context,
  });
}

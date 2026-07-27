import { describe, expect, it } from "vitest";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { buildMissionSearchGuidance } from "../services/runtime-search-scopes.js";

describe("mission search scopes", () => {
  it("allows repo-wide search when repo scope is declared, but explicit root targets stay blocked", () => {
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

    // repo scope permits pathless search and repo-discovery commands:
    expect(evaluateCodexCommand("rg -n TODO", context).blocked).toBe(false);
    expect(evaluateCodexCommand("git ls-files", context).blocked).toBe(false);
    // pathless find is repo-scoped discovery (implicit root, but declared repo scope) → allowed.
    expect(evaluateCodexCommand("find -type f -name '*.ts'", context).blocked).toBe(false);
    // [handoff req 4] an EXPLICIT root target (.) is blocked even under repo scope —
    //   repo scope must not bypass the root-target block.
    expect(evaluateCodexCommand("rg -n TODO .", context).blocked).toBe(true);
    expect(evaluateCodexCommand("find . -type f", context).blocked).toBe(true);
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
    // pathless rg is allowed under the agreed root-target-only policy; only an
    // explicit root target (. / workdir / ..) or a pathless `find` (implicit root)
    // counts as a broad scan for document-style missions.
    expect(evaluateCodexCommand("rg -n TODO", context).blocked).toBe(false);
    expect(evaluateCodexCommand("rg -n TODO .", context).blocked).toBe(true);
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

  it("does not allow broad scans for project_primary workspace without repo scope", () => {
    // Single source of truth: broadScanAllowed follows ONLY the repo scope, not
    // a project_primary workspace OR. A project_primary run without repo scope
    // must report disallowed so the brief and the runtime guard agree.
    const manifest = buildStepInputManifest({
      taskKey: "issue-1",
      context: {
        issueId: "issue-1",
        paperclipWorkspace: { source: "project_primary", workspaceId: "ws-1", cwd: "/repo" },
        paperclipRuntimeSearchPaths: {
          allowedSearchScopes: ["workProduct", "missionOutput"],
        },
      },
    });

    expect(manifest.guardrails.broadScanAllowed).toBe(false);
  });

  it("renders an executable missionSearch curl recipe with a concrete scope", () => {
    const recipe = buildMissionSearchGuidance(["workProduct", "missionOutput"]).join("\n");

    expect(recipe).toContain("missionSearch API (callable): curl");
    expect(recipe).toContain("use the missionSearch API instead");
    expect(recipe).not.toContain("missionSearch tool");

    // Executable URL: PAPERCLIP_API_BASE_URL already includes /api — no /api/api.
    expect(recipe).toContain("$PAPERCLIP_API_BASE_URL/agents/me/mission-search");
    expect(recipe).not.toContain("/api/api/");

    // Double-quoted JSON / headers so the shell expands the $VAR references.
    expect(recipe).toContain("Bearer $PAPERCLIP_API_KEY");
    expect(recipe).toContain('"$PAPERCLIP_AGENT_ID"');
    expect(recipe).toContain('"$PAPERCLIP_RUN_ID"');
    expect(recipe).toContain('"$PAPERCLIP_COMPANY_ID"');

    // Concrete allowed scope, never a placeholder union like <workProduct|...>.
    expect(recipe).toContain('"scope":"workProduct"');
    expect(recipe).not.toContain("<workProduct|");
  });

  it("does not advertise a callable missionSearch recipe when no scope is available", () => {
    const guidance = buildMissionSearchGuidance([]).join("\n");

    expect(guidance).toContain("missionSearch is unavailable");
    expect(guidance).not.toContain("curl -sS");
  });

  it("blocks direct broad scans when the repo scope is server-side-only (PLAN-like)", () => {
    // PLAN issues get `repo` in allowedSearchScopes so the missionSearch API
    // accepts repo discovery, but broadScanRepoAllowed=false keeps direct
    // pathless rg/find blocked. The repo scope must not silently enable raw scans.
    const context = {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory: "/repo",
        outputDirectory: null,
        dependencyFiles: [],
        dependencyDirectories: [],
        allowedSearchScopes: ["repo"],
        broadScanRepoAllowed: false,
      },
      paperclipStepInputManifest: {
        version: 1,
        guardrails: { broadScanAllowed: false, allowedSearchScopes: ["repo"] },
      },
    };

    // git ls-files and the directory walkers (find/tree/ls -R) are broad scans gated
    // by the repo broad-scan allowance; PLAN keeps them blocked even though the
    // missionSearch API accepts a repo scope for this run.
    expect(evaluateCodexCommand("git ls-files", context).blocked).toBe(true);
    expect(evaluateCodexCommand("find -type f -name '*.ts'", context).blocked).toBe(true);
    expect(evaluateCodexCommand("tree", context).blocked).toBe(true);
    expect(evaluateCodexCommand("ls -R", context).blocked).toBe(true);
    // An explicit root target is always blocked, independent of scope.
    expect(evaluateCodexCommand("rg -n TODO .", context).blocked).toBe(true);
  });

  it("advertises repo scope via missionSearch but keeps raw scans blocked when broadScanRepoAllowed is false", () => {
    const guidance = buildMissionSearchGuidance(["repo"], { broadScanRepoAllowed: false }).join("\n");

    // repo is still an allowed missionSearch scope (callable recipe kept)...
    expect(guidance).toContain("repo");
    expect(guidance).toContain("missionSearch API (callable): curl");
    // ...but raw scans are explicitly blocked for this run.
    expect(guidance).toContain("use the missionSearch API instead");
    expect(guidance).not.toContain("repo broad-scan allowed");
  });

  it("reports broadScanAllowed false for a PLAN-like repo-only server-side scope in the manifest", () => {
    const manifest = buildStepInputManifest({
      taskKey: "issue-plan-1",
      context: {
        issueId: "issue-plan-1",
        paperclipRuntimeSearchPaths: {
          allowedSearchScopes: ["repo"],
          broadScanRepoAllowed: false,
        },
      },
    });

    expect(manifest.guardrails.allowedSearchScopes).toEqual(["repo"]);
    expect(manifest.guardrails.broadScanAllowed).toBe(false);
    expect(manifest.inputs.missionSearch.available).toBe(true);
    expect(manifest.inputs.missionSearch.allowedScopes).toEqual(["repo"]);
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

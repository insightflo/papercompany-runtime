import { describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";

describe("evaluateRuntimeBroadScanToolGuard file targets", () => {
  it("blocks rg when it targets an undeclared absolute file", () => {
    const result = evaluateCodexCommand(
      "rg -n 'GAZ-199|signal-analysis' /srv/papercompany/projects/gazua-dashboard/reports/.meta/gazua_artifact_index.json",
    );

    expect(result).toEqual(blockedRg());
  });

  it("allows rg when it targets the exact declared dependency workProduct", () => {
    const result = evaluateCodexCommand(
      "rg -n 'GAZ-199|signal-analysis' reports/.meta/gazua_artifact_index.json",
      {
        paperclipRuntimeSearchPaths: runtimeSearchPaths({
          workingDirectory: "/srv/papercompany/projects/gazua-dashboard",
          dependencyFiles: [
            "/srv/papercompany/projects/gazua-dashboard/reports/.meta/gazua_artifact_index.json",
          ],
        }),
      },
    );

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("blocks a basename-only alias for a declared dependency workProduct", () => {
    const result = evaluateCodexCommand("rg -n TODO gazua_artifact_index.json", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/gazua-dashboard",
        dependencyFiles: [
          "/srv/papercompany/projects/gazua-dashboard/reports/.meta/gazua_artifact_index.json",
        ],
      }),
    });

    expect(result).toEqual(blockedRg());
  });

  it("allows the exact Inflo rg command for a file under the assigned output directory", () => {
    const relativeFile =
      "produced_work/missions/a1a64808/runs/c2d3fa4a/steps/normalize-government-iris/government-iris-candidates.md";
    const result = evaluateCodexCommand(
      `/bin/bash -lc 'test -f ${relativeFile} && wc -l ${relativeFile} && rg -n "PROCEED 후보 없음|VERIFY FIRST|Source content" ${relativeFile}'`,
      {
        paperclipRuntimeSearchPaths: runtimeSearchPaths({
          workingDirectory: "/srv/papercompany/projects/inflo",
          outputDir:
            "/srv/papercompany/projects/inflo/produced_work/missions/a1a64808/runs/c2d3fa4a/steps/normalize-government-iris",
        }),
      },
    );

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("allows an exact sibling file under a declared dependency parent directory", () => {
    const result = evaluateCodexCommand(
      "rg -n 'logo' produced_work/build-html/assets/manifest.json",
      {
        paperclipRuntimeSearchPaths: runtimeSearchPaths({
          workingDirectory: "/srv/papercompany/projects/research-company",
          dependencyFiles: [
            "/srv/papercompany/projects/research-company/produced_work/build-html/index.html",
          ],
          dependencyDirectories: [
            "/srv/papercompany/projects/research-company/produced_work/build-html",
          ],
        }),
      },
    );

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("blocks a shortened suffix of the assigned output directory", () => {
    const result = evaluateCodexCommand("rg -n TODO normalize-government-iris/private.md", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/inflo",
        outputDir:
          "/srv/papercompany/projects/inflo/produced_work/missions/a1a64808/runs/c2d3fa4a/steps/normalize-government-iris",
      }),
    });

    expect(result).toEqual(blockedRg());
  });

  it("blocks relative targets after a working-directory change", () => {
    const relativeFile =
      "produced_work/missions/a1a64808/runs/c2d3fa4a/steps/normalize-government-iris/private.md";
    const result = evaluateCodexCommand(`cd /tmp && rg -n TODO ${relativeFile}`, {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/inflo",
        outputDir:
          "/srv/papercompany/projects/inflo/produced_work/missions/a1a64808/runs/c2d3fa4a/steps/normalize-government-iris",
      }),
    });

    expect(result).toEqual(blockedRg());
  });

  it("blocks shell-variable targets even when assigned to a declared file", () => {
    const result = evaluateCodexCommand(
      "f=/srv/papercompany/projects/inflo/produced_work/allowed.md; rg -n TODO \"$f\"",
      {
        paperclipRuntimeSearchPaths: runtimeSearchPaths({
          workingDirectory: "/srv/papercompany/projects/inflo",
          dependencyFiles: [
            "/srv/papercompany/projects/inflo/produced_work/allowed.md",
          ],
        }),
      },
    );

    expect(result).toEqual(blockedRg());
  });

  it("allows rg -e when its explicit file target is declared", () => {
    const result = evaluateCodexCommand("rg -e TODO reports/allowed.md", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/inflo",
        dependencyFiles: [
          "/srv/papercompany/projects/inflo/reports/allowed.md",
        ],
      }),
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("keeps case-sensitive file paths distinct", () => {
    const context = {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/inflo",
        dependencyFiles: [
          "/srv/papercompany/projects/inflo/reports/Allowed.md",
        ],
      }),
    };

    expect(evaluateCodexCommand("rg -n TODO reports/Allowed.md", context)).toEqual({
      blocked: false,
      matchedCommand: null,
      reason: null,
    });
    expect(evaluateCodexCommand("rg -n TODO reports/allowed.md", context)).toEqual(blockedRg());
  });

  it("blocks parent traversal out of the assigned output directory", () => {
    const result = evaluateCodexCommand(
      "rg -n TODO /srv/papercompany/projects/inflo/produced_work/current/../secret.md",
      {
        paperclipRuntimeSearchPaths: runtimeSearchPaths({
          workingDirectory: "/srv/papercompany/projects/inflo",
          outputDir: "/srv/papercompany/projects/inflo/produced_work/current",
        }),
      },
    );

    expect(result).toEqual(blockedRg());
  });

  it("blocks rg when a shell variable resolves to the current directory", () => {
    const result = evaluateCodexCommand(`/bin/bash -lc 'target=.
rg -n TODO "$target"'`);

    expect(result).toEqual(blockedRg());
  });

  it("blocks rg when a shell variable resolves to a directory-like target", () => {
    const result = evaluateCodexCommand(`/bin/bash -lc 'target=/srv/papercompany/projects/gazua-dashboard/reports
rg -n TODO "$target"'`);

    expect(result).toEqual(blockedRg());
  });

  it("blocks rg when a target looks like a file but ends as a directory", () => {
    const result = evaluateCodexCommand("rg -n TODO /srv/papercompany/projects/gazua-dashboard/reports/file.json/");

    expect(result).toEqual(blockedRg());
  });

  it("still blocks rg without an explicit target path", () => {
    const result = evaluateCodexCommand("rg -n TODO");

    expect(result).toEqual(blockedRg());
  });

  it("keeps workflow search path restrictions when the project workspace otherwise allows broad scans", () => {
    const result = evaluateCodexCommand("rg -n TODO .", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({
        workingDirectory: "/srv/papercompany/projects/inflo",
      }),
    }, true);

    expect(result).toEqual(blockedRg());
  });
});

function evaluateCodexCommand(
  command: string,
  context: Record<string, unknown> = {},
  broadScanAllowed = false,
) {
  return evaluateRuntimeBroadScanToolGuard({
    adapterType: "codex_local",
    line: JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command,
        status: "in_progress",
      },
    }),
    ts: new Date().toISOString(),
    context: {
      ...context,
      paperclipStepInputManifest: {
        version: 1,
        guardrails: { broadScanAllowed },
      },
    },
  });
}

function runtimeSearchPaths(input: {
  workingDirectory: string;
  outputDir?: string;
  dependencyFiles?: string[];
  dependencyDirectories?: string[];
}) {
  return {
    version: 1,
    workingDirectory: input.workingDirectory,
    outputDirectory: input.outputDir ?? null,
    dependencyFiles: input.dependencyFiles ?? [],
    dependencyDirectories: input.dependencyDirectories ?? [],
  };
}

function blockedRg() {
  return {
    blocked: true,
    matchedCommand: "rg without an allowed file path",
    reason: 'Step Input Manifest blocked runtime broad scan command: "rg without an allowed file path". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
  };
}

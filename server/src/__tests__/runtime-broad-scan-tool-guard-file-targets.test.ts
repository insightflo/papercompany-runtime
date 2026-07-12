import { describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";
import { findRuntimeBroadScanCommand } from "../services/runtime-broad-scan-command-policy.js";

// Simple explicit-file policy (fix/broad-scan-explicit-file-policy), applies to
// rg and find ONLY (tree / ls -R / git ls-files keep their previous policy):
// blocked ONLY when there is no explicit target (implicit cwd), the target is a
// root-like token (. ./ .. ../ /), or the resolved target is EXACTLY the working
// directory / repo root. Every other explicit target — declared or not, file or
// sub-directory, relative or sub-absolute — is allowed. No allowlist / extension
// / directory / parent-traversal / prefix-contains judgment. repo scope allows all.

describe("evaluateRuntimeBroadScanToolGuard explicit-file policy", () => {
  const WORKDIR = "/srv/papercompany/projects/research-company";

  it("allows rg when escaped quotes merge the pattern and an absolute target into one token (RES-1346 item_8)", () => {
    // shellTokenize has no backslash-escape handling, so \"TODO\"<abs>/index.html
    // becomes a single positional argument embedding the absolute path. The
    // policy must still recognize the embedded explicit file and allow it.
    const result = evaluateCodexCommand(`rg -n \\"TODO\\"${WORKDIR}/index.html`, {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result.blocked).toBe(false);
  });

  it("allows rg on an undeclared absolute file (no allowlist judgment)", () => {
    const result = evaluateCodexCommand(
      `rg -n "GAZ-199" ${WORKDIR}/produced_work/report.md`,
      { paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }) },
    );
    expect(result.blocked).toBe(false);
  });

  it("allows rg on an undeclared relative file", () => {
    const result = evaluateCodexCommand("rg -n TODO src/server.ts", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result.blocked).toBe(false);
  });

  it("allows rg on a general sub-directory target", () => {
    const result = evaluateCodexCommand("rg -n TODO src", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result.blocked).toBe(false);
  });

  it("allows rg on a sub-absolute path under the working directory", () => {
    const result = evaluateCodexCommand(
      `rg -n TODO ${WORKDIR}/produced_work`,
      { paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }) },
    );
    expect(result.blocked).toBe(false);
  });

  it("blocks pathless rg (implicit current folder)", () => {
    const result = evaluateCodexCommand("rg -n TODO", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result).toEqual(blockedRg());
  });

  it("blocks pathless rg whose regex pattern contains slash text (not mistaken for an absolute target)", () => {
    const result = evaluateCodexCommand("rg -n /api/v1", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result).toEqual(blockedRg());
  });

  it("treats rg pattern-file (-f/--file) as pattern-supplied: explicit target allowed, no target blocked", () => {
    // -f / --file consume the patterns file as the option value, so a later
    // positional is an explicit search target (allowed). With no positional the
    // command is pathless and must be blocked.
    const ctx = { paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }) };
    expect(evaluateCodexCommand("rg -f patterns.txt src", ctx).blocked).toBe(false);
    expect(evaluateCodexCommand("rg --file patterns.txt src", ctx).blocked).toBe(false);
    expect(evaluateCodexCommand("rg --file=patterns.txt src", ctx).blocked).toBe(false);
    expect(evaluateCodexCommand("rg -f patterns.txt", ctx)).toEqual(blockedRg());
    expect(evaluateCodexCommand("rg --file patterns.txt", ctx)).toEqual(blockedRg());
  });

  it("blocks rg targeting the current directory (.)", () => {
    const result = evaluateCodexCommand("rg -n TODO .", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result).toEqual(blockedRg());
  });

  it("blocks rg targeting the working directory exactly", () => {
    const result = evaluateCodexCommand(
      `rg -n TODO ${WORKDIR}`,
      { paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }) },
    );
    expect(result).toEqual(blockedRg());
  });

  it("blocks when an absolute target equals the path.resolve-normalized working directory (trailing slash)", () => {
    // Roots must be normalized the same way as the target: a trailing slash on the
    // working directory must still match the bare target.
    const matched = findRuntimeBroadScanCommand({
      command: `rg -n TODO ${WORKDIR}`,
      allowedPaths: [],
      allowedDirectories: [],
      workingDirectory: `${WORKDIR}/`,
      repoSearchRoot: null,
      shellVariables: new Map(),
    });
    expect(matched).not.toBeNull();
  });

  it("blocks when an absolute target equals the path.resolve-normalized repoSearchRoot (.. in root)", () => {
    // repoSearchRoot is normalized (.. collapsed); a non-matching workingDirectory isolates
    // the repoRoot comparison so the block fires on the normalized root match alone.
    const matched = findRuntimeBroadScanCommand({
      command: "rg -n TODO /srv/papercompany/projects/repo",
      allowedPaths: [],
      allowedDirectories: [],
      workingDirectory: "/srv/papercompany/projects/elsewhere",
      repoSearchRoot: "/srv/papercompany/projects/repo/dir/..",
      shellVariables: new Map(),
    });
    expect(matched).not.toBeNull();
  });

  it("blocks rg targeting the filesystem root (/)", () => {
    const result = evaluateCodexCommand("rg -n TODO /", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result).toEqual(blockedRg());
  });

  it("blocks find with no target and find .", () => {
    const a = evaluateCodexCommand("find -type f", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    const b = evaluateCodexCommand("find . -type f", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(a.blocked).toBe(true);
    expect(b.blocked).toBe(true);
  });

  it("allows find on an explicit sub-directory", () => {
    const result = evaluateCodexCommand("find src -type f", {
      paperclipRuntimeSearchPaths: runtimeSearchPaths({ workingDirectory: WORKDIR }),
    });
    expect(result.blocked).toBe(false);
  });

  it("allows broad scans when repo scope is active", () => {
    const result = evaluateCodexCommand("rg -n TODO", {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory: WORKDIR,
        outputDirectory: null,
        dependencyFiles: [],
        dependencyDirectories: [],
        allowedSearchScopes: ["repo"],
      },
    }, true);
    expect(result.blocked).toBe(false);
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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanHook } from "../services/runtime-broad-scan-hook.js";

/**
 * Focused regression for the runtime broad-scan hook. Reproduces the failed run
 * c6a4b66c (ls -R on an undeclared "steps" parent) and asserts the hook injects a
 * synthetic in-scope output instead of throwing, for every blocked command label
 * and the hermes_local text-extraction gap.
 */

const db = {} as never;

function codexLine(command: string): string {
  return JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command, status: "in_progress" },
  });
}

function hermesLine(command: string): string {
  return `┊ 💻 $ ${command}`;
}

function buildContext(workingDirectory: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paperclipStepInputManifest: {
      version: 1,
      taskKey: null,
      issueId: null,
      projectId: null,
      allowedContextKeys: [],
      guardrails: { broadScanAllowed: false },
      inputs: {
        workspace: { available: true, source: "agent_home", workspaceId: null, projectId: null },
        workspaceHints: { available: false, count: 0 },
        runtimeServiceIntents: { available: false, count: 0 },
        runtimeServices: { available: false, count: 0, primaryUrl: null },
        fileViews: { available: false, count: 0, source: null },
        sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
      },
    },
    paperclipRuntimeSearchPaths: {
      version: 1,
      workingDirectory,
      outputDirectory: "draft-tech-scout-outline",
      dependencyFiles: ["collect-tech-scout-evidence/evidence.json"],
      dependencyDirectories: ["collect-tech-scout-evidence"],
      allowedSearchScopes: ["workProduct", "missionOutput"],
      broadScanRepoAllowed: false,
    },
    paperclipWorkspace: { source: "project_primary", workspaceId: "ws-1", cwd: workingDirectory },
    ...overrides,
  };
}

describe("evaluateRuntimeBroadScanHook", () => {
  let workingDirectory: string;

  beforeAll(() => {
    workingDirectory = mkdtempSync(path.join(tmpdir(), "bs-hook-"));
    // collect-tech-scout-evidence/: two files
    const evidenceDir = path.join(workingDirectory, "collect-tech-scout-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, "evidence.json"), "{}");
    writeFileSync(path.join(evidenceDir, "raw-tech-scout.json"), "{}");
    // draft-tech-scout-outline/: output dir (empty for now)
    mkdirSync(path.join(workingDirectory, "draft-tech-scout-outline"), { recursive: true });
    // steps/: the UNDECLARED parent the agent scanned in run c6a4b66c
    mkdirSync(path.join(workingDirectory, "steps"), { recursive: true });
    writeFileSync(path.join(workingDirectory, "steps", "leak.txt"), "should not appear");
  });

  afterAll(() => {
    rmSync(workingDirectory, { recursive: true, force: true });
  });

  it("intercepts `ls -R` on an undeclared parent and lists only declared in-scope paths (c6a4b66c)", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine('ls -R "steps"'),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("ls -R");
    expect(result.syntheticOutput).toBeTruthy();
    // Declared directory + its files appear.
    expect(result.syntheticOutput).toContain("collect-tech-scout-evidence");
    expect(result.syntheticOutput).toContain("evidence.json");
    expect(result.syntheticOutput).toContain("raw-tech-scout.json");
    // The undeclared scanned parent is NOT surfaced.
    expect(result.syntheticOutput).not.toContain("leak.txt");
  });

  it("intercepts `find .` and returns a flat in-scope file list", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("find . -type f"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("find .");
    expect(result.syntheticOutput).toContain("evidence.json");
    expect(result.syntheticOutput).not.toContain("leak.txt");
  });

  it("intercepts `git ls-files` and returns a flat in-scope file list", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("git ls-files"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("git ls-files");
    expect(result.syntheticOutput).toContain("evidence.json");
  });

  it("intercepts `rg <pattern> .` and returns missionSearch workProduct results", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("rg evidence ."),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("rg with a root target");
    expect(result.syntheticOutput).toContain("evidence.json");
    expect(result.syntheticOutput).toContain("missionSearch");
  });

  it("intercepts `grep -R <pattern> .` and returns missionSearch results", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine('grep -R "raw-tech" .'),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("grep -R without path");
    expect(result.syntheticOutput).toContain("missionSearch");
  });

  it("extracts a hermes_local text line (`┊ 💻 $ <cmd>`) and intercepts it", async () => {
    // The prior gap: hermes_local had no extractor branch, so broad scans slipped past.
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "hermes_local",
      line: hermesLine("ls -R steps"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.rewrittenCommand).toBe("ls -R");
    expect(result.syntheticOutput).toContain("evidence.json");
  });

  it("passes through an explicit non-root rg target (not intercepted)", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("rg TODO collect-tech-scout-evidence/evidence.json"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(false);
  });

  it("passes through when no shell command is present", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: JSON.stringify({ type: "item.started", item: { type: "message", content: "thinking..." } }),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(false);
  });

  it("passes through when broadScanAllowed is true and nothing is declared", async () => {
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("ls -R"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory, {
        paperclipStepInputManifest: {
          version: 1,
          guardrails: { broadScanAllowed: true },
        },
        paperclipRuntimeSearchPaths: { notDeclared: true },
      }),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(false);
  });

  it("passes through repo-allowed scans when broadScanRepoAllowed is true", async () => {
    const repoContext = buildContext(workingDirectory, {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory,
        outputDirectory: "draft-tech-scout-outline",
        dependencyFiles: ["collect-tech-scout-evidence/evidence.json"],
        dependencyDirectories: ["collect-tech-scout-evidence"],
        allowedSearchScopes: ["workProduct", "missionOutput", "repo"],
        broadScanRepoAllowed: true,
      },
    });
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("git ls-files"),
      ts: new Date().toISOString(),
      context: repoContext,
      runId: "run-1",
    });

    expect(result.intercepted).toBe(false);
  });

  it("rejects parent traversal in a synthesized listing target", async () => {
    // An ls -R whose target escapes via ".." must still be intercepted, and the
    // synthetic output must never surface paths outside the declared scope.
    const result = await evaluateRuntimeBroadScanHook(db, {
      adapterType: "codex_local",
      line: codexLine("ls -R ../etc"),
      ts: new Date().toISOString(),
      context: buildContext(workingDirectory),
      runId: "run-1",
    });

    expect(result.intercepted).toBe(true);
    expect(result.syntheticOutput).not.toContain("..");
  });
});

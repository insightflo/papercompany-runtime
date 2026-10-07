import { describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanHook } from "../services/runtime-broad-scan-hook.js";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";
import { evaluateStepInputManifestGuard } from "../services/step-input-manifest-guard.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { readBroadSearchOverride } from "../services/runtime-search-scopes.js";

const paths = {
  version: 1, workingDirectory: "/repo", outputDirectory: null,
  dependencyFiles: [], dependencyDirectories: [],
  allowedSearchScopes: ["workProduct", "missionOutput", "repo", "logs", "config"],
  broadScanRepoAllowed: true, broadSearchOverride: "experimental_allow",
};
function context(overrides = {}) {
  const permissions = { ...paths, ...overrides };
  return {
    paperclipRuntimeSearchPaths: permissions,
    paperclipStepInputManifest: buildStepInputManifest({ taskKey: null, context: {
      paperclipRuntimeSearchPaths: permissions,
      paperclipWorkspace: { source: "project_primary", cwd: "/repo" },
    } }),
  };
}
function input(command: string, overrides = {}) {
  return {
    adapterType: "codex_local", ts: "2026-10-08T00:00:00Z", runId: "run-test",
    line: JSON.stringify({ type: "item.started", item: { type: "command_execution", command, status: "in_progress" } }),
    context: context(overrides),
  };
}

describe("experimental broad search FULL release", () => {
  it("allows broad-scan preflight while leaving default-deny preflight blocked", async () => {
    const options = {
      adapterConfig: { promptTemplate: "Scan the entire repo." },
      agent: { id: "agent-test", companyId: "company-test" }, runId: "run-test",
      hasResumableSession: false, cwd: "/repo",
    };
    expect((await evaluateStepInputManifestGuard({ ...options, context: context() })).blocked).toBe(false);
    expect((await evaluateStepInputManifestGuard({ ...options, context: context({ broadScanRepoAllowed: false }) })).blocked).toBe(true);
  });
  it.each(["rg -n TODO .", "find . -type f", "grep -R TODO /repo", "git ls-files", "tree", "ls -R", "cd /repo && find ."])(
    "passes through %s in both runtime consumers", async (command) => {
      expect(evaluateRuntimeBroadScanToolGuard(input(command))).toMatchObject({ blocked: false });
      expect(await evaluateRuntimeBroadScanHook({} as never, input(command))).toEqual({ intercepted: false });
    },
  );

  it.each([
    { broadSearchOverride: null }, { broadSearchOverride: "invalid" },
    { broadScanRepoAllowed: false },
  ])("retains root-target blocking without valid declared experimental permission %j", async (overrides) => {
    expect(evaluateRuntimeBroadScanToolGuard(input("find .", overrides)).blocked).toBe(true);
    expect((await evaluateRuntimeBroadScanHook({} as never, input("find .", overrides))).intercepted).toBe(true);
  });
});

describe("readBroadSearchOverride (shared by route, hook and tool guard)", () => {
  it("honors the marker only for a version-1 snapshot with repo broad scan allowed", () => {
    expect(readBroadSearchOverride(1, "experimental_allow", true)).toBe("experimental_allow");
    expect(readBroadSearchOverride(2, "experimental_allow", true)).toBeNull();
    expect(readBroadSearchOverride(undefined, "experimental_allow", true)).toBeNull();
    expect(readBroadSearchOverride(1, "experimental_allow", false)).toBeNull();
    expect(readBroadSearchOverride(1, "allow", true)).toBeNull();
  });
});

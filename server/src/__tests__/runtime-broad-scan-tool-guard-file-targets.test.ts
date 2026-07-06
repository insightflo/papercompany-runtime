import { describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";

describe("evaluateRuntimeBroadScanToolGuard file targets", () => {
  it("allows rg when it targets one explicit absolute file", () => {
    const result = evaluateCodexCommand(
      "rg -n 'GAZ-199|signal-analysis' /srv/papercompany/projects/gazua-dashboard/reports/.meta/gazua_artifact_index.json",
    );

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("allows rg when a shell variable resolves to one explicit file", () => {
    const result = evaluateCodexCommand(`/bin/bash -lc 'set -e
f=/srv/papercompany/projects/gazua-dashboard/reports/.meta/gazua_artifact_index.json
if [ -f "$f" ]; then
  rg -n 'GAZ-199|signal-analysis|Signal_Analysis|signal analysis' "$f" || true
else
  echo "missing"
fi'`);

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
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
});

function evaluateCodexCommand(command: string) {
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
      paperclipStepInputManifest: {
        version: 1,
        guardrails: { broadScanAllowed: false },
      },
    },
  });
}

function blockedRg() {
  return {
    blocked: true,
    matchedCommand: "rg without path",
    reason: 'Step Input Manifest blocked runtime broad scan command: "rg without path"',
  };
}

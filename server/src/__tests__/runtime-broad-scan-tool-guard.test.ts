import { describe, expect, it } from "vitest";
import { evaluateRuntimeBroadScanToolGuard } from "../services/runtime-broad-scan-tool-guard.js";

describe("evaluateRuntimeBroadScanToolGuard", () => {
  it("blocks a repo-wide discovery command in a codex tool_call event", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "find . -type f",
        status: "in_progress",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "find .",
      reason: 'Step Input Manifest blocked runtime broad scan command: "find .". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("allows an explicit file-view path in a shell tool call", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shellToolCall: {
          command: "rg TODO src/server.ts",
        },
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "cursor",
      line,
      ts: new Date().toISOString(),
      context: {
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
            fileViews: { available: true, count: 1, source: "wake_comment" },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
        paperclipFileViews: [
          { workspaceId: null, relativePath: "src/server.ts", source: "wake_comment", exists: true },
        ],
        paperclipWorkspace: { cwd: "/workspace" },
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("blocks mixed commands when repo-wide scanning is combined with an allowed file-view path", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shellToolCall: {
          command: "rg TODO src/server.ts .",
        },
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "cursor",
      line,
      ts: new Date().toISOString(),
      context: {
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
            fileViews: { available: true, count: 1, source: "wake_comment" },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
        paperclipFileViews: [
          { workspaceId: null, relativePath: "src/server.ts", source: "wake_comment", exists: true },
        ],
        paperclipWorkspace: { cwd: "/workspace" },
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "rg without an allowed file path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "rg without an allowed file path". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("allows rg with explicit target paths even when undeclared (simple explicit-file policy)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shellToolCall: {
          command: "rg TODO src/server.ts src/other.ts",
        },
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "cursor",
      line,
      ts: new Date().toISOString(),
      context: {
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
            fileViews: { available: true, count: 1, source: "wake_comment" },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
        paperclipFileViews: [
          { workspaceId: null, relativePath: "src/server.ts", source: "wake_comment", exists: true },
        ],
        paperclipWorkspace: { cwd: "/workspace" },
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("allows rg as a stdin filter after a pipe", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "/bin/bash -lc \"env | sort | rg '^(PAPERCLIP_|PWD=|HOME=)'\"",
        status: "in_progress",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("allows rg stdin filters whose search pattern contains slashes", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "curl -sS http://127.0.0.1/openapi.json | jq -r '.paths | keys[]' | rg '^/issues|^/api/issues|work-products|comments|heartbeat-context'",
        status: "in_progress",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("still blocks rg after a pipe when it targets the repo", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "printf TODO | rg TODO .",
        status: "in_progress",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "rg without an allowed file path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "rg without an allowed file path". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("allows an explicit tree target then rg on an explicit file (no repo-wide target)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: {
        shellToolCall: {
          command: "tree src/server.ts && rg TODO src/other.ts",
        },
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "cursor",
      line,
      ts: new Date().toISOString(),
      context: {
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
            fileViews: { available: true, count: 1, source: "wake_comment" },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
        paperclipFileViews: [
          { workspaceId: null, relativePath: "src/server.ts", source: "wake_comment", exists: true },
        ],
        paperclipWorkspace: { cwd: "/workspace" },
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("blocks opencode bash tool_use events for git ls-files", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "bash",
        state: {
          input: {
            command: "git ls-files",
          },
        },
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "opencode_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "git ls-files",
      reason: 'Step Input Manifest blocked runtime broad scan command: "git ls-files". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("keeps grep -R blocked even with a patterns file and a declared target (only rg/find relax)", () => {
    // grep -R policy is unchanged by the rg/find simplification. -f/--file must not
    // turn a declared file into an allowed target for grep (the bug did this because
    // extractSearchTargetPaths is shared). Only rg treats a patterns file as pattern-supplied.
    const line = JSON.stringify({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "grep -R -f patterns.txt src/server.ts",
        status: "in_progress",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
        paperclipStepInputManifest: {
          version: 1,
          guardrails: { broadScanAllowed: false },
        },
        paperclipRuntimeSearchPaths: {
          version: 1,
          workingDirectory: "/workspace",
          outputDirectory: null,
          dependencyFiles: ["/workspace/src/server.ts"],
          dependencyDirectories: [],
        },
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "grep -R without path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "grep -R without path". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("does not treat prose comments containing the word find as a find command", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_8",
        type: "command_execution",
        command: `/bin/bash -lc '# Try various API paths to find the correct one
for path in "api" "api/v1" "api/v2" "v1"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$PAPERCLIP_API_URL/$path/companies/company-1/issues/issue-1")
  echo "$path -> $status"
done'`,
        aggregated_output: "api -> 404\nv1 -> 200\n",
        exit_code: 0,
        status: "completed",
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "codex_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });

  it("blocks claude tool_use bash commands for repo-wide discovery", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "bash",
            id: "tool-1",
            input: { command: "find $(pwd) -type f" },
          },
        ],
      },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "claude_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "find .",
      reason: 'Step Input Manifest blocked runtime broad scan command: "find .". Use missionSearch/scoped search and retry with declared file paths or an allowed repo scope.',
    });
  });

  it("allows find on an explicit sub-directory in pi tool execution", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "find src -type f" },
    });

    const result = evaluateRuntimeBroadScanToolGuard({
      adapterType: "pi_local",
      line,
      ts: new Date().toISOString(),
      context: {
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
      },
    });

    expect(result).toEqual({ blocked: false, matchedCommand: null, reason: null });
  });
});

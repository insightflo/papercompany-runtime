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
      reason: 'Step Input Manifest blocked runtime broad scan command: "find ."',
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "rg without path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "rg without path"',
    });
  });

  it("blocks broad discovery commands when any explicit target path is undeclared", () => {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "rg without path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "rg without path"',
    });
  });

  it("blocks mixed shell segments when a later segment performs a repo-wide scan", () => {
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
      },
    });

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "rg without path",
      reason: 'Step Input Manifest blocked runtime broad scan command: "rg without path"',
    });
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
      reason: 'Step Input Manifest blocked runtime broad scan command: "git ls-files"',
    });
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
      reason: 'Step Input Manifest blocked runtime broad scan command: "find ."',
    });
  });

  it("blocks pi tool execution start bash commands for repo-wide discovery", () => {
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

    expect(result).toEqual({
      blocked: true,
      matchedCommand: "find .",
      reason: 'Step Input Manifest blocked runtime broad scan command: "find ."',
    });
  });
});

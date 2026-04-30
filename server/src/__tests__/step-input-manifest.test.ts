import { describe, expect, it } from "vitest";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { evaluateStepInputManifestGuard } from "../services/step-input-manifest-guard.js";

describe("buildStepInputManifest", () => {
  it("computes a server-owned manifest from the current runtime context", () => {
    const manifest = buildStepInputManifest({
      taskKey: "issue:123",
      context: {
        issueId: "issue-1",
        projectId: "project-1",
        paperclipWorkspace: {
          source: "project_primary",
          workspaceId: "ws-1",
          projectId: "project-1",
        },
        paperclipWorkspaces: [{ id: "hint-1" }],
        paperclipRuntimeServiceIntents: [{ name: "api" }],
        paperclipRuntimeServices: [{ id: "svc-1", url: "http://localhost:4000" }],
        paperclipRuntimePrimaryUrl: "http://localhost:4000",
        paperclipWorkflowStepKnowledgeContext: {
          entries: [{ id: "kb-1", name: "Mission KB" }],
        },
        paperclipFileViews: [{ workspaceId: "ws-1", relativePath: "src/server.ts", source: "wake_comment", exists: true }],
        paperclipSessionHandoffMarkdown: "# handoff",
        paperclipSessionRotationReason: "budget",
        paperclipPreviousSessionId: "sess-1",
        note: "hello",
      },
    });

    expect(manifest).toEqual({
      version: 1,
      taskKey: "issue:123",
      issueId: "issue-1",
      projectId: "project-1",
      allowedContextKeys: [
        "issueId",
        "note",
        "paperclipFileViews",
        "paperclipPreviousSessionId",
        "paperclipRuntimePrimaryUrl",
        "paperclipRuntimeServiceIntents",
        "paperclipRuntimeServices",
        "paperclipSessionHandoffMarkdown",
        "paperclipSessionRotationReason",
        "paperclipWorkflowStepKnowledgeContext",
        "paperclipWorkspace",
        "paperclipWorkspaces",
        "projectId",
      ],
      guardrails: {
        broadScanAllowed: true,
      },
      inputs: {
        workspace: {
          available: true,
          source: "project_primary",
          workspaceId: "ws-1",
          projectId: "project-1",
        },
        workspaceHints: {
          available: true,
          count: 1,
        },
        runtimeServiceIntents: {
          available: true,
          count: 1,
        },
        runtimeServices: {
          available: true,
          count: 1,
          primaryUrl: "http://localhost:4000",
        },
        tools: {
          available: false,
          count: 0,
          names: [],
        },
        knowledge: {
          available: true,
          count: 1,
          names: ["Mission KB"],
        },
        fileViews: {
          available: true,
          count: 1,
          source: "wake_comment",
        },
        sessionHandoff: {
          available: true,
          previousSessionId: "sess-1",
          rotationReason: "budget",
        },
      },
    });
  });

  it("blocks explicit broad-scan instructions when the manifest forbids them", async () => {
    const result = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent One",
      },
      runId: "run-1",
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });

    expect(result).toEqual({
      blocked: true,
      matchedPhrase: "scan the entire repo",
      reason: 'Step Input Manifest blocked broad scan instruction: "scan the entire repo"',
    });
  });

  it("does not block when the manifest is absent or broad scans are allowed", async () => {
    const withoutManifest = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {},
      hasResumableSession: false,
      cwd: process.cwd(),
    });
    const allowedManifest = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Please scan the entire repo and summarize everything.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: null,
          issueId: null,
          projectId: null,
          allowedContextKeys: [],
          guardrails: { broadScanAllowed: true },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });

    expect(withoutManifest.blocked).toBe(false);
    expect(allowedManifest.blocked).toBe(false);
  });

  it("does not block negated broad-scan warnings or historical handoff text", async () => {
    const negated = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Do not scan the entire repo. Use the provided issue context only.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });
    const historical = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipSessionHandoffMarkdown:
          "Previous run failed because it tried to scan the entire repo before reading the issue context.",
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId", "paperclipSessionHandoffMarkdown"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: true, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });

    expect(negated.blocked).toBe(false);
    expect(historical.blocked).toBe(false);
  });

  it("does not treat structured handoff history text as a new broad-scan instruction", async () => {
    const result = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Stay focused on the assigned issue.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipSessionHandoff: {
          version: 1,
          previousSessionId: "sess-1",
          previousRunId: "run-1",
          issueId: "issue-1",
          rotationReason: "budget",
          lastRunSummaryText: "Previous run failed because it tried to scan the entire repo before reading the issue context.",
        },
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId", "paperclipSessionHandoff"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: true, previousSessionId: "sess-1", rotationReason: "budget" },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });

    expect(result.blocked).toBe(false);
  });

  it("blocks clear broad-scan wording variants beyond the original phrase list", async () => {
    const inspectVariant = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Inspect the whole repository before making any changes.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });
    const searchVariant = await evaluateStepInputManifestGuard({
      adapterConfig: {
        promptTemplate: "Search across the entire workspace for every relevant file first.",
      },
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runId: "run-1",
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue-1",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            tools: { available: false, count: 0, names: [] },
            knowledge: { available: false, count: 0, names: [] },
            sessionHandoff: { available: false, previousSessionId: null, rotationReason: null },
          },
        },
      },
      hasResumableSession: false,
      cwd: process.cwd(),
    });

    expect(inspectVariant).toEqual({
      blocked: true,
      matchedPhrase: "inspect the whole repository",
      reason: 'Step Input Manifest blocked broad scan instruction: "inspect the whole repository"',
    });
    expect(searchVariant).toEqual({
      blocked: true,
      matchedPhrase: "search across the entire workspace",
      reason: 'Step Input Manifest blocked broad scan instruction: "search across the entire workspace"',
    });
  });
});

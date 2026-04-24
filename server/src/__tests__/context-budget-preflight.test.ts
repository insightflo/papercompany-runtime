import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateContextBudgetPreflight,
  parseContextBudgetPreflightPolicy,
} from "../services/context-budget-preflight.js";

const baseInput = {
  adapterType: "codex_local",
  agent: {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent One",
    role: "engineer",
  },
  runId: "run-1",
  cwd: process.cwd(),
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseContextBudgetPreflightPolicy", () => {
  it("returns null when no budget preflight is configured", () => {
    expect(parseContextBudgetPreflightPolicy({})).toBeNull();
  });
});

describe("evaluateContextBudgetPreflight", () => {
  it("blocks when the estimated token budget is exceeded", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 10,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "x".repeat(80),
      },
      context: {
        issueId: "issue-1",
        summary: "y".repeat(80),
      },
      hasResumableSession: false,
      ...baseInput,
    });

    expect(result).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("exceeds budget"),
      estimate: {
        promptTemplateChars: 80,
        bootstrapPromptChars: 0,
        renderedPromptChars: 80,
      },
    });
    expect(result.estimate.estimatedTokens).toBeGreaterThan(10);
  });

  it("uses the default heartbeat prompt when promptTemplate is omitted", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 1000,
          },
        },
      },
      adapterConfig: {},
      context: {},
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.estimate.promptTemplateChars).toBeGreaterThan(100);
    expect(result.estimate.renderedPromptChars).toBeGreaterThan(100);
  });

  it("counts repeated template interpolation from rendered output", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 20,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "{{ context.note }}{{ context.note }}",
      },
      context: {
        note: "abcd".repeat(20),
      },
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.estimate.promptTemplateChars).toBeLessThan(result.estimate.renderedPromptChars);
    expect(result.estimate.renderedPromptChars).toBe(160);
    expect(result.blocked).toBe(true);
  });

  it("passes when the estimate stays under budget and includes readable instructions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-context-budget-"));
    tempDirs.push(dir);
    const instructionsPath = path.join(dir, "AGENTS.md");
    await fs.writeFile(instructionsPath, "Be concise.\n", "utf8");

    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 200,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "Follow the paperclip heartbeat.",
        bootstrapPromptTemplate: "Bootstrap once.",
        instructionsFilePath: instructionsPath,
      },
      context: {
        issueId: "issue-1",
      },
      hasResumableSession: false,
      ...baseInput,
      cwd: dir,
    });

    expect(result).toMatchObject({
      blocked: false,
      reason: null,
    });
    expect(result.estimate.instructionsChars).toBeGreaterThan(0);
    expect(result.estimate.bootstrapPromptChars).toBeGreaterThan(0);
    expect(result.estimate.renderedBootstrapPromptChars).toBeGreaterThan(0);
  });

  it("counts the shared runtime brief even when only the structured handoff artifact is present", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "Follow the paperclip heartbeat.",
      },
      context: {
        paperclipStepInputManifest: {
          version: 1,
          taskKey: "issue:123",
          issueId: "issue-1",
          projectId: null,
          allowedContextKeys: ["issueId"],
          guardrails: { broadScanAllowed: false },
          inputs: {
            workspace: { available: true, source: "project_primary", workspaceId: null, projectId: null },
            workspaceHints: { available: false, count: 0 },
            runtimeServiceIntents: { available: false, count: 0 },
            runtimeServices: { available: false, count: 0, primaryUrl: null },
            sessionHandoff: { available: true, previousSessionId: "sess-1", rotationReason: "budget" },
          },
        },
        paperclipSessionHandoff: {
          version: 1,
          previousSessionId: "sess-1",
          previousRunId: "run-1",
          issueId: "issue-1",
          rotationReason: "budget",
          lastRunSummaryText: "Last run summarized the issue state",
        },
      },
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.blocked).toBe(false);
    expect(result.estimate.sessionHandoffChars).toBeGreaterThan(0);
  });

  it("omits bootstrap prompt cost when the session is being resumed", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 200,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "Heartbeat prompt",
        bootstrapPromptTemplate: "Only on first run",
      },
      context: {},
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.blocked).toBe(false);
    expect(result.estimate.bootstrapPromptChars).toBe(0);
    expect(result.estimate.renderedBootstrapPromptChars).toBe(0);
  });

  it("blocks when the estimated char budget is exceeded", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedChars: 20,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "01234567890123456789012345",
      },
      context: {},
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("chars exceeds budget");
  });

  it("counts agent and run placeholders from real template data", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 200,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "{{agent.role}} {{runId}}",
      },
      context: {},
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result.estimate.renderedPromptChars).toBe("engineer run-1".length);
    expect(result.estimate.sessionHandoffChars).toBeGreaterThan(0);
    expect(result.blocked).toBe(false);
  });

  it("counts bootstrap when a saved session exists but is not resumable", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 200,
          },
        },
      },
      adapterConfig: {
        promptTemplate: "Heartbeat prompt",
        bootstrapPromptTemplate: "Only on first run",
      },
      context: {},
      hasResumableSession: false,
      ...baseInput,
    });

    expect(result.estimate.bootstrapPromptChars).toBeGreaterThan(0);
    expect(result.estimate.renderedBootstrapPromptChars).toBeGreaterThan(0);
  });

  it("does not add adapter-specific runtime note material for gemini", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      ...baseInput,
      adapterType: "gemini_local",
      adapterConfig: {
        promptTemplate: "Short prompt",
      },
      context: {},
      hasResumableSession: true,
      authTokenPresent: true,
    });

    expect(result.estimate.runtimeNoteChars).toBe(0);
  });

  it("does not budget separate runtime note material for gemini", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      ...baseInput,
      adapterType: "gemini_local",
      adapterConfig: {
        promptTemplate: "Short prompt",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/work",
          source: "project_primary",
          workspaceId: "ws-1",
          repoUrl: "https://example.com/repo.git",
          repoRef: "main",
          strategy: "worktree",
          branchName: "feature/test",
          worktreePath: "/tmp/wt",
        },
        paperclipRuntimePrimaryUrl: "http://localhost:4000",
        paperclipRuntimeServices: [{ name: "api" }],
        paperclipRuntimeServiceIntents: [{ name: "api" }],
      },
      hasResumableSession: true,
      authTokenPresent: true,
    });

    expect(result.estimate.runtimeNoteChars).toBe(0);
  });

  it("counts cursor runtime note material using the real adapter type", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      ...baseInput,
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Short prompt",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/work",
          source: "project_primary",
          workspaceId: "ws-1",
          repoUrl: "https://example.com/repo.git",
          repoRef: "main",
        },
      },
      hasResumableSession: true,
      authTokenPresent: true,
    });

    expect(result.estimate.runtimeNoteChars).toBeGreaterThan(0);
    expect(result.estimate.estimatedChars).toBeGreaterThan(result.estimate.renderedPromptChars);
  });

  it("counts custom PAPERCLIP env keys from merged adapter config", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      ...baseInput,
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Short prompt",
        env: {
          PAPERCLIP_CUSTOM_TOKEN: "custom-value",
        },
      },
      context: {},
      hasResumableSession: true,
      authTokenPresent: false,
    });

    expect(result.estimate.runtimeNoteChars).toBeGreaterThan(0);
    expect(result.estimate.estimatedChars).toBeGreaterThan(result.estimate.renderedPromptChars);
  });

  it("omits PAPERCLIP_WORKSPACE_CWD when agent_home falls back to config.cwd", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedTokens: 500,
          },
        },
      },
      ...baseInput,
      adapterType: "cursor",
      adapterConfig: {
        promptTemplate: "Short prompt",
        cwd: "/tmp/configured-home",
      },
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/worktree",
          source: "agent_home",
          workspaceId: "ws-1",
        },
      },
      hasResumableSession: true,
      authTokenPresent: false,
    });

    const expectedKeys = [
      "PAPERCLIP_AGENT_ID",
      "PAPERCLIP_API_URL",
      "PAPERCLIP_COMPANY_ID",
      "PAPERCLIP_RUN_ID",
      "PAPERCLIP_WORKSPACE_ID",
      "PAPERCLIP_WORKSPACE_SOURCE",
    ].sort();
    const expectedRuntimeNote = [
      "Paperclip runtime note:",
      `The following PAPERCLIP_* environment variables are available in this run: ${expectedKeys.join(", ")}`,
      "Do not assume these variables are missing without checking your shell environment.",
      "",
      "",
    ].join("\n");

    expect(result.estimate.runtimeNoteChars).toBe(expectedRuntimeNote.length);
  });

  it("counts pi-local instructions and duplicated prompt material", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-context-budget-pi-"));
    tempDirs.push(dir);
    const instructionsPath = path.join(dir, "PI.md");
    await fs.writeFile(instructionsPath, "PI instructions\n", "utf8");

    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {
        heartbeat: {
          contextBudgetPreflight: {
            maxEstimatedChars: 30,
          },
        },
      },
      ...baseInput,
      adapterType: "pi_local",
      adapterConfig: {
        promptTemplate: "{{agent.name}}",
        instructionsFilePath: instructionsPath,
      },
      context: {},
      hasResumableSession: false,
      cwd: dir,
    });

    expect(result.estimate.instructionsChars).toBeGreaterThan(0);
    expect(result.estimate.estimatedChars).toBeGreaterThan(result.estimate.renderedPromptChars * 2);
    expect(result.blocked).toBe(true);
  });

  it("treats missing config as a pass-through no-op", async () => {
    const result = await evaluateContextBudgetPreflight({
      runtimeConfig: {},
      adapterConfig: {
        promptTemplate: "Short prompt",
      },
      context: {
        issueId: "issue-1",
      },
      hasResumableSession: true,
      ...baseInput,
    });

    expect(result).toMatchObject({
      blocked: false,
      policy: null,
      reason: null,
    });
  });
});

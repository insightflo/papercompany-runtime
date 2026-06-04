import { describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  CODEX_REAUTH_REQUIRED_PAUSE_REASON,
  buildCodexAuthAutoBlockedComment,
  detectCodexAuthFailureForAutoBlock,
  formatRuntimeWorkspaceWarningLog,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  resolveMissionSessionAuthorityDecision,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildAgent(adapterType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("resets session context on mission recovery owner-action wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "mission_unblock_action_created" })).toBe(true);
    expect(shouldResetTaskSessionForWake({ wakeReason: "mission_unblock_action_stalled" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});

describe("resolveMissionSessionAuthorityDecision", () => {
  it("makes mission_sessions the default authority whenever mission scope is known", () => {
    expect(
      resolveMissionSessionAuthorityDecision({
        missionId: "mission-1",
        missionSessionId: "mission-session-1",
        taskSessionDisplayId: "task-session-1",
        taskSessionLegacySessionId: "legacy-task-session-1",
        runtimeSessionId: "runtime-session-1",
      }),
    ).toEqual({
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId: "task-session-1",
      preferredSessionId: "mission-session-1",
    });
  });

  it("keeps task-session data as explicit compatibility seed when mission scope is known but binding is empty", () => {
    expect(
      resolveMissionSessionAuthorityDecision({
        missionId: "mission-1",
        taskSessionDisplayId: "task-session-1",
        taskSessionLegacySessionId: "legacy-task-session-1",
      }),
    ).toEqual({
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId: "task-session-1",
      preferredSessionId: null,
    });
  });

  it("drops task-session compatibility seeding when a fresh mission session is explicitly requested", () => {
    expect(
      resolveMissionSessionAuthorityDecision({
        missionId: "mission-1",
        taskSessionDisplayId: "task-session-1",
        taskSessionLegacySessionId: "legacy-task-session-1",
        resetTaskSession: true,
      }),
    ).toEqual({
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId: null,
      preferredSessionId: null,
    });
  });

  it("falls back to task-session authority outside mission scope", () => {
    expect(
      resolveMissionSessionAuthorityDecision({
        taskSessionDisplayId: "task-session-1",
        taskSessionLegacySessionId: "legacy-task-session-1",
        runtimeSessionId: "runtime-session-1",
      }),
    ).toEqual({
      missionKnown: false,
      defaultAuthority: "task_session",
      compatibilitySeedSessionId: null,
      preferredSessionId: "task-session-1",
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Using fallback workspace")).toEqual({
      stream: "stdout",
      chunk: "[paperclip] Using fallback workspace\n",
    });
  });
});

describe("detectCodexAuthFailureForAutoBlock", () => {
  it("returns normalized reason info from codex auth error codes", () => {
    expect(
      detectCodexAuthFailureForAutoBlock({
        adapterType: "codex_local",
        errorCode: "codex_auth_401_account_deactivated",
      }),
    ).toEqual({
      reasonCode: "CODEX_AUTH_401_ACCOUNT_DEACTIVATED",
      authErrorCode: "account_deactivated",
    });
  });

  it("falls back to parsing 401 Unauthorized text", () => {
    expect(
      detectCodexAuthFailureForAutoBlock({
        adapterType: "codex_local",
        errorMessage: "unexpected status 401 Unauthorized: auth error code: account_deactivated",
      }),
    ).toEqual({
      reasonCode: "CODEX_AUTH_401_ACCOUNT_DEACTIVATED",
      authErrorCode: "account_deactivated",
    });
  });

  it("detects Codex refresh-token reuse even when the final error is not formatted as 401 text", () => {
    expect(
      detectCodexAuthFailureForAutoBlock({
        adapterType: "codex_local",
        errorMessage:
          "Your access token could not be refreshed because your refresh token was already used. code: refresh_token_reused. Please log out and sign in again.",
      }),
    ).toEqual({
      reasonCode: "CODEX_AUTH_REFRESH_TOKEN_REUSED",
      authErrorCode: "refresh_token_reused",
    });
  });

  it("detects expired Codex authentication tokens as reauth-required failures", () => {
    expect(
      detectCodexAuthFailureForAutoBlock({
        adapterType: "codex_local",
        stderrExcerpt: "Provided authentication token is expired. code: token_expired",
      }),
    ).toEqual({
      reasonCode: "CODEX_AUTH_TOKEN_EXPIRED",
      authErrorCode: "token_expired",
    });
  });

  it("exports the pause reason used for reauth-required Codex failures", () => {
    expect(CODEX_REAUTH_REQUIRED_PAUSE_REASON).toBe("reauth_required");
  });

  it("ignores non-codex adapters", () => {
    expect(
      detectCodexAuthFailureForAutoBlock({
        adapterType: "claude_local",
        errorCode: "codex_auth_401",
        errorMessage: "401 Unauthorized",
      }),
    ).toBeNull();
  });
});

describe("buildCodexAuthAutoBlockedComment", () => {
  it("includes standardized reason code and recovery instructions", () => {
    const comment = buildCodexAuthAutoBlockedComment({
      reasonCode: "CODEX_AUTH_401_ACCOUNT_DEACTIVATED",
      authErrorCode: "account_deactivated",
      runId: "run-123",
    });

    expect(comment).toContain("자동 차단: codex_local 인증 오류");
    expect(comment).toContain("`CODEX_AUTH_401_ACCOUNT_DEACTIVATED`");
    expect(comment).toContain("`hermes auth`");
    expect(comment).toContain("`codex login`");
    expect(comment).toContain("`run-123`");
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});

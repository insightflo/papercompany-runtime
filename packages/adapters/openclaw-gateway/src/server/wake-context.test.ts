import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it } from "vitest";
import {
  appendWakeText,
  buildOpenClawWakeContext,
  buildStandardPaperclipPayload,
  resolveClaimedApiKeyPath,
} from "./wake-context.js";

function buildContext(overrides: {
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  runId?: string;
} = {}): AdapterExecutionContext {
  return {
    runId: overrides.runId ?? "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Wake worker",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { ...overrides.config },
    context: { ...overrides.context },
    onLog: async () => {},
  };
}

describe("openclaw_gateway wake-context construction", () => {
  it("builds a wake context with run/agent/company identity and wake reason", () => {
    const wake = buildOpenClawWakeContext(
      buildContext({ context: { wakeReason: "issue_updated" } }),
      {},
    );
    expect(wake.wakePayload).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      companyId: "company-1",
      wakeReason: "issue_updated",
      approvalId: null,
      approvalStatus: null,
    });
    expect(wake.paperclipEnv.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(wake.paperclipEnv.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(wake.paperclipEnv.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(wake.paperclipEnv.PAPERCLIP_WAKE_REASON).toBe("issue_updated");
  });

  it("falls back taskId to issueId and legacy commentId to wakeCommentId", () => {
    const ctx = buildContext({
      context: {
        issueId: "issue-9",
        commentId: "comment-legacy",
        issueIds: ["issue-9", "", "issue-10"],
      },
    });
    const wake = buildOpenClawWakeContext(ctx, {});
    expect(wake.wakePayload.taskId).toBe("issue-9");
    expect(wake.wakePayload.issueId).toBe("issue-9");
    expect(wake.wakePayload.wakeCommentId).toBe("comment-legacy");
    expect(wake.wakePayload.issueIds).toEqual(["issue-9", "issue-10"]);
    expect(wake.paperclipEnv.PAPERCLIP_TASK_ID).toBe("issue-9");
    expect(wake.paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-legacy");
    expect(wake.paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-9,issue-10");
  });

  it("leaves taskId null when neither taskId nor issueId are present", () => {
    const wake = buildOpenClawWakeContext(buildContext({}), {});
    expect(wake.wakePayload.taskId).toBeNull();
    expect(wake.wakePayload.issueId).toBeNull();
    expect(wake.paperclipEnv.PAPERCLIP_TASK_ID).toBeUndefined();
  });

  it("carries approval context into the payload and env", () => {
    const wake = buildOpenClawWakeContext(
      buildContext({ context: { approvalId: "approval-1", approvalStatus: "pending" } }),
      {},
    );
    expect(wake.wakePayload.approvalId).toBe("approval-1");
    expect(wake.wakePayload.approvalStatus).toBe("pending");
    expect(wake.paperclipEnv.PAPERCLIP_APPROVAL_ID).toBe("approval-1");
    expect(wake.paperclipEnv.PAPERCLIP_APPROVAL_STATUS).toBe("pending");
  });

  it("preserves unsupported extra payload keys inside the wake text", () => {
    const wake = buildOpenClawWakeContext(buildContext({}), { customField: "custom-value" });
    expect(wake.wakeText).toContain('"unsupportedPayloadTemplate":{"customField":"custom-value"}');
  });

  it("ignores an invalid paperclipApiUrl override and keeps the default URL", () => {
    const ctx = buildContext({ config: { paperclipApiUrl: "not-a-valid-url" } });
    const wake = buildOpenClawWakeContext(ctx, {});
    const expectedDefault = buildPaperclipEnv(ctx.agent, { context: ctx.context }).PAPERCLIP_API_URL;
    expect(wake.paperclipEnv.PAPERCLIP_API_URL).toBe(expectedDefault);
    expect(wake.paperclipEnv.PAPERCLIP_API_URL).not.toContain("not-a-valid-url");
    expect(wake.paperclipEnv.PAPERCLIP_API_BASE_URL).toBeTruthy();
  });

  it("applies a valid paperclipApiUrl override", () => {
    const ctx = buildContext({ config: { paperclipApiUrl: "http://api.example.test:9000" } });
    const wake = buildOpenClawWakeContext(ctx, {});
    expect(wake.paperclipEnv.PAPERCLIP_API_URL).toBe("http://api.example.test:9000/");
    expect(wake.wakeText).toContain("api_base=http://api.example.test:9000/");
  });

  it("includes workspace, workspaces, and runtime service context", () => {
    const ctx = buildContext({
      context: {
        paperclipWorkspace: { cwd: "/tmp/ws", workspaceId: "workspace-1" },
        paperclipWorkspaces: [
          { cwd: "/tmp/ws", workspaceId: "workspace-1" },
          { workspaceId: "workspace-2" },
          "not-a-record",
        ],
        paperclipRuntimeServiceIntents: [
          { serviceName: "preview", lifecycle: "ephemeral", desired: true },
          "not-a-record",
        ],
      },
      config: { workspaceRuntime: { defaultServices: ["preview"] } },
    });
    const wake = buildOpenClawWakeContext(ctx, {});
    expect(wake.wakeText).toContain('"workspace":{"cwd":"/tmp/ws","workspaceId":"workspace-1"}');
    expect(wake.wakeText).toContain('"workspaces"');
    expect(wake.wakeText).toContain('"workspaceRuntime"');
    expect(wake.wakeText).toContain('"services"');
    expect(wake.wakeText).toContain('"serviceName":"preview"');
    expect(wake.wakeText).not.toContain("not-a-record");
  });

  it("builds the standard paperclip payload with expected serialized fields", () => {
    const ctx = buildContext({
      context: { issueId: "issue-1", paperclipWorkspace: { workspaceId: "ws-1" } },
    });
    const wakePayload = buildOpenClawWakeContext(ctx, {}).wakePayload;
    const payload = buildStandardPaperclipPayload(
      ctx,
      wakePayload,
      { PAPERCLIP_API_URL: "http://localhost:3200" },
      { paperclip: { stale: true }, keep: "value" },
    );
    expect(payload).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      agentName: "Wake worker",
      taskId: "issue-1",
      issueId: "issue-1",
      issueIds: [],
      wakeReason: null,
      wakeCommentId: null,
      approvalId: null,
      approvalStatus: null,
      apiUrl: "http://localhost:3200",
      workspace: { workspaceId: "ws-1" },
      stale: true,
    });
    expect(payload).not.toHaveProperty("keep");
  });

  it("defaults the claimed API-key path and honors a configured path", () => {
    expect(resolveClaimedApiKeyPath(undefined)).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
    expect(resolveClaimedApiKeyPath(" ")).toBe(
      "~/.openclaw/workspace/paperclip-claimed-api-key.json",
    );
    expect(resolveClaimedApiKeyPath("~/.openclaw/workspace/keys/meridian.json")).toBe(
      "~/.openclaw/workspace/keys/meridian.json",
    );

    const defaultWake = buildOpenClawWakeContext(buildContext({}), {});
    expect(defaultWake.wakeText).toContain(
      "PAPERCLIP_API_KEY=<token from ~/.openclaw/workspace/paperclip-claimed-api-key.json>",
    );

    const configuredWake = buildOpenClawWakeContext(
      buildContext({ config: { claimedApiKeyPath: "~/.openclaw/workspace/keys/meridian.json" } }),
      {},
    );
    expect(configuredWake.wakeText).toContain(
      "PAPERCLIP_API_KEY=<token from ~/.openclaw/workspace/keys/meridian.json>",
    );
  });

  it("appends wake text after template text and handles empty base text", () => {
    expect(appendWakeText("Do this now", "Wake body")).toBe("Do this now\n\nWake body");
    expect(appendWakeText("   ", "Wake body")).toBe("Wake body");
    expect(appendWakeText("Do this now", "")).toBe("Do this now\n\n");
  });

  it("never embeds an actual API-key value in the wake text", () => {
    const wake = buildOpenClawWakeContext(
      buildContext({ config: { authToken: "sk-test-secret-123" } }),
      {},
    );
    expect(wake.wakeText).toContain("PAPERCLIP_API_KEY=<token from");
    expect(wake.wakeText).not.toContain("sk-test-secret-123");
    expect(wake.wakeText).not.toContain("PAPERCLIP_API_KEY=sk");
  });

  it("serializes the wake text with env lines, api_base, and HTTP rules", () => {
    const wake = buildOpenClawWakeContext(
      buildContext({ context: { issueId: "issue-1" } }),
      {},
    );
    expect(wake.wakeText.startsWith("Paperclip wake event for a cloud adapter.")).toBe(true);
    expect(wake.wakeText).toContain("PAPERCLIP_RUN_ID=run-1");
    expect(wake.wakeText).toContain("api_base=");
    expect(wake.wakeText).toContain("task_id=issue-1");
    expect(wake.wakeText).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    expect(wake.wakeText).toContain("X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID");
  });
});

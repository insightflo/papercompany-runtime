// @vitest-environment node

import { describe, expect, it } from "vitest";
import { attentionItemToRun } from "./useInboxHeartbeatData";
import { encodeHeartbeatCursor } from "../api/heartbeats";

describe("useInboxHeartbeatData attention adaptation", () => {
  it("maps an attention item into a HeartbeatRun preserving retry issueId semantics", () => {
    const run = attentionItemToRun(
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "failed",
        issueId: "issue-1",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        error: "boom",
        errorCode: "adapter_error",
      },
      "company-1",
    );

    expect(run.id).toBe("run-1");
    expect(run.companyId).toBe("company-1");
    expect(run.agentId).toBe("agent-1");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("boom");
    // Retry semantics: the issue id must be readable from contextSnapshot.
    expect(run.contextSnapshot).toEqual({ issueId: "issue-1" });
    expect((run.contextSnapshot as Record<string, unknown>).issueId).toBe("issue-1");
  });

  it("leaves contextSnapshot null when the attention item has no issue", () => {
    const run = attentionItemToRun(
      {
        runId: "run-2",
        agentId: "agent-2",
        status: "timed_out",
        issueId: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        error: null,
        errorCode: null,
      },
      "company-1",
    );
    expect(run.contextSnapshot).toBeNull();
  });
});

describe("encodeHeartbeatCursor", () => {
  it("serializes a cursor for the query string", () => {
    expect(encodeHeartbeatCursor({ createdAt: "2026-07-01T00:00:00.000Z", id: "run-1" })).toBe(
      // encodeHeartbeatCursor intentionally does NOT encodeURIComponent; the
      // API client passes the result to URLSearchParams.set(), which handles
      // percent-encoding. Pre-encoding here would double-encode the colons
      // (':' → '%3A' → '%253A') and break the server's cursor parser.
      "2026-07-01T00:00:00.000Z_run-1",
    );
  });

  it("returns null for missing cursors", () => {
    expect(encodeHeartbeatCursor(null)).toBeNull();
    expect(encodeHeartbeatCursor(undefined)).toBeNull();
  });
});

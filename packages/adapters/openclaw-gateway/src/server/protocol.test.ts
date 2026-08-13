import { describe, expect, it } from "vitest";
import {
  applyGatewayChatEvent,
  buildAgentScopedSessionKey,
  isGatewayProtocolMismatch,
  resolveGatewayProtocol,
  extractGatewayText,
  type GatewayChatTranscript,
} from "./protocol.js";

describe("OpenClaw gateway protocol compatibility", () => {
  it("negotiates current v3 and v4 by default and keeps v3 as an explicit fallback", () => {
    expect(resolveGatewayProtocol({})).toEqual({
      minProtocol: 3,
      maxProtocol: 4,
      fallbackProtocol: 3,
    });
    expect(resolveGatewayProtocol({ protocolVersion: 3 })).toEqual({
      minProtocol: 3,
      maxProtocol: 3,
      fallbackProtocol: null,
    });
    expect(resolveGatewayProtocol({ protocolVersion: "4" })).toEqual({
      minProtocol: 4,
      maxProtocol: 4,
      fallbackProtocol: null,
    });
  });

  it("only retries a negotiated range for a structured protocol mismatch", () => {
    expect(
      isGatewayProtocolMismatch({
        gatewayCode: "UNSUPPORTED_PROTOCOL",
        message: "unsupported protocol range",
      }),
    ).toBe(true);
    expect(
      isGatewayProtocolMismatch({
        gatewayCode: "AUTH_REQUIRED",
        message: "protocol token is missing",
      }),
    ).toBe(false);
    expect(isGatewayProtocolMismatch(new Error("protocol mismatch"))).toBe(false);
    expect(
      isGatewayProtocolMismatch({
        gatewayCode: "INVALID_REQUEST",
        message: "protocol mismatch",
        gatewayDetails: { code: "PROTOCOL_MISMATCH" },
      }),
    ).toBe(true);
    expect(
      isGatewayProtocolMismatch({
        gatewayCode: "INVALID_REQUEST",
        message: "invalid client version",
        gatewayDetails: { code: "INVALID_CLIENT_VERSION" },
      }),
    ).toBe(false);
  });
});

describe("OpenClaw gateway session isolation", () => {
  it("scopes issue and run sessions to the agent while preserving explicit fixed keys", () => {
    expect(
      buildAgentScopedSessionKey({
        strategy: "issue",
        configuredSessionKey: null,
        agentId: "agent-a",
        issueId: "issue-1",
        runId: "run-1",
      }),
    ).toBe("agent:agent-a:paperclip:issue:issue-1");
    expect(
      buildAgentScopedSessionKey({
        strategy: "run",
        configuredSessionKey: null,
        agentId: "agent-a",
        issueId: "issue-1",
        runId: "run-1",
      }),
    ).toBe("agent:agent-a:paperclip:run:run-1");
    expect(
      buildAgentScopedSessionKey({
        strategy: "fixed",
        configuredSessionKey: "shared-session",
        agentId: "agent-a",
        issueId: "issue-1",
        runId: "run-1",
      }),
    ).toBe("agent:agent-a:shared-session");
  });
});

describe("OpenClaw v4 chat event mapping", () => {
  it("appends deltaText once and replaces with a cumulative snapshot when requested", () => {
    let transcript: GatewayChatTranscript = { text: "", lastSeq: null };
    transcript = applyGatewayChatEvent(transcript, {
      state: "delta",
      deltaText: "Hello ",
      seq: 1,
    });
    transcript = applyGatewayChatEvent(transcript, {
      state: "delta",
      deltaText: "world",
      message: "Hello world",
      seq: 2,
    });
    transcript = applyGatewayChatEvent(transcript, {
      state: "delta",
      deltaText: "duplicate",
      seq: 2,
    });
    transcript = applyGatewayChatEvent(transcript, {
      state: "delta",
      replace: true,
      deltaText: "Final answer",
      seq: 3,
    });

    expect(transcript).toEqual({ text: "Final answer", lastSeq: 3 });
  });

  it("extracts text from v4 message content without treating it as execution authority", () => {
    expect(
      extractGatewayText({
        role: "assistant",
        content: [{ type: "text", text: "structured reply" }],
      }),
    ).toBe("structured reply");
    expect(
      applyGatewayChatEvent(
        { text: "", lastSeq: null },
        { state: "final", message: { content: "done" }, seq: 4 },
      ),
    ).toEqual({ text: "done", lastSeq: 4 });
  });
});

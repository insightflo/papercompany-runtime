import { describe, expect, it, vi } from "vitest";

const executeSpy = vi.fn();
const mockedAdapterOptions = vi.hoisted(() => ({ supportsLocalAgentJwt: false }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: mockedAdapterOptions.supportsLocalAgentJwt, execute: executeSpy })),
  runningProcesses: new Map(),
}));
import { classifyHeartbeatRunFailure } from "../services/heartbeat.ts";

describe("classifyHeartbeatRunFailure — guardrail precedence over auth", () => {
  // Regression: a Step Input Manifest / broad-scan guardrail block must classify as
  // command (input-contract/command-policy), NOT auth, even when model stdout prose
  // leaks "Unauthorized"/"forbidden". Evidence weighting: structured error/stderr
  // outrank stdout prose.
  it("classifies a Step Input Manifest broad-scan block as command, not auth, when stdout contains auth-like text", () => {
    const result = classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: 'Step Input Manifest blocked runtime broad scan command: "rg without an allowed file path"',
      stdoutExcerpt: "The API returned Unauthorized (login required). Please re-auth.",
      errorCode: null,
    });
    expect(result.category).toBe("command");
    expect(result.reasonCode).toBe("STEP_INPUT_MANIFEST_GUARDRAIL");
  });

  it("classifies a Step Input Manifest broad-scan block as command, not quota, when stdout contains quota-like text", () => {
    const result = classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: 'Step Input Manifest blocked runtime broad scan command: "find ."',
      stdoutExcerpt: "Provider quota or rate-limit failure detected from run output. HTTP 429 capacity exceeded.",
      errorCode: null,
    });
    expect(result.category).toBe("command");
    expect(result.reasonCode).toBe("STEP_INPUT_MANIFEST_GUARDRAIL");
  });

  it("still classifies a real auth failure (stderr 401, no guardrail) as auth", () => {
    const result = classifyHeartbeatRunFailure({
      status: "failed",
      errorMessage: "401 Unauthorized: invalid API key",
      stderrExcerpt: "authentication failed",
      stdoutExcerpt: null,
      errorCode: null,
    });
    expect(result.category).toBe("auth");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as env from "./paperclip-env.js";
import * as compatibility from "./server-utils.js";

const originalApiKey = process.env.PAPERCLIP_API_KEY;
const originalRunId = process.env.PAPERCLIP_RUN_ID;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
  else process.env.PAPERCLIP_API_KEY = originalApiKey;
  if (originalRunId === undefined) delete process.env.PAPERCLIP_RUN_ID;
  else process.env.PAPERCLIP_RUN_ID = originalRunId;
});

describe("Paperclip child environment boundaries", () => {
  it("preserves direct-module and server-utils compatibility exports", () => {
    expect(compatibility.buildPaperclipEnv).toBe(env.buildPaperclipEnv);
    expect(compatibility.buildPaperclipExecutionEnv).toBe(
      env.buildPaperclipExecutionEnv,
    );
    expect(compatibility.sanitizeInheritedPaperclipEnv).toBe(
      env.sanitizeInheritedPaperclipEnv,
    );
  });

  it("builds runtime values over config values and never accepts a configured API key", () => {
    const executionEnv = compatibility.buildPaperclipExecutionEnv(
      {
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_API_URL: "http://paperclip/api",
        PAPERCLIP_API_KEY: "runtime-token",
      },
      {
        PAPERCLIP_AGENT_ID: "spoofed-agent",
        PAPERCLIP_API_KEY: "configured-token",
        ANTHROPIC_API_KEY: "provider-token",
      },
      "auth-token",
    );

    expect(executionEnv).toEqual({
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_API_URL: "http://paperclip/api",
      PAPERCLIP_API_KEY: "auth-token",
      ANTHROPIC_API_KEY: "provider-token",
    });
  });

  it("removes inherited Paperclip runtime variables while preserving provider credentials", () => {
    process.env.PAPERCLIP_API_KEY = "inherited-token";
    process.env.PAPERCLIP_RUN_ID = "inherited-run";
    process.env.ANTHROPIC_API_KEY = "provider-token";

    const sanitized = compatibility.sanitizeInheritedPaperclipEnv(process.env);

    expect(sanitized.PAPERCLIP_API_KEY).toBeUndefined();
    expect(sanitized.PAPERCLIP_RUN_ID).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBe("provider-token");
    delete process.env.ANTHROPIC_API_KEY;
  });
});

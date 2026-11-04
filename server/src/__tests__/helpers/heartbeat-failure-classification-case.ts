import { expect, it } from "vitest";
import { classifyHeartbeatRunFailure } from "../../services/heartbeat.js";

export function registerHeartbeatFailureClassificationCase() {
  it("classifies quota/auth/command provider failures for oversight", () => {
    expect(
      classifyHeartbeatRunFailure({
        status: "failed",
        errorCode: "provider_403",
        errorMessage: "HTTP 403: Kimi quota exceeded for this account",
        provider: "kimi",
        model: "kimi-k2",
        command: "mimo25pro",
      }),
    ).toEqual(
      expect.objectContaining({
        category: "quota",
        reasonCode: "PROVIDER_QUOTA_OR_AUTH_403",
        fallbackCandidates: expect.arrayContaining([expect.stringContaining("mimo26pro")]),
      }),
    );
    expect(
      classifyHeartbeatRunFailure({ status: "failed", errorMessage: "401 Unauthorized: invalid API key" }),
    ).toEqual(expect.objectContaining({ category: "auth", reasonCode: "PROVIDER_AUTH_FAILURE" }));
    expect(
      classifyHeartbeatRunFailure({ status: "failed", errorMessage: "spawn /missing/agent ENOENT" }),
    ).toEqual(expect.objectContaining({ category: "command", reasonCode: "COMMAND_EXECUTION_FAILURE" }));
  });

}

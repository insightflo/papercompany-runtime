import { describe, expect, it } from "vitest";
import { resolveCodexAuthErrorCode } from "../../../packages/adapters/codex-local/src/server/execute.js";

describe("resolveCodexAuthErrorCode", () => {
  it("does not turn a generic public R2 401 into Codex auth evidence", () => {
    expect(resolveCodexAuthErrorCode("R2_STATUS HTTP/1.1 401 Unauthorized")).toBeNull();
  });

  it("preserves provider-specific structured Codex auth failures", () => {
    expect(resolveCodexAuthErrorCode(
      "unexpected status 401 Unauthorized: auth error code: account_deactivated",
    )).toBe("codex_auth_401_account_deactivated");
    expect(resolveCodexAuthErrorCode("auth error: 401")).toBe("codex_auth_401");
  });
});

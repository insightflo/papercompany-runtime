import { describe, expect, it } from "vitest";
import { detectCodexAuthFailureForAutoBlock } from "../services/heartbeat.js";

describe("detectCodexAuthFailureForAutoBlock", () => {
  it("does not auto-pause Codex for a generic public R2 401", () => {
    expect(detectCodexAuthFailureForAutoBlock({
      adapterType: "codex_local",
      errorCode: "codex_auth_401",
      errorMessage: "R2_STATUS HTTP/1.1 401 Unauthorized",
    })).toBeNull();
  });

  it("preserves structured and provider-specific Codex auth evidence", () => {
    expect(detectCodexAuthFailureForAutoBlock({
      adapterType: "codex_local",
      errorCode: "codex_auth_401_account_deactivated",
    })).toEqual({
      reasonCode: "CODEX_AUTH_401_ACCOUNT_DEACTIVATED",
      authErrorCode: "account_deactivated",
    });
    expect(detectCodexAuthFailureForAutoBlock({
      adapterType: "codex_local",
      errorMessage: "auth error: 401",
    })).toEqual({ reasonCode: "CODEX_AUTH_401", authErrorCode: null });
  });
});

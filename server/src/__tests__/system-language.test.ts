import { describe, expect, it } from "vitest";
import { normalizeSystemLanguage, prose } from "../services/missions/system-language.js";

describe("system language helper", () => {
  it("normalizes only ko as non-English and falls back to en for anything else", () => {
    expect(normalizeSystemLanguage("ko")).toBe("ko");
    expect(normalizeSystemLanguage("en")).toBe("en");
    expect(normalizeSystemLanguage(null)).toBe("en");
    expect(normalizeSystemLanguage(undefined)).toBe("en");
    expect(normalizeSystemLanguage("ja")).toBe("en");
    expect(normalizeSystemLanguage("Korean")).toBe("en");
  });

  it("returns the English identity for unknown languages and unknown keys", () => {
    // Unknown language falls back to English identity, never to a key.
    expect(prose(normalizeSystemLanguage("ja"), "retry_comment_heading")).toBe("### Mission owner retry requested");
    expect(prose("en", "retry_comment_heading")).toBe("### Mission owner retry requested");
    // Unknown key returns the key verbatim so missing entries are loud at the call site.
    expect(prose("ko", "missing_key")).toBe("missing_key");
  });

  it("translates representative prose to Korean and interpolates params", () => {
    expect(prose("ko", "owner_unblock_signal_intro")).toContain("오버사이트로부터 미션 오너 신호");
    expect(prose("ko", "retry_comment_heading")).toBe("### 미션 오너 재시도 요청");
    expect(prose("ko", "retry_comment_workproducts_label", { count: 3 })).toBe(
      "이 소스 이슈의 활성 워크프로덕트 (3개 표시):",
    );
    // English also interpolates so callers can rely on the same contract.
    expect(prose("en", "retry_comment_workproducts_label", { count: 3 })).toBe(
      "Active workProducts on this source issue (showing 3):",
    );
    // Korean prose still embeds English control tokens unchanged.
    expect(prose("ko", "owner_unblock_source_assignment_note")).toContain("reassign_source_issue");
    expect(prose("ko", "owner_unblock_source_assignment_note")).toContain("targetAgentId");
  });
});

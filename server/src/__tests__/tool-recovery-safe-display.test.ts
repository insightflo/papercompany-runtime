import { describe, expect, it } from "vitest";
import { toolRecoverySafeText } from "../services/missions/tool-recovery-safe-display.js";
import { toolRecoveryUrlDiagnostics } from "./helpers/tool-recovery-url-diagnostics.js";

// Catches partial header redaction and URI-scheme allowlisting leaking credentials.
describe("tool recovery secret-safe display", () => {
  it.each([
    "Authorization: Basic AUTH_PAYLOAD_SENTINEL",
    "stderr: authorization = CustomScheme AUTH_PAYLOAD_SENTINEL extra",
    '"Authorization": "Digest username=AUTH_PAYLOAD_SENTINEL, response=OTHER_SENTINEL"',
    "Proxy-Authorization: Negotiate AUTH_PAYLOAD_SENTINEL",
  ])("suppresses complete authorization values: %s", diagnostic => {
    const text = toolRecoverySafeText(`${diagnostic}\nordinary failure detail`);
    expect(text).not.toMatch(/AUTH_PAYLOAD_SENTINEL|OTHER_SENTINEL/);
    expect(text).toContain("ordinary failure detail");
  });

  it.each(["postgres", "postgresql", "redis", "mongodb+srv"])("scrubs %s URI credentials and query secrets", scheme => {
    const text = toolRecoverySafeText(`${scheme}://user:DSN_PASSWORD_SENTINEL@db.example/test?key=QUERY_SENTINEL#FRAGMENT_SENTINEL`);
    expect(text).not.toMatch(/DSN_PASSWORD_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|user:/);
    expect(text).toContain("[REDACTED_URL]");
  });

  it("retains an unambiguous public URL but removes its query and fragment", () => {
    expect(toolRecoverySafeText("https://example.test/help?key=QUERY_SENTINEL#FRAGMENT_SENTINEL"))
      .toBe("https://example.test/help");
  });

  it.each(toolRecoveryUrlDiagnostics)("suppresses the full credential fragment with %s", (_name, diagnostic) => {
    const text = toolRecoverySafeText(`connection failed: ${diagnostic}\nnext diagnostic`);
    expect(text).not.toMatch(/DSN_\w+_SENTINEL|user:|prefix/);
    expect(text).toContain("connection failed:");
  });

  it("suppresses an unparseable connection URI rather than keeping its credentials", () => {
    expect(toolRecoverySafeText("postgres://user:DSN_PASSWORD_SENTINEL@[invalid/test")).not.toContain("DSN_PASSWORD_SENTINEL");
  });
});

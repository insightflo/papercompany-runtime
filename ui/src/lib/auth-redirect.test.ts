import { describe, expect, it } from "vitest";
import { resolveAuthRedirectPath } from "./auth-redirect";

describe("resolveAuthRedirectPath", () => {
  it("keeps an internal path relative for Better Auth callbacks", () => {
    expect(resolveAuthRedirectPath("/missions?view=active")).toBe("/missions?view=active");
  });

  it("falls back to the app root for an external or protocol-relative path", () => {
    expect(resolveAuthRedirectPath("https://untrusted.example.test")).toBe("/");
    expect(resolveAuthRedirectPath("//untrusted.example.test")).toBe("/");
  });
});

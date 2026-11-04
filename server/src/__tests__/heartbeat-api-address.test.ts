import { describe, expect, it } from "vitest";
import { normalizePaperclipApiUrl } from "../services/heartbeat-api-address.js";

describe("heartbeat API address", () => {
  it("normalizes valid HTTP addresses and rejects other inputs", () => {
    expect(normalizePaperclipApiUrl(" https://example.com/api/// ")).toBe("https://example.com");
    expect(normalizePaperclipApiUrl("http://localhost:3200/")).toBe("http://localhost:3200");
    expect(normalizePaperclipApiUrl("file:///tmp/x")).toBeNull();
    expect(normalizePaperclipApiUrl("bad")).toBeNull();
    expect(normalizePaperclipApiUrl(null)).toBeNull();
  });
});

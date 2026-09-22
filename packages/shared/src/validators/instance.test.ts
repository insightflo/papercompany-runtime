import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  judgmentBaseUrlSchema,
  judgmentModelIdSchema,
} from "./instance.js";

describe("judgment override settings", () => {
  it("accepts https endpoint without userinfo/query/fragment", () => {
    expect(judgmentBaseUrlSchema.parse("https://api.example.com")).toBe("https://api.example.com");
    expect(judgmentBaseUrlSchema.parse("http://127.0.0.1:19871")).toBe("http://127.0.0.1:19871");
    expect(judgmentBaseUrlSchema.parse(null)).toBeNull();
  });
  it("rejects bad endpoints", () => {
    expect(() => judgmentBaseUrlSchema.parse("ftp://x")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://u:p@api.example.com")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://api.example.com/v1?key=1")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("https://api.example.com/#frag")).toThrow();
    expect(() => judgmentBaseUrlSchema.parse("")).toThrow();
  });
  it("accepts explicit null and rejects bad model ids", () => {
    expect(judgmentModelIdSchema.parse(null)).toBeNull();
    expect(judgmentModelIdSchema.parse("jev-1.13.0")).toBe("jev-1.13.0");
    expect(() => judgmentModelIdSchema.parse("bad model id!")).toThrow();
  });
  it("general settings schema keeps unknown keys out and allows optional overrides", () => {
    const parsed = instanceGeneralSettingsSchema.parse({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" });
    expect(parsed.censorUsernameInLogs).toBe(false);
    expect(parsed.judgmentBaseUrl).toBe("https://api.example.com");
    expect(instanceGeneralSettingsSchema.parse({}).judgmentBaseUrl).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  instanceExperimentalSettingsSchema,
  judgmentBaseUrlSchema,
  judgmentModelIdSchema,
  patchInstanceExperimentalSettingsSchema,
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
  it("workproduct selector-reject flags are patchable and default off (fail-open)", () => {
    // [소비 하드닝 4단계 — 플래그 쓰기 경로] 플래그 모듈은 raw jsonb 를 읽지만 설정 쓰기는
    // 이 스키마(.strict())를 통한다. 키가 없으면 PATCH 로 켤 수 없다 — 쓰기·읽기 경로 일치.
    expect(patchInstanceExperimentalSettingsSchema.parse({
      enableWorkProductSelectorRejectV1: true,
    })).toEqual({ enableWorkProductSelectorRejectV1: true });
    expect(patchInstanceExperimentalSettingsSchema.parse({
      enableWorkProductSelectorRejectCompanyIdsV1: ["ff3e3efd-e30c-45c2-b893-497164405629"],
    }).enableWorkProductSelectorRejectCompanyIdsV1).toHaveLength(1);
    expect(instanceExperimentalSettingsSchema.parse({}).enableWorkProductSelectorRejectV1).toBe(false);
    expect(instanceExperimentalSettingsSchema.parse({}).enableWorkProductSelectorRejectCompanyIdsV1).toEqual([]);
    expect(() => patchInstanceExperimentalSettingsSchema.parse({
      enableWorkProductSelectorRejectCompanyIdsV1: ["not-a-uuid"],
    })).toThrow();
  });
  it("general settings schema keeps unknown keys out and allows optional overrides", () => {
    const parsed = instanceGeneralSettingsSchema.parse({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" });
    expect(parsed.censorUsernameInLogs).toBe(false);
    expect(parsed.judgmentBaseUrl).toBe("https://api.example.com");
    expect(instanceGeneralSettingsSchema.parse({}).judgmentBaseUrl).toBeUndefined();
  });
});

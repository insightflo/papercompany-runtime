// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceGeneralSettings,
  toGeneralPatch,
  toJudgmentDraft,
} from "./InstanceGeneralSettings";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: () => ({
    data: { censorUsernameInLogs: false },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

describe("toJudgmentDraft", () => {
  it("builds an empty draft from empty settings", () => {
    expect(toJudgmentDraft(undefined)).toEqual({ judgmentBaseUrl: "", judgmentModelId: "" });
    expect(toJudgmentDraft({})).toEqual({ judgmentBaseUrl: "", judgmentModelId: "" });
  });

  it("carries saved overrides into the draft", () => {
    expect(
      toJudgmentDraft({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" }),
    ).toEqual({ judgmentBaseUrl: "https://api.example.com", judgmentModelId: "jev-1.13.0" });
  });
});

describe("toGeneralPatch", () => {
  it("maps blank fields to null (clear) and values through trimmed", () => {
    expect(toGeneralPatch({ judgmentBaseUrl: "", judgmentModelId: "alt-model-1" })).toEqual({
      judgmentBaseUrl: null,
      judgmentModelId: "alt-model-1",
    });
    expect(toGeneralPatch({ judgmentBaseUrl: "  https://api.example.com  ", judgmentModelId: " " })).toEqual({
      judgmentBaseUrl: "https://api.example.com",
      judgmentModelId: null,
    });
  });
});

describe("InstanceGeneralSettings judgment connection section", () => {
  it("renders the two labeled inputs and the key-forwarding warning", () => {
    const html = renderToStaticMarkup(<InstanceGeneralSettings />);

    expect(html).toContain("Judgment connection");
    expect(html).toContain('id="judgment-base-url"');
    expect(html).toContain("Base URL");
    expect(html).toContain('id="judgment-model-id"');
    expect(html).toContain("Model id");
    expect(html).toContain("TypeSafe 호환 판단 API 주소(비우면 기본값)");
    expect(html).toContain("모델 미설정 시 정의별 모델 사용");
    expect(html).toContain("서버 환경의 기존 판단 API 키가 이 주소로 전송됨");
  });
});

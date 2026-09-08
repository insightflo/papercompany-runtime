// @vitest-environment node
// [bounded correction] 웹훅 패널 상태 머신 회귀 — 알 수 없는 상태(로딩/오류)에서의
// 변이 금지, 정상 응답의 last4:null 미구성 판정, enabled true/false 분기를 검증한다.
// 컴포넌트 렌더링 테스트는 렌더러 부재(node 환경, testing-library 없음, 신규 의존 금지)로
// 불가능하므로 브라우저 상호작용은 보고서에서 미검증으로 명시한다.
import { describe, expect, it } from "vitest";
import { deriveWebhookPanelState } from "./workflow-webhook-api.js";

const ENABLED = { enabled: true, last4: "ab12", deliveriesLast24h: 2 };
const DISABLED = { enabled: false, last4: "ab12", deliveriesLast24h: 5 };
const UNCONFIGURED = { enabled: false, last4: null, deliveriesLast24h: 0 };

function derive(over: { loading?: boolean; error?: string | null; errorStatus?: number | null; status?: typeof ENABLED | typeof UNCONFIGURED | null } = {}) {
  return deriveWebhookPanelState({
    loading: over.loading ?? false,
    error: over.error ?? null,
    errorStatus: over.errorStatus ?? null,
    status: over.status === undefined ? null : over.status,
  });
}

const MUTABLE = new Set(["unconfigured", "disabled", "enabled"]);

describe("deriveWebhookPanelState — unknown-status mutation gating", () => {
  it("loading denies mutation (no register button while status is unknown)", () => {
    const view = derive({ loading: true });
    expect(view.phase).toBe("loading");
    expect(MUTABLE.has(view.phase)).toBe(false);
  });

  it("load error other than 404 denies mutation (accidental rotate cannot happen)", () => {
    const view = derive({ error: "boom", errorStatus: 500 });
    expect(view.phase).toBe("load-error");
    expect(MUTABLE.has(view.phase)).toBe(false);
  });

  it("error without a status code (non-HTTP failure) also denies mutation", () => {
    const view = derive({ error: "network down", errorStatus: null });
    expect(view.phase).toBe("load-error");
    expect(MUTABLE.has(view.phase)).toBe(false);
  });

  it("real 404 stays a load error and denies registration regardless of error prose", () => {
    const view = derive({ error: "Workflow webhook is not configured", errorStatus: 404 });
    expect(view.phase).toBe("load-error");
    expect(MUTABLE.has(view.phase)).toBe(false);
  });

  it("successful null key tail means unconfigured and permits registration", () => {
    const view = derive({ status: UNCONFIGURED });
    expect(view).toEqual({ phase: "unconfigured" });
    expect(MUTABLE.has(view.phase)).toBe(true);
  });

  it("enabled status shows rotate/disable", () => {
    const view = derive({ status: ENABLED });
    expect(view).toEqual({ phase: "enabled", status: ENABLED });
    expect(MUTABLE.has(view.phase)).toBe(true);
  });

  it("disabled (enabled:false row) offers re-enable via register without hiding the old key tail", () => {
    const view = derive({ status: DISABLED });
    expect(view).toEqual({ phase: "disabled", status: DISABLED });
    expect(MUTABLE.has(view.phase)).toBe(true);
  });

  it("settled state with null status defensively stays non-mutable", () => {
    const view = derive({});
    expect(MUTABLE.has(view.phase)).toBe(false);
  });
});

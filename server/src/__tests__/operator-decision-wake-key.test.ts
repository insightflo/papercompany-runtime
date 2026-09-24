import { describe, expect, it } from "vitest";
import { isBoundedExecutionWakeKey } from "../services/quality/native-wake.js";
import { OPERATOR_DECISION_WAKE_PREFIX } from "../services/operator-decision-continuation-store.js";

// [2026-09-24 CMP-199 사고] 연산자 결정 continuation wake 가 활성 run 에 coalesce 되어
//   유실된 사건의 재발 방지 계약: 이 키 패밀리는 coalesce 금지(bounded) 대상이다.
describe("bounded execution wake keys", () => {
  it("exempts operator decision continuation wakes from coalescing", () => {
    const key = `${OPERATOR_DECISION_WAKE_PREFIX}8303bf9d-bea1-40b5-8861-3f518686a44a:g1:a1`;
    expect(key.startsWith("operator-decision-wake:")).toBe(true);
    expect(isBoundedExecutionWakeKey(key)).toBe(true);
  });

  it("keeps unrelated keys coalescable", () => {
    expect(isBoundedExecutionWakeKey("comment-followup:whatever")).toBe(false);
    expect(isBoundedExecutionWakeKey("operator-decision-wake-something-else")).toBe(false);
    expect(isBoundedExecutionWakeKey(null)).toBe(false);
    expect(isBoundedExecutionWakeKey(undefined)).toBe(false);
  });
});

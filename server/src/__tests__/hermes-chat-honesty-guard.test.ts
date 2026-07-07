import { describe, expect, it } from "vitest";
import { applyHonestyCaveat, detectClaimedAction } from "../services/hermes-chat.js";

// [목적] P5 honesty guard의 pure 분기(claim 검출 + proof 유무에 따른 caveat 부착)를 검증.
//   applyRunHonestyCaveat의 DB 쿼리(wakeup/comment count)는 통합 테스트 영역.
describe("detectClaimedAction", () => {
  it("detects Korean durable-action claims", () => {
    expect(detectClaimedAction("RES-1076 에이전트를 깨웠습니다.")).toBe(true);
    expect(detectClaimedAction("해당 이슈에 댓글을 남겼습니다.")).toBe(true);
    expect(detectClaimedAction("supervision 요청을 보냈습니다.")).toBe(true);
    expect(detectClaimedAction("재작업을 재개시켰습니다.")).toBe(true);
  });

  it("detects English durable-action claims", () => {
    expect(detectClaimedAction("I've woken the producer agent.")).toBe(true);
    expect(detectClaimedAction("Posted a comment on RES-1077.")).toBe(true);
    expect(detectClaimedAction("Dispatched a wakeup to the mission owner.")).toBe(true);
    expect(detectClaimedAction("Notified the operator.")).toBe(true);
  });

  it("returns false for diagnosis-only / status-only responses", () => {
    expect(detectClaimedAction("RES-1076이 producer rework 대상입니다. QA가 source coverage 반렬했습니다.")).toBe(false);
    expect(detectClaimedAction("현재 상태는 다음과 같습니다: blocked.")).toBe(false);
    expect(detectClaimedAction("진단만 전달합니다. 실행은 운영자가 확인하세요.")).toBe(false);
  });

  it("returns false for empty / null", () => {
    expect(detectClaimedAction("")).toBe(false);
    expect(detectClaimedAction(null)).toBe(false);
    expect(detectClaimedAction(undefined)).toBe(false);
  });
});

describe("applyHonestyCaveat", () => {
  it("appends a server-verification caveat when a claim has zero proof", () => {
    const out = applyHonestyCaveat({ body: "에이전트를 깨웠습니다.", claimedAction: true, proofCount: 0 });
    expect(out).toContain("에이전트를 깨웠습니다.");
    expect(out).toContain("[서버 검증]");
    expect(out).toContain("durable 기록");
  });

  it("does NOT append a caveat when proof exists (claim was real)", () => {
    const out = applyHonestyCaveat({ body: "에이전트를 깨웠습니다.", claimedAction: true, proofCount: 1 });
    expect(out).toBe("에이전트를 깨웠습니다.");
  });

  it("does NOT append a caveat when there is no action claim", () => {
    const out = applyHonestyCaveat({ body: "진단만 전달합니다.", claimedAction: false, proofCount: 0 });
    expect(out).toBe("진단만 전달합니다.");
  });
});

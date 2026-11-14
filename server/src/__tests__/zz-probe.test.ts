// [샤드 재편 프로브 2026-11-14] T1b의 신규 테스트 파일 추가가 CI 샤드 분배를 어떻게
//   바꾸는지 검증하기 위한 자리표(placeholder). 실제 relevance 테스트 파일과 같은 정렬
//   위치를 차지해 동일한 재편을 유도한다. 내용은 의도적으로 trivial — 병합 금지.
import { describe, expect, it } from "vitest";

describe("shard redistribution probe", () => {
  it("occupies the sort position of the real relevance test file", () => {
    expect(1 + 1).toBe(2);
  });
});

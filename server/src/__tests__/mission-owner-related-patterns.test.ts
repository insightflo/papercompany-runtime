import { describe, expect, it } from "vitest";

import { selectRelatedKnowledgePatterns } from "../services/missions/mission-owner-related-patterns.js";

const card = (overrides: Record<string, unknown> = {}) => ({
  id: "card-1",
  title: "구조 게이트 토큰 불일치로 QA 스텝 무발사",
  symptoms: "런 running 유지 + 마지막 QA 스텝 pending 지속",
  rootCause: "이중완료가 completedAt을 재스탬프",
  scopeTags: ["workflow", "structural-gate"],
  ...overrides,
});

describe("selectRelatedKnowledgePatterns (deterministic relevance)", () => {
  it("matches cards through scope tags and symptom/title token overlap", () => {
    const selected = selectRelatedKnowledgePatterns(
      [
        card(),
        card({ id: "card-2", title: "n8n 거짓 성공 차단", symptoms: "HTTP 도구가 실패를 성공으로 보고", scopeTags: ["n8n", "http-tool"] }),
        card({ id: "card-3", title: "전혀 다른 주제", symptoms: "다른 회사 이야기", scopeTags: [] }),
      ],
      ["저녁 미션 QA 스텝이 pending에서 무발사", "Workflow run: gazua-evening status=failed"],
    );

    expect(selected.map((entry) => entry.id)).toEqual(["card-1"]);
    expect(selected[0]?.score).toBeGreaterThanOrEqual(2);
  });

  it("keeps tag-only matches and drops everything below the threshold", () => {
    const selected = selectRelatedKnowledgePatterns(
      [card(), card({ id: "card-2", title: "n8n false success", symptoms: "http tool reports success", scopeTags: ["n8n"] })],
      ["n8n workflow investigation"],
    );

    expect(selected.map((entry) => entry.id)).toEqual(["card-1", "card-2"]);
  });

  it("caps results, ignores punctuation casing, and returns nothing for empty context", () => {
    const pool = Array.from({ length: 6 }, (_, index) => card({ id: `card-${index}` }));
    expect(selectRelatedKnowledgePatterns(pool, ["workflow structural gate mismatch"], 3)).toHaveLength(3);
    expect(selectRelatedKnowledgePatterns([card()], [])).toEqual([]);
    expect(selectRelatedKnowledgePatterns([card()], ["   "])).toEqual([]);
  });
});

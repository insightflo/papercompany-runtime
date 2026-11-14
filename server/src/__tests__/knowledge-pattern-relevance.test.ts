import { describe, expect, it } from "vitest";

import {
  isKnowledgeStopword,
  normalizeCodePathRef,
  normalizeKnowledgeTokens,
  resolvePathAlias,
  splitSubWords,
  stemKoreanParticle,
  uniqueFileName,
} from "../services/knowledge-text-normalizer.js";
import { propagateCoupledPatterns } from "../services/knowledge-pattern-graph.js";
import { selectRelatedKnowledgePatterns } from "../services/knowledge-pattern-relevance.js";

// [T1b — mistology 흡수 관련도 엔진] 순수 함수 단위 테스트(DB 기동 없음, ms 단위).
//   normalizer: 스택트레이스/diff 경로 정규화·한국어 조사 스테밍·서브워드 분리·불용어.
//   graph: files→coupled 단방향 1-hop 전파 + 허브 감쇠 + 동종 조인/2-hop 금지.
//   relevance: 엔티티 가중치(서명>심볼>파일>결합)·IDF 클램프·requireMultiBody·전파 합산.

describe("knowledge-text-normalizer", () => {
  it("strips :line:col / (line,col) and git-diff prefixes from code paths", () => {
    expect(normalizeCodePathRef("server/src/a.ts:12:34")).toBe("server/src/a.ts");
    expect(normalizeCodePathRef("src/b.ts:7")).toBe("src/b.ts");
    expect(normalizeCodePathRef("foo.ts(10,15)")).toBe("foo.ts");
    expect(normalizeCodePathRef("a/server\\src\\c.ts")).toBe("server/src/c.ts");
    expect(normalizeCodePathRef("b/./x//y.ts")).toBe("x/y.ts");
  });

  it("derives unique file names and resolves aliases only from the provided map", () => {
    expect(uniqueFileName("server/src/services/foo.ts")).toBe("foo.ts");
    expect(resolvePathAlias("@/svc/foo.ts", { "@": "server/src" })).toBe("server/src/svc/foo.ts");
    expect(resolvePathAlias("@/services/foo.ts", { "@/services": "server/src/services" })).toBe(
      "server/src/services/foo.ts",
    );
    expect(resolvePathAlias("@/svc/foo.ts", {})).toBe("@/svc/foo.ts");
  });

  it("stems Korean particles by suffix walk without eating short nouns", () => {
    expect(stemKoreanParticle("워크플로에서는")).toBe("워크플로");
    expect(stemKoreanParticle("카드는")).toBe("카드");
    expect(stemKoreanParticle("이슈가")).toBe("이슈");
    expect(stemKoreanParticle("사과")).toBe("사과"); // '과'도 조사 후보지만 stem 1음절이라 제거하지 않는다
  });

  it("splits camelCase/snake_case/한영 boundary subwords", () => {
    expect(splitSubWords("selectRelatedKnowledgePatterns")).toEqual(["select", "related", "knowledge", "patterns"]);
    expect(splitSubWords("HTTPServer")).toEqual(["http", "server"]);
    expect(splitSubWords("heartbeat_runs")).toEqual(["heartbeat", "runs"]);
    expect(splitSubWords("run서버")).toEqual(["run", "서버"]);
  });

  it("stopwords cover code-prose noise; domain words survive for IDF", () => {
    expect(isKnowledgeStopword("the")).toBe(true);
    expect(isKnowledgeStopword("failed")).toBe(true);
    expect(isKnowledgeStopword("함수")).toBe(true);
    expect(isKnowledgeStopword("workflow")).toBe(false);
    expect(isKnowledgeStopword("mission")).toBe(false);
    expect(isKnowledgeStopword("issue")).toBe(false);
  });

  it("pipeline: punctuation → subwords → particles → stopwords", () => {
    const tokens = normalizeKnowledgeTokens("The selectRelatedKnowledgePatterns 함수가 실패했다");
    expect(tokens).toEqual(expect.arrayContaining(["select", "related", "knowledge", "patterns", "실패했다"]));
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("함수");
  });
});

describe("knowledge-pattern-graph (files→coupled 1-hop propagation)", () => {
  const row = (id: string, files: string[], coupled: string[]) => ({ id, files, coupled });

  it("propagates an anchored query file to cards whose coupled contains it, with via label", () => {
    const cards = [row("anchor", ["server/src/a.ts"], []), row("coupled", ["server/src/b.ts"], ["server/src/a.ts"])];
    const propagation = propagateCoupledPatterns(cards, ["server/src/a.ts"]);
    expect(propagation.get("coupled")).toMatchObject({ cardId: "coupled", via: ["server/src/a.ts"], strength: 1 });
    expect(propagation.has("anchor")).toBe(false);
  });

  it("decays hub anchors (files.length > 2) to ×0.25 but keeps any tight anchor at full strength", () => {
    const hub = [row("hub", ["a.ts", "b.ts", "c.ts"], []), row("target", ["t.ts"], ["a.ts"])];
    expect(propagateCoupledPatterns(hub, ["a.ts"]).get("target")?.strength).toBe(0.25);
    const mixed = [...hub, row("tight", ["a.ts"], [])];
    expect(propagateCoupledPatterns(mixed, ["a.ts"]).get("target")?.strength).toBe(1);
  });

  it("never joins file↔file or coupled↔coupled, and requires a files-side anchor", () => {
    const filesOnly = [row("f1", ["a.ts"], []), row("f2", ["a.ts"], [])];
    expect(propagateCoupledPatterns(filesOnly, ["a.ts"]).size).toBe(0);
    const coupledOnly = [row("c1", ["x.ts"], ["a.ts"]), row("c2", ["y.ts"], ["a.ts"])];
    expect(propagateCoupledPatterns(coupledOnly, ["a.ts"]).size).toBe(0);
  });

  it("does not propagate a second hop", () => {
    const cards = [row("a", ["f.ts"], []), row("b", ["g.ts"], ["f.ts"]), row("c", ["h.ts"], ["g.ts"])];
    const propagation = propagateCoupledPatterns(cards, ["f.ts"]);
    expect(propagation.get("b")?.via).toEqual(["f.ts"]);
    expect(propagation.has("c")).toBe(false);
  });

  it("normalizes query refs (:line:col, diff prefix, backslash) before matching", () => {
    const cards = [row("a", ["server/src/a.ts"], []), row("b", ["b.ts"], ["server/src/a.ts"])];
    const propagation = propagateCoupledPatterns(cards, ["a/server\\src\\a.ts:10:2"]);
    expect(propagation.get("b")?.via).toEqual(["server/src/a.ts"]);
  });
});

describe("selectRelatedKnowledgePatterns (entity zones + guards)", () => {
  const entityCard = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: "세금 계산서 누락 사고",
    symptoms: "야간 배치 중 누락",
    rootCause: null,
    scopeTags: [] as string[],
    files: [] as string[],
    symbols: [] as string[],
    coupled: [] as string[],
    errorSignatures: [] as string[],
    ...overrides,
  });

  it("keeps the legacy contract: empty cards/context are safe and tag-only matches survive", () => {
    expect(selectRelatedKnowledgePatterns([], ["워크플로 사고"])).toEqual([]);
    expect(selectRelatedKnowledgePatterns([entityCard("c1")], [])).toEqual([]);
    expect(selectRelatedKnowledgePatterns([entityCard("c1")], ["   "])).toEqual([]);
    const tagOnly = selectRelatedKnowledgePatterns([entityCard("c1", { scopeTags: ["workflow"] })], ["workflow 조사"]);
    expect(tagOnly.map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("orders entity weights signature(10) > symbol(6) > file(3) > coupled(1, below threshold)", () => {
    const shared = {
      files: ["server/src/tax.ts"],
      symbols: ["computeTaxBatch"],
      coupled: ["server/src/ledger.ts"],
      errorSignatures: ["HTTP 503 taxbatch"],
    };
    const cards = [entityCard("c1", shared), entityCard("c2", shared), entityCard("c3", shared), entityCard("c4", shared)];
    const bySignature = selectRelatedKnowledgePatterns(cards, ["HTTP 503 taxbatch 발생"], 4);
    expect(bySignature).toHaveLength(4);
    expect(bySignature.every((entry) => entry.score === 10)).toBe(true);
    const bySymbol = selectRelatedKnowledgePatterns(cards, ["computeTaxBatch 호출"]);
    expect(bySymbol.every((entry) => entry.score === 6)).toBe(true);
    const byFile = selectRelatedKnowledgePatterns(cards, ["server/src/tax.ts 수정"]);
    expect(byFile.every((entry) => entry.score === 3)).toBe(true);
    expect(selectRelatedKnowledgePatterns(cards, ["server/src/ledger.ts 확인"])).toEqual([]);
  });

  it("counts one entity hit once at its highest zone weight", () => {
    const card = entityCard("c1", {
      files: ["server/src/a.ts"],
      coupled: ["server/src/a.ts"],
      title: "무관 본문",
      symptoms: null,
    });
    const selected = selectRelatedKnowledgePatterns([card], ["server/src/a.ts 경로"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.score).toBe(3);
  });

  it("boosts rare symbols via idf with a clamp; ubiquitous keys stay at base weight", () => {
    const cards = [
      entityCard("rare", { symbols: ["unwindMissionPlan", "commonSym"], title: "희소 심볼 카드", symptoms: null }),
      entityCard("u1", { symbols: ["commonSym"], title: "공통 하나", symptoms: null }),
      entityCard("u2", { symbols: ["commonSym"], title: "공통 둘", symptoms: null }),
      entityCard("u3", { symbols: ["commonSym"], title: "공통 셋", symptoms: null }),
    ];
    const rare = selectRelatedKnowledgePatterns(cards, ["unwindMissionPlan 호출"]);
    expect(rare).toHaveLength(1);
    expect(rare[0]!.score).toBe(12); // 6 × idf 상한 클램프 2
    const common = selectRelatedKnowledgePatterns(cards, ["commonSym 호출"]);
    expect(common.every((entry) => entry.score === 6)).toBe(true); // df=N → 부스트 없음
  });

  it("requireMultiBody zeroes a lone body-token card but entity matches are exempt", () => {
    const cards = [
      entityCard("anchor", { files: ["server/src/f.ts"], title: "앵커 카드", symptoms: null }),
      entityCard("echo", { coupled: ["server/src/f.ts"], title: "계산서 에코", symptoms: null }),
    ];
    const selected = selectRelatedKnowledgePatterns(cards, ["server/src/f.ts 계산서"]);
    expect(selected.map((entry) => entry.id)).toEqual(["anchor"]); // 에코는 본문 1토큰+전파만으로 0점

    const exempt = selectRelatedKnowledgePatterns(
      [entityCard("strong", { symbols: ["issueTaxExport"], title: "계산서 에코", symptoms: null })],
      ["issueTaxExport 계산서"],
    );
    expect(exempt.map((entry) => entry.id)).toEqual(["strong"]);
  });

  it("sums 1-hop propagation into scores with via labels", () => {
    const cards = [
      entityCard("anchor", { files: ["server/src/a.ts"], title: "앵커", symptoms: null }),
      entityCard("far", { coupled: ["server/src/a.ts"], title: "원거리", symptoms: null, scopeTags: ["batch"] }),
    ];
    const selected = selectRelatedKnowledgePatterns(cards, ["server/src/a.ts batch 원거리"]);
    const far = selected.find((entry) => entry.id === "far");
    expect(far?.via).toEqual(["server/src/a.ts"]);
    expect(far?.score).toBeGreaterThanOrEqual(4); // 태그 3 + 본문 1 + 전파 1 = 5
  });

  it("resolves query file aliases only when an alias map is provided", () => {
    const cards = [entityCard("c1", { files: ["server/src/services/foo.ts"] })];
    const withAlias = selectRelatedKnowledgePatterns(
      cards,
      ["@/services/foo.ts 수정"],
      3,
      { aliasMap: { "@/services": "server/src/services" } },
    );
    expect(withAlias.map((entry) => entry.id)).toEqual(["c1"]);
    expect(selectRelatedKnowledgePatterns(cards, ["@/services/foo.ts 수정"])).toEqual([]);
  });
});

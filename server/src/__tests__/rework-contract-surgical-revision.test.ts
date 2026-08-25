// server/src/__tests__/rework-contract-surgical-revision.test.ts
//
// [purpose] 재작업 계약의 외과수술적 수정 지시(surgical revision) 계약 검증.
//   QA 반려 → 생산자 재작업 시 "잘 된 부분은 그대로 두고 지적된 부분(+직접 영향 부분)만 고친다"
//   는 지시가 (1) 계약 requiredActions(런타임 브리프에 주입되는 실행 지시)과 (2) 생산자 이슈
//   댓글(전문 표시) 모두에 존재함을 보장한다.
// [brief 렌더 제약] adapter-utils runtime-brief-rework-section 은 requiredActions 를 처음 4개만
//   (컴팩트 헤더는 3개만, 항목당 260자 절단) 렌더링한다. 따라서 외과수술 지시는 반드시
//   앞순서(index ≤ 2)에 위치하고 각 항목은 260자 이하여야 실제 에이전트에게 보인다.

import { describe, expect, it } from "vitest";
import {
  buildWorkflowReworkContract,
  readWorkflowReworkContract,
  renderWorkflowReworkComment,
} from "../services/workflow/control-flow/rework-contract.js";

const BRIEF_MAX_ACTIONS = 4;
const BRIEF_COMPACT_MAX_ACTIONS = 3;
const BRIEF_LINE_TRUNCATE = 260;

const SURGICAL_MARKER = "Revise surgically";

function build() {
  return buildWorkflowReworkContract({
    producerStepId: "build-beginner-html-report",
    qaFeedbacks: [
      { qaStepId: "validate-html-report", qaIssueId: "RES-100", feedback: "internal term exposed in index.html" },
    ],
    currentIteration: 0,
    maxIterations: 2,
    dependencyArtifacts: "- collect: /srv/out/sources.json",
    producerIssueInstruction: "produce the report",
    producerWorkProducts: [{ title: "report-v1", ref: "/srv/out/report.html" }],
  });
}

describe("workflow rework contract: surgical revision directive", () => {
  it("keeps requiredActions within the runtime-brief render cap (4) and each line within the brief truncation length", () => {
    const contract = build();
    expect(contract.requiredActions.length).toBeLessThanOrEqual(BRIEF_MAX_ACTIONS);
    for (const action of contract.requiredActions) {
      expect(action.length).toBeLessThanOrEqual(BRIEF_LINE_TRUNCATE);
    }
  });

  it("places the surgical directive early enough for the compact brief header (index <= 2)", () => {
    const contract = build();
    const index = contract.requiredActions.findIndex((action) => action.includes(SURGICAL_MARKER));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(BRIEF_COMPACT_MAX_ACTIONS);
  });

  it("the surgical directive says: edit prior products in place, only flagged + directly affected parts, no rewrite from scratch", () => {
    const contract = build();
    const surgical = contract.requiredActions.find((action) => action.includes(SURGICAL_MARKER));
    expect(surgical).toBeDefined();
    expect(surgical!).toMatch(/prior registered work products/i);
    expect(surgical!).toMatch(/only what the QA feedback flags/i);
    expect(surgical!).toMatch(/directly affect/i);
    expect(surgical!).toMatch(/unaffected content/i);
    expect(surgical!).toMatch(/not regenerate|no rewrite|do not rewrite|without rewriting from scratch/i);
  });

  it("preserves the non-regression required actions (primary instruction, no premature close, verify existing artifact)", () => {
    const contract = build();
    expect(contract.requiredActions.some((a) => /primary instruction for the current run/i.test(a))).toBe(true);
    expect(contract.requiredActions.some((a) => /Do not close as already complete/i.test(a))).toBe(true);
    expect(contract.requiredActions.some((a) => /verify it satisfies the feedback and register/i.test(a))).toBe(true);
  });

  it("renders a full surgical-revision section in the producer issue comment (untruncated guidance)", () => {
    const comment = renderWorkflowReworkComment(build());
    expect(comment).toContain("### How to apply this rework (surgical revision)");
    expect(comment).toMatch(/load the current artifact and edit it/i);
    expect(comment).toMatch(/do not rebuild the deliverable from scratch/i);
    expect(comment).toMatch(/parts those changes directly affect/i);
    expect(comment).toMatch(/summaries.*table of contents.*cross-references|summaries.*TOC.*cross-references/is);
    expect(comment).toMatch(/Keep unaffected sections exactly as they are/i);
    expect(comment).toMatch(/wholesale rewrite that discards accepted content is itself a rework failure/i);
  });

  it("round-trips the surgical directive through readWorkflowReworkContract", () => {
    const contract = build();
    const restored = readWorkflowReworkContract(JSON.parse(JSON.stringify(contract)));
    expect(restored).not.toBeNull();
    expect(restored!.requiredActions).toEqual(contract.requiredActions);
    expect(restored!.requiredActions.some((a) => a.includes(SURGICAL_MARKER))).toBe(true);
  });
});

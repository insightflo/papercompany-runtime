// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionDecisionLogPanel } from "./MissionDecisionLogPanel";

let scenario: "populated" | "empty" | "loading" | "error" = "populated";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => {
    if (scenario === "loading") {
      return { data: undefined, isLoading: true, error: null };
    }

    if (scenario === "error") {
      return { data: undefined, isLoading: false, error: new Error("decision log unavailable") };
    }

    if (scenario === "empty") {
      return {
        data: {
          missionId: "mission-1",
          revision: 0,
          updatedAt: null,
          decisions: [],
          stateMarkdown: "",
        },
        isLoading: false,
        error: null,
      };
    }

    return {
      data: {
        missionId: "mission-1",
        revision: 3,
        updatedAt: "2026-09-05T01:00:00.000Z",
        decisions: [
          {
            id: "D-1",
            summary: "Docker postgres for dev",
            status: "retired",
            supersedes: null,
            handoffId: "h0",
            updatedAt: "2026-09-05T00:00:00.000Z",
          },
          {
            id: "D-2",
            summary: "PGlite everywhere",
            status: "confirmed",
            supersedes: "D-1",
            handoffId: null,
            updatedAt: "2026-09-05T01:00:00.000Z",
            source: "board",
            evidenceRefs: [
              { type: "heartbeat_run", id: "0cf4a1b2c3d4e5f6a7b8" },
              { type: "issue", id: "70d8f2a1-1234-5678" },
            ],
          },
          {
            id: "D-3",
            summary: "Try neon fork",
            status: "under_review",
            supersedes: null,
            handoffId: null,
            updatedAt: "2026-09-05T01:00:00.000Z",
            lastConflictingProposal: {
              from: "agent",
              summary: "Agent wants neon",
              at: "2026-09-05T02:00:00.000Z",
            },
          },
        ],
        stateMarkdown: "# Mission State",
      },
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock("lucide-react", () => ({
  Scale: () => null,
  AlertTriangle: () => null,
}));

import { MissionDecisionLogPanel as Panel } from "./MissionDecisionLogPanel";

function render() {
  return renderToStaticMarkup(<Panel missionId="mission-1" />);
}

describe("MissionDecisionLogPanel", () => {
  it("renders decision records with status, supersedes chains, and provenance", () => {
    scenario = "populated";
    const html = render();

    expect(html).toContain("Mission Decision Log");
    expect(html).toContain("D-1");
    expect(html).toContain("Docker postgres for dev");
    expect(html).toContain("retired");
    expect(html).toContain("D-2");
    expect(html).toContain("PGlite everywhere");
    expect(html).toContain("confirmed");
    expect(html).toContain("supersedes D-1");
    // 근거 참조 칩: D-2 의 evidenceRefs 가 출처 행 뒤에 shortId(8) 로 렌더링된다.
    expect(html).toContain("evidence: heartbeat_run 0cf4a1b2, issue 70d8f2a1");
    // title 속성은 전체 type:id 원문을 보존한다.
    expect(html).toContain(
      'title="heartbeat_run:0cf4a1b2c3d4e5f6a7b8, issue:70d8f2a1-1234-5678"',
    );
    expect(html).toContain("D-3");
    expect(html).toContain("under_review");
    // board 출처 칩: source 가 "board" 인 기록 상태 옆에 board 칩이 렌더링된다.
    expect(html).toContain(">board</span>");
    // 미반영 제안 라인: lastConflictingProposal 이 있으면 출처 행 뒤에 muted 라인이 렌더링된다.
    expect(html).toContain("proposal pending (agent)");
    // 개요 카드: 총 3, 확정 1, 검토 중 1.
    expect(html).toContain("3");
    // stateMarkdown 접기 섹션: 제목 + 마크다운 원문 스니펫.
    expect(html).toContain("Mission state (markdown)");
    expect(html).toContain("# Mission State");
    // board 작성 폼: 섹션 제목 + 4개 필드 라벨 + 제출 버튼.
    expect(html).toContain("Record a decision");
    expect(html).toContain("Decision id");
    expect(html).toContain("Summary");
    expect(html).toContain("Status");
    expect(html).toContain("Supersedes");
    expect(html).toContain("Record decision");
    // Retire 버튼은 confirmed(D-2), under_review(D-3)에만 렌더링된다. retired(D-1) 제외.
    expect(html.split("Retire").length - 1).toBe(2);
    // 헤더 배지: 읽기 전용 → board 작성 가능 기록.
    expect(html).toContain("board-authorable record");
  });

  it("renders an empty state with the producer hint when no decisions exist", () => {
    scenario = "empty";
    const html = render();

    expect(html).toContain("No decisions recorded yet");
    expect(html).toContain("decision-reports");
    // 빈 상태에서도 board 작성 폼과 배지가 보인다.
    expect(html).toContain("Record a decision");
    expect(html).toContain("Record decision");
    expect(html).toContain("board-authorable record");
    // stateMarkdown 이 빈 문자열이면 접기 섹션 자체가 렌더링되지 않는다.
    expect(html).not.toContain("Mission state (markdown)");
  });

  it("renders a loading state", () => {
    scenario = "loading";
    const html = render();

    expect(html).toContain("Loading mission decision log");
  });

  it("surfaces load failures instead of silently hiding the panel", () => {
    scenario = "error";
    const html = render();

    expect(html).toContain("text-destructive");
    expect(html).toContain("decision log unavailable");
  });
});

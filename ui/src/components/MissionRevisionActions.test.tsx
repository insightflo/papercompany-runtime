/** @vitest-environment jsdom */
// [purpose] MissionRevisionActions(수정 요청 → 새 미션 + 이 실행 이어서 진행)의 마운트 동작 검증과
//   MissionDetail 페이지가 실제 컴포넌트를 마운트하는지 소스 수준 단정(페이지 전체 테스트 재작성 없음).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MissionRevisionActions } from "./MissionRevisionActions";
import { buildMissionRevisionPrefill } from "../lib/missionRevisionRequest";
import type { MissionWorkflowRun } from "../api/missions";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function runFixture(): MissionWorkflowRun {
  return {
    id: "run-1", workflowId: "wf-1", companyId: COMPANY_ID, missionId: "mission-1",
    status: "completed", triggeredBy: "mission", startedAt: null, completedAt: null,
    createdAt: "2026-09-07T00:00:00.000Z", workflowName: "콘텐츠 제작 파이프라인",
    stepRuns: [], steps: [], progress: { totalSteps: 0, pendingSteps: 0, runningSteps: 0, completedSteps: 0, failedSteps: 0, skippedSteps: 0 },
  };
}

const mission = { id: "mission-1", title: "원본 미션", ownerAgentId: "agent-1", status: "completed" as const };

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const queryClient = new QueryClient();
  await act(async () => {
    root = createRoot(host!);
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

function actionsNode(overrides: Partial<Parameters<typeof MissionRevisionActions>[0]> = {}): ReactNode {
  return (
    <MissionRevisionActions
      companyId={COMPANY_ID}
      mission={mission}
      workflowRuns={[runFixture()]}
      origin="http://localhost:3100"
      issuePrefix="gazua"
      onNewMission={vi.fn()}
      {...overrides}
    />
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  host = null;
  root = null;
});

describe("MissionRevisionActions", () => {
  it("keeps the new-mission revision action and calls the prefill callback", async () => {
    const onNewMission = vi.fn();
    await mount(actionsNode({ onNewMission }));
    const expected = buildMissionRevisionPrefill({
      mission: { id: mission.id, title: mission.title, ownerAgentId: mission.ownerAgentId },
      workflowRuns: [runFixture()],
      origin: "http://localhost:3100",
      issuePrefix: "gazua",
    });
    await act(async () => { button("새 미션으로 수정").click(); });
    expect(onNewMission).toHaveBeenCalledTimes(1);
    expect(onNewMission).toHaveBeenCalledWith(expected);
  });

  it("disables resume entry only when company or workflow runs are missing", async () => {
    await mount(actionsNode({ workflowRuns: [], companyId: COMPANY_ID }));
    expect(button("이 실행 이어서 진행").disabled).toBe(true);
    await act(async () => { root?.unmount(); });
    host?.remove();
    await mount(actionsNode({ companyId: null, workflowRuns: [runFixture()] }));
    expect(button("이 실행 이어서 진행").disabled).toBe(true);
    await act(async () => { root?.unmount(); });
    host?.remove();
    await mount(actionsNode({ companyId: COMPANY_ID, workflowRuns: [runFixture()] }));
    expect(button("이 실행 이어서 진행").disabled).toBe(false);
  });

  it("opens the real resume dialog from '이 실행 이어서 진행'", async () => {
    await mount(actionsNode());
    await act(async () => { button("이 실행 이어서 진행").click(); });
    expect(document.body.textContent).toContain("재개할 실행");
    expect(document.body.textContent).toContain("재개 범위 확인");
  });
});

function readDetailSource(): string {
  // vitest 실행 위치(루트/패키지)에 관계없이 페이지 소스를 읽는다.
  for (const candidate of ["ui/src/pages/MissionDetail.tsx", "src/pages/MissionDetail.tsx"]) {
    try {
      return readFileSync(path.resolve(process.cwd(), candidate), "utf8");
    } catch {
      // 다음 후보
    }
  }
  throw new Error("MissionDetail.tsx source not found");
}

describe("MissionDetail real component wiring (source assertion)", () => {
  const detailSource = readDetailSource();

  it("mounts MissionRevisionActions and dropped the legacy inline revision button", () => {
    expect(detailSource).toContain('from "../components/MissionRevisionActions"');
    expect(detailSource).toContain("<MissionRevisionActions");
    expect(detailSource).not.toContain("buildMissionRevisionPrefill");
    expect(detailSource).not.toContain("RotateCcw");
    // 기존 인라인 버튼 라벨('수정 요청')은 컴포넌트로 이동·개명되었다('새 미션으로 수정', 컴포넌트 소스에서 검증).
    expect(detailSource).not.toContain("/> 수정 요청");
  });

  it("shrank the legacy page (was 639 lines before this change)", () => {
    const lineCount = detailSource.split("\n").length;
    expect(lineCount).toBeLessThan(639);
  });
});

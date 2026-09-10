// ui/src/components/mission-resume-dialog-test-harness.tsx
//
// [purpose] MissionResumeDialog 계열 테스트 공용 하니스 — jsdom 마운트/상호작용 조작과
//   HTTP 경계(fetch) 스텁, fixture를 한곳에 모은다. 컴포넌트·api client·React Query·Radix는 실물을 쓴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MissionResumeDialog } from "./MissionResumeDialog";
import type { MissionWorkflowRun, MissionWorkflowStep } from "../api/missions";
import type { ResumePreview } from "@paperclipai/shared/types/workflow-resume";

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
export const MISSION_ID = "22222222-2222-4222-8222-222222222222";
export const RUN_ID = "33333333-3333-4333-8333-333333333333";
export const STEP_A = "step-a";
export const STEP_B = "step-b";
export const REASON = "중단된 지점부터 이어서 진행합니다.";
export const RESUME_NOTE = "완료된 작업은 보존하며, 필요한 게시 승인은 별도로 진행합니다.";

export interface StubResponse {
  status: number;
  body: unknown;
}
export type RouteHandler = (url: string, init: RequestInit | undefined) => Promise<StubResponse>;

export const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const result = await route(url, init);
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.body,
  } as Response;
});

/** 각 테스트가 시나리오별 라우터를 주입한다(유일한 스텁 지점 — fetch 경계). */
export let route: RouteHandler = async () => ({ status: 500, body: { error: "route not configured" } });
export function setRoute(next: RouteHandler) {
  route = next;
}

export function stepFixture(stepId: string, name: string, status: MissionWorkflowStep["status"] = "completed"): MissionWorkflowStep {
  return {
    stepId, name, type: "agent", agentId: "agent-1", dependencies: [], description: null,
    toolNames: [], knowledgeBaseIds: [], status, issueId: null, issue: null, workProducts: [],
    startedAt: null, completedAt: null,
  };
}

export function runFixture(status: MissionWorkflowRun["status"] = "completed"): MissionWorkflowRun {
  return {
    id: RUN_ID, workflowId: "wf-1", companyId: COMPANY_ID, missionId: MISSION_ID, status,
    triggeredBy: "mission", startedAt: null, completedAt: null, createdAt: "2026-09-07T00:00:00.000Z",
    workflowName: "콘텐츠 제작 파이프라인", stepRuns: [],
    steps: [stepFixture(STEP_A, "초안 작성"), stepFixture(STEP_B, "나레이션 생성")],
    progress: { totalSteps: 2, pendingSteps: 0, runningSteps: 0, completedSteps: 2, failedSteps: 0, skippedSteps: 0 },
  };
}

export function previewFixture(overrides: Partial<ResumePreview> = {}): ResumePreview {
  return {
    schemaVersion: 1, companyId: COMPANY_ID, missionId: MISSION_ID, workflowRunId: RUN_ID,
    startStepId: STEP_A, eligible: true, blockers: [],
    affected: [{ stepId: STEP_B, name: "나레이션 생성", action: "execute" }],
    preserved: [{ stepId: STEP_A, name: "초안 작성" }], evidence: [],
    generation: "possible", budget: "verified", approvals: [],
    snapshotToken: "snapshot-token-1", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

export function requestViewFixture(state: "pending_delivery" | "accepted") {
  return {
    id: "req-1", workflowRunId: RUN_ID, startStepId: STEP_A, state,
    acceptanceId: state === "accepted" ? "acc-1" : null, code: null, createdAt: "2026-09-07T01:00:00.000Z",
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
let dialogProps: { open: boolean } | null = null;

function dialogNode(props: { open: boolean }): ReactNode {
  return (
    <MissionResumeDialog
      open={props.open}
      onOpenChange={(next) => { dialogProps = { open: next }; }}
      companyId={COMPANY_ID}
      missionId={MISSION_ID}
      missionTitle="원본 미션"
      workflowRuns={[runFixture()]}
    />
  );
}

export async function rerender() {
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient!}>{dialogNode(dialogProps!)}</QueryClientProvider>);
  });
}

export function setDialogOpen(open: boolean) {
  dialogProps = { open };
}

export async function mountDialog() {
  host = document.createElement("div");
  document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dialogProps = { open: true };
  await act(async () => {
    root = createRoot(host!);
    root.render(<QueryClientProvider client={queryClient!}>{dialogNode(dialogProps!)}</QueryClientProvider>);
  });
}

export async function flush() {
  await act(async () => { await Promise.resolve(); });
}

/** React Query의 비동기 fetch→상태 갱사슬을 act 안에서 짧게 폴링해 기다린다. */
export async function waitFor(predicate: () => boolean, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("waitFor timed out");
}

export async function click(buttonEl: HTMLButtonElement) {
  await act(async () => {
    buttonEl.click();
    await Promise.resolve();
  });
  await flush();
}

export function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

export function selectOption(id: string, value: string) {
  const el = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!el) throw new Error(`select not found: ${id}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function typeReason(text: string) {
  const el = document.querySelector<HTMLTextAreaElement>("#mission-resume-reason");
  if (!el) throw new Error("reason textarea not found");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function selectAndPreview(stepId = STEP_A) {
  selectOption("mission-resume-run", RUN_ID);
  selectOption("mission-resume-step", stepId);
  await click(button("재개 범위 확인"));
}

export function posts(): Array<{ url: string; body: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));
}

export function text(): string {
  return document.body.textContent ?? "";
}

export function stubFetch() {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
}

export async function cleanup() {
  await act(async () => { root?.unmount(); });
  queryClient?.clear();
  host?.remove();
  host = null;
  root = null;
  queryClient = null;
  dialogProps = null;
  vi.unstubAllGlobals();
}

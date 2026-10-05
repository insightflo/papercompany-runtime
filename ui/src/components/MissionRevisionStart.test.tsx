/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MissionRevisionStart } from "./MissionRevisionStart";
import { api } from "../api/client";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("../api/client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.resetAllMocks(); });
async function mount() {
  vi.mocked(api.get).mockResolvedValue({ workflowDefinitionId: "wf", sourceMissionId: "source", sourceWorkflowRunId: "run",
    candidates: [{ stepId: "new", sourceStepId: "old", name: "완료된 보고서", dependencies: [] }] });
  vi.mocked(api.post).mockResolvedValue({ runId: "new-run" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MissionRevisionStart missionId="revision" onStarted={() => {}} /></QueryClientProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}
it("offers explicit fresh start and checked source mapping through existing trigger", async () => {
  await mount();
  expect(host.textContent).toContain("old");
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
  await act(async () => { button("재사용 없이").click(); });
  expect(api.post).toHaveBeenLastCalledWith("/workflows/wf/runs", { missionId: "revision" });
  await act(async () => { host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(); });
  await act(async () => { button("선택한 결과").click(); });
  expect(api.post).toHaveBeenLastCalledWith("/workflows/wf/runs", { missionId: "revision",
    seedFromRun: { sourceWorkflowRunId: "run", stepIds: ["new"] } });
});
it("surfaces rejected start without claiming execution", async () => {
  await mount(); vi.mocked(api.post).mockRejectedValue(new Error("mission_revision_repeat_failure"));
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent?.includes("재사용 없이"))!.click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(host.textContent).toContain("mission_revision_repeat_failure");
});
it("renders per-unit capability-gap blocked reason as display-only status", async () => {
  vi.mocked(api.get).mockResolvedValue({ workflowDefinitionId: "wf", sourceMissionId: "source", sourceWorkflowRunId: "run",
    candidates: [{ stepId: "new", sourceStepId: "old", name: "완료된 보고서", dependencies: [] }],
    blockedUnits: [{ unitId: "publishBlog", label: "블로그 발행", toolName: "tistory-publish", code: "mission_revision_capability_gap",
      message: "차단 단위 블로그 발행 의 필수 결과(blog-published) 에 필요한 기능 blog_publish 을(를) 실행 도구 tistory-publish 이(가) 제공하지 않습니다." }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MissionRevisionStart missionId="revision" onStarted={() => {}} /></QueryClientProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(host.textContent).toContain("블로그 발행");
  expect(host.textContent).toContain("tistory-publish");
  expect(host.textContent).toContain("mission_revision_capability_gap");
  expect(host.textContent).toContain("미해결");
  expect(host.textContent).toContain("재사용 후보"); // 기존 후보 데이터의 재사용 상태 표시
  expect(host.querySelectorAll("button")).toHaveLength(2); // 표시 전용 — 새 상호작용 없음
});

/** @vitest-environment jsdom */
// [purpose] MissionResumeDialog 핵심 흐름 — 정확한 범위의 preview 요청(인코딩 포함), stale 정리,
//   정확한 본문의 POST + 요청 readback, 다시 열기 정리, 이름/상태 표시. HTTP 경계(fetch)만 스텁.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPANY_ID,
  MISSION_ID,
  REASON,
  RESUME_NOTE,
  RUN_ID,
  STEP_A,
  cleanup,
  button,
  click,
  fetchMock,
  flush,
  mountDialog,
  posts,
  waitFor,
  previewFixture,
  requestViewFixture,
  rerender,
  selectAndPreview,
  selectOption,
  setDialogOpen,
  setRoute,
  stubFetch,
  text,
  typeReason,
} from "./mission-resume-dialog-test-harness";

beforeEach(stubFetch);

afterEach(cleanup);

describe("MissionResumeDialog — core flow", () => {
  it("requests the preview for the exact selected run+step with encoded path and query", async () => {
    setRoute(async () => ({ status: 200, body: previewFixture() }));
    await mountDialog();
    selectOption("mission-resume-run", RUN_ID);
    selectOption("mission-resume-step", STEP_A);
    await click(button("재개 범위 확인"));

    const expectedQuery = new URLSearchParams({ workflowRunId: RUN_ID, startStepId: STEP_A }).toString();
    const expectedUrl = `/api/companies/${encodeURIComponent(COMPANY_ID)}/missions/${encodeURIComponent(MISSION_ID)}/workflow-resume-preview?${expectedQuery}`;
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toBe(expectedUrl);
    await flush();
    expect(text()).toContain("나레이션 생성");
  });

  it("clears a stale preview when the scope selection changes and blocks a stale POST", async () => {
    setRoute(async (url) => {
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture() };
      throw new Error(`unexpected: ${url}`);
    });
    await mountDialog();
    await selectAndPreview(STEP_A);
    expect(text()).toContain("나레이션 생성");
    expect(text()).toContain("초안 작성");

    typeReason(REASON);
    selectOption("mission-resume-step", "step-b");
    await flush();
    expect(text()).not.toContain("재개 범위 스냅샷");
    expect(text()).toContain("실행과 단계를 선택하고 재개 범위를 확인하세요.");

    await click(button("이 지점부터 재개"));
    expect(posts()).toHaveLength(0);
  });

  it("POSTs the exact frozen scope/token/reason body once and reads the request back", async () => {
    const seen: string[] = [];
    setRoute(async (url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture() };
      if (init?.method === "POST" && url.endsWith("/workflow-resume-requests")) {
        return { status: 202, body: requestViewFixture("pending_delivery") };
      }
      if (url.endsWith("/workflow-resume-requests/req-1")) return { status: 200, body: requestViewFixture("accepted") };
      throw new Error(`unexpected: ${init?.method} ${url}`);
    });
    await mountDialog();
    await selectAndPreview(STEP_A);
    typeReason(REASON);
    await click(button("이 지점부터 재개"));

    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url.endsWith("/workflow-resume-requests")).toBe(true);
    expect(sent[0].body).toEqual({
      schemaVersion: 1,
      mode: "resume_from_step",
      companyId: COMPANY_ID,
      missionId: MISSION_ID,
      workflowRunId: RUN_ID,
      startStepId: STEP_A,
      snapshotToken: "snapshot-token-1",
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      reason: REASON,
    });
    const readbackUrl = `/api/companies/${encodeURIComponent(COMPANY_ID)}/missions/${encodeURIComponent(MISSION_ID)}/workflow-resume-requests/req-1`;
    expect(seen).toContain(`GET ${readbackUrl}`);
    await waitFor(() => text().includes("재개 요청이 실행기에 전달되었습니다"));
  });

  it("reopening the dialog clears prior preview, request state, and reason", async () => {
    setRoute(async (url, init) => {
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture() };
      if (init?.method === "POST") return { status: 202, body: requestViewFixture("pending_delivery") };
      if (url.endsWith("/workflow-resume-requests/req-1")) return { status: 200, body: requestViewFixture("accepted") };
      throw new Error(`unexpected: ${init?.method} ${url}`);
    });
    await mountDialog();
    await selectAndPreview(STEP_A);
    typeReason(REASON);
    await click(button("이 지점부터 재개"));
    await waitFor(() => text().includes("재개 요청이 실행기에 전달되었습니다"));

    // close → reopen: 이전 preview/요청/사유가 남지 않는다.
    setDialogOpen(false);
    await rerender();
    setDialogOpen(true);
    await rerender();
    expect(text()).not.toContain("재개 범위 스냅샷");
    expect(text()).not.toContain("재개 요청이 실행기에 전달되었습니다");
    expect(text()).toContain("실행과 단계를 선택하고 재개 범위를 확인하세요.");
    expect(document.querySelector<HTMLTextAreaElement>("#mission-resume-reason")?.value).toBe("");
    expect(button("이 지점부터 재개").disabled).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it("shows the run and step names with status, and the generic preservation note", async () => {
    setRoute(async () => ({ status: 200, body: previewFixture({ approvals: [{ stepId: "step-pub", required: true }] }) }));
    await mountDialog();
    selectOption("mission-resume-run", RUN_ID);
    const runOptions = [...document.querySelectorAll<HTMLSelectElement>("#mission-resume-run option")].map((o) => o.textContent);
    expect(runOptions.join("\n")).toContain("콘텐츠 제작 파이프라인 (completed)");
    selectOption("mission-resume-step", STEP_A);
    const stepOptions = [...document.querySelectorAll<HTMLSelectElement>("#mission-resume-step option")].map((o) => o.textContent);
    expect(stepOptions.join("\n")).toContain("초안 작성 (completed)");
    expect(text()).toContain(RESUME_NOTE);
    await click(button("재개 범위 확인"));
    expect(text()).toContain("필수 승인: 1개 단계에 필요");
    expect(text()).toContain("예산 확인 완료");
  });
});

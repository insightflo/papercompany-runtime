/** @vitest-environment jsdom */
// [purpose] MissionResumeDialog 전달 방어 시나리오 — 차단/만료 스냅샷은 POST 불가,
//   불확실한 네트워크 오류는 동일 본문/키 명시 재시도, API 거절(409/422)은 표시만. HTTP 경계(fetch)만 스텁.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STEP_A,
  STEP_B,
  cleanup,
  button,
  click,
  mountDialog,
  posts,
  previewFixture,
  requestViewFixture,
  selectAndPreview,
  waitFor,
  selectOption,
  setRoute,
  stubFetch,
  text,
  typeReason,
} from "./mission-resume-dialog-test-harness";

beforeEach(stubFetch);

afterEach(cleanup);

describe("MissionResumeDialog — delivery guards", () => {
  it("cannot POST when the preview is blocked or the snapshot is expired", async () => {
    setRoute(async () => ({
      status: 200,
      body: previewFixture({
        eligible: false,
        snapshotToken: null,
        blockers: [{ code: "executed_step", message: "이미 실행된 단계는 재개 범위에 포함할 수 없습니다." }],
      }),
    }));
    await mountDialog();
    await selectAndPreview(STEP_A);
    expect(text()).toContain("이미 실행된 단계는 재개 범위에 포함할 수 없습니다.");
    expect(text()).toContain("executed_step");
    typeReason("중단된 지점부터 이어서 진행합니다.");
    expect(button("이 지점부터 재개").disabled).toBe(true);
    await click(button("이 지점부터 재개"));
    expect(posts()).toHaveLength(0);

    setRoute(async () => ({
      status: 200,
      body: previewFixture({ startStepId: STEP_B, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    }));
    selectOption("mission-resume-step", STEP_B);
    await click(button("재개 범위 확인"));
    expect(text()).toContain("만료");
    typeReason("중단된 지점부터 이어서 진행합니다.");
    expect(button("이 지점부터 재개").disabled).toBe(true);
    await click(button("이 지점부터 재개"));
    expect(posts()).toHaveLength(0);
  });

  it("retries an uncertain network failure with the exact same body and idempotency key", async () => {
    let postCount = 0;
    const bodies: Array<Record<string, unknown>> = [];
    setRoute(async (url, init) => {
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture() };
      if (init?.method === "POST") {
        postCount += 1;
        bodies.push(JSON.parse(String(init.body)));
        if (postCount === 1) throw new TypeError("network down");
        return { status: 202, body: requestViewFixture("pending_delivery") };
      }
      if (url.endsWith("/workflow-resume-requests/req-1")) return { status: 200, body: requestViewFixture("accepted") };
      throw new Error(`unexpected: ${init?.method} ${url}`);
    });
    await mountDialog();
    await selectAndPreview(STEP_A);
    typeReason("중단된 지점부터 이어서 진행합니다.");
    await click(button("이 지점부터 재개"));
    expect(text()).toContain("네트워크 오류");
    expect(text()).toContain("같은 요청 다시 보내기");

    await click(button("같은 요청 다시 보내기"));
    expect(postCount).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
    await waitFor(() => text().includes("재개 요청이 실행기에 전달되었습니다"));
  });

  it("displays an API rejection (409/422) instead of swallowing it", async () => {
    setRoute(async (url, init) => {
      if (url.includes("/workflow-resume-preview?")) return { status: 200, body: previewFixture() };
      if (init?.method === "POST") return { status: 409, body: { error: "스냅샷이 만료되었거나 실행 상태가 변경되었습니다." } };
      throw new Error(`unexpected: ${init?.method} ${url}`);
    });
    await mountDialog();
    await selectAndPreview(STEP_A);
    typeReason("중단된 지점부터 이어서 진행합니다.");
    await click(button("이 지점부터 재개"));
    expect(text()).toContain("스냅샷이 만료되었거나 실행 상태가 변경되었습니다.");
    expect(text()).toContain("409");
    expect(posts()).toHaveLength(1);
  });
});

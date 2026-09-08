// shorts whole-sketch LATE-READER race regressions (production 아님). 느린 resolveReview /
// deliver decision-read 가 다른 deliver 의 upload 완료 뒤에 재개될 때 저장된 uploadAttempted
// 센티널과 uploadResult 를 지우지 못함(재전송 없음)을 증명한다. sleep 없는 제어된 promise
// 게이트와 로컬 fake 포트만 사용한다(단일 프로세스 로컬 메모리 store 순서 증명일 뿐이다).
import { expect, it } from "vitest";
import {
  SYNTHETIC_MANIFEST_SHA256, SYNTHETIC_RUN_ID, SYNTHETIC_SCOPE, SYNTHETIC_VIDEO_BYTES,
  SYNTHETIC_VIDEO_SHA256, createLocalSketchFakes,
} from "./helpers/shorts-local-sketch-fixture.js";
import { approve, makeCoordinator, runPythonIntake, sketch } from "./helpers/shorts-local-sketch-test-setup.js";

const VIDEO_OBJECT = `shorts/runs/${SYNTHETIC_RUN_ID}/stage8/final.mp4`;
type Fakes = ReturnType<typeof sketch>["fakes"];
type Coordinator = ReturnType<typeof sketch>["coordinator"];
type UploadResult = { videoId: string; channelId: string };

/** shorts-youtube 만 가로챈다. inner 를 호출하면 fake 호출 계수가 유지된다. */
function wrapYoutube(fakes: Fakes, replace: (inner: () => Promise<unknown>) => Promise<unknown>): void {
  const tools = fakes.ports.tools;
  const bound = tools.invokeTool.bind(tools);
  tools.invokeTool = async (req) =>
    req.toolName === "shorts-youtube" ? replace(() => bound(req)) as never : bound(req);
}

/** 설치 후 (skip+1)번째 readDecision 부터 게이트로 막는다. arrived 는 느린 reader 의 게이트
 *  도착을 알리고 release() 로 재개한다 — sleep 없이 정확한 재개 순서를 만든다. */
function gateReadDecision(fakes: Fakes, skip = 0) {
  const decisions = fakes.ports.decisions;
  const original = decisions.readDecision.bind(decisions);
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  decisions.readDecision = async (req) => {
    const result = await original(req);
    if (++reads === skip + 1) { arrive(); await gate; }
    return result;
  };
  return { arrived, release };
}

/** clips-gate 전체 흐름을 사람 승인 대기(final-review)까지 실행하고 구조화 승인을 기록한다. */
async function flowAwaitingApproval(options?: { youtubeChannelId?: string }) {
  const intake = runPythonIntake();
  const { fakes, coordinator } = sketch(intake, options);
  const requestId = (await coordinator.apply(coordinator.preview("clips-gate").previewId)).requestId;
  expect((await coordinator.deliver(requestId)).waitingHumanReview).toBe(true);
  approve(fakes);
  return { fakes, coordinator, requestId };
}

/** 재개 후 저장 상태 단정: 성공 결과 보존 + 반복 deliver/resolveReview 재전송 없음. */
async function expectPreservedSuccess(
  fakes: Fakes, coordinator: Coordinator, requestId: string, result: UploadResult,
) {
  const state = fakes.store.getDelivery(requestId);
  expect(state?.uploadAttempted).toBe(true);
  expect(state?.uploadResult).toEqual({ ...result, artifact: "youtube-publish.v1.json" });
  expect(state?.stage).toBe("published");
  expect((await coordinator.deliver(requestId)).uploadResult).toEqual(result);
  expect((await coordinator.resolveReview(requestId)).uploadResult).toEqual(result);
  expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
}

/** 재개 후 저장 상태 단정: reconciliation 센티널 보존(attempted true, 결과 없음) + 재전송 없음. */
async function expectPreservedSentinel(
  fakes: Fakes, coordinator: Coordinator, requestId: string, sends: () => number,
) {
  const state = fakes.store.getDelivery(requestId);
  expect(state?.uploadAttempted).toBe(true);
  expect(state?.uploadResult).toBeNull();
  expect(state?.stage).toBe("publish");
  expect(await coordinator.deliver(requestId))
    .toMatchObject({ stage: "publish", waitingReconciliation: true });
  expect(await coordinator.resolveReview(requestId))
    .toMatchObject({ stage: "publish", waitingReconciliation: true });
  expect(sends()).toBe(1);
}

it("delayed resolveReview resuming after a successful deliver preserves the upload", async () => {
  const { fakes, coordinator, requestId } = await flowAwaitingApproval();
  const g = gateReadDecision(fakes);
  const slow = coordinator.resolveReview(requestId);
  await g.arrived;
  const published = await coordinator.deliver(requestId);
  expect(published).toMatchObject({ stage: "published" });
  expect(published.uploadResult).toEqual({ videoId: "local-sketch-video-1", channelId: "local-sketch-channel" });
  g.release(); // 느린 reader 재개 — 자신의 오래된 제안이 아니라 저장된 성공 상태를 반환해야 한다.
  expect(await slow).toMatchObject({ stage: "published", uploadResult: published.uploadResult });
  await expectPreservedSuccess(fakes, coordinator, requestId, published.uploadResult!);
});

it("delayed deliver decision read resuming after another deliver preserves the upload", async () => {
  const { fakes, coordinator, requestId } = await flowAwaitingApproval();
  const g = gateReadDecision(fakes);
  const slow = coordinator.deliver(requestId);
  await g.arrived;
  const published = await coordinator.deliver(requestId);
  expect(published).toMatchObject({ stage: "published" });
  g.release(); // 느린 reader 재개 — 오래된 제안 저장분이 성공 결과를 덮어쓰면 안 된다.
  expect(await slow).toMatchObject({ stage: "published", uploadResult: published.uploadResult });
  await expectPreservedSuccess(fakes, coordinator, requestId, published.uploadResult!);
});

it.each([
  ["resolveReview", "thrown"],
  ["deliver", "thrown"],
  ["resolveReview", "channel mismatch"],
  ["deliver", "channel mismatch"],
] as const)(
  "late %s resuming after a failed upload (%s) preserves the sentinel without resend",
  async (reader, failure) => {
    const options = failure === "channel mismatch"
      ? { youtubeChannelId: "not-the-approved-channel" } : undefined;
    const { fakes, coordinator, requestId } = await flowAwaitingApproval(options);
    let sends = 0;
    if (failure === "thrown") {
      wrapYoutube(fakes, async () => { sends += 1; throw new Error("synthetic upload outage"); });
    }
    const g = gateReadDecision(fakes);
    const slow = reader === "resolveReview"
      ? coordinator.resolveReview(requestId)
      : coordinator.deliver(requestId);
    await g.arrived;
    const other = coordinator.deliver(requestId);
    await expect(other).rejects.toThrow(failure === "thrown" ? /synthetic upload outage/ : /channel_mismatch/);
    g.release();
    // 재개된 느린 reader: 오래된 승인 제안을 저장하지 않고 센티널 조회를 반환하며,
    // 스스로 업로드로 진행하지도 않는다.
    expect(await slow).toMatchObject({ stage: "publish", waitingReconciliation: true, uploadResult: null });
    await expectPreservedSentinel(fakes, coordinator, requestId,
      failure === "thrown" ? () => sends : () => fakes.calls.tools["shorts-youtube"] ?? 0);
  },
);

/** publish 선택 시작 + 이전 결정 문서 — 느린 decision read 가 성공 upload 뒤에 재개된다. */
it("delayed selected-publish decision read resuming after deliver preserves the upload", async () => {
  const intake = runPythonIntake();
  const fakes = createLocalSketchFakes();
  fakes.seedObject(VIDEO_OBJECT, SYNTHETIC_VIDEO_BYTES); // publish 시작은 assemble 을 실행하지 않음
  const decision = await fakes.ports.decisions.createDecision(
    { requestKey: "local-sketch-races-publish", payload: null });
  const predecessors = {
    schema: "shorts.local-sketch-predecessors.v1", mode: "local-sketch",
    scope: { ...SYNTHETIC_SCOPE }, receiptSha256: intake.receiptSha256, clipsGateOk: true,
    assemble: {
      videoObject: VIDEO_OBJECT, bytes: SYNTHETIC_VIDEO_BYTES.length, durationSec: 30,
      manifestSha256: SYNTHETIC_MANIFEST_SHA256, videoSha256: SYNTHETIC_VIDEO_SHA256,
    },
    assembleGateOk: true, decisionId: decision.operatorDecisionId,
  };
  const { coordinator } = makeCoordinator(intake, fakes, { predecessors });
  const requestId = (await coordinator.apply(coordinator.preview("publish").previewId)).requestId;
  expect((await coordinator.deliver(requestId)).waitingHumanReview).toBe(true); // 결정 보류 — 전송 없음
  approve(fakes, "local-sketch-channel", SYNTHETIC_VIDEO_SHA256, decision.operatorDecisionId);
  const g = gateReadDecision(fakes);
  const slow = coordinator.resolveReview(requestId);
  await g.arrived;
  const published = await coordinator.deliver(requestId);
  expect(published).toMatchObject({ stage: "published" });
  g.release(); // 느린 reader 재개 — 오래된 제안 저장분이 성공 결과를 덮어쓰면 안 된다.
  expect(await slow).toMatchObject({ stage: "published", uploadResult: published.uploadResult });
  await expectPreservedSuccess(fakes, coordinator, requestId, published.uploadResult!);
  // 선택 시작 publish — 이전 도구/카드는 어떤 것도 (재)실행되지 않는다.
  for (const tool of ["shorts-clips-verify", "shorts-assemble", "shorts-storage-list", "shorts-publish-card"]) {
    expect(fakes.calls.tools[tool], tool).toBeUndefined();
  }
  expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
});

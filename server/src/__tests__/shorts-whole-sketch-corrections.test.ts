// shorts whole-sketch CORRECTION regressions (production 아님). 부모 확정 결함 4종(재전송 없는
// publish 불확정성, 수락된 시작 step 선택, video bytes 바인딩, 버전 마커) 회귀. 로컬 fake 포트만.
import { describe, expect, it } from "vitest";
import { LOCAL_SKETCH_TOOL_RESULT_SCHEMA } from "../services/workflow/resume/local-sketch-types.js";
import {
  LOCAL_SKETCH_CONDITIONS, SYNTHETIC_MANIFEST_SHA256, SYNTHETIC_RUN_ID, SYNTHETIC_SCOPE,
  SYNTHETIC_VIDEO_BYTES, SYNTHETIC_VIDEO_SHA256, createLocalSketchFakes,
} from "./helpers/shorts-local-sketch-fixture.js";
import { approve, makeCoordinator, runPythonIntake, sketch, type IntakeResult } from "./helpers/shorts-local-sketch-test-setup.js";

const VIDEO_OBJECT = `shorts/runs/${SYNTHETIC_RUN_ID}/stage8/final.mp4`;
type Fakes = ReturnType<typeof sketch>["fakes"];

/** 이후 시작 step 들이 요구하는 합성 선행 증거 문서(로컬 주입 전용). */
function predecessorEvidence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "shorts.local-sketch-predecessors.v1", mode: "local-sketch",
    scope: { ...SYNTHETIC_SCOPE }, receiptSha256: over.__receiptSha256 ?? "",
    clipsGateOk: true,
    assemble: {
      videoObject: VIDEO_OBJECT, bytes: SYNTHETIC_VIDEO_BYTES.length, durationSec: 30,
      manifestSha256: SYNTHETIC_MANIFEST_SHA256, videoSha256: SYNTHETIC_VIDEO_SHA256,
    },
    assembleGateOk: true,
    ...over,
  };
}

/** clips-gate 전체 흐름을 사람 승인 대기까지 실행한다. */
async function flowAwaitingApproval(options?: Record<string, unknown>) {
  const intake = runPythonIntake();
  const { fakes, coordinator } = sketch(intake, options as never);
  const request = await coordinator.apply(coordinator.preview("clips-gate").previewId);
  const waiting = await coordinator.deliver(request.requestId);
  expect(waiting.waitingHumanReview).toBe(true);
  return { intake, fakes, coordinator, requestId: request.requestId };
}

/** 이후 시작 step 조립 — assemble 증거를 쓰는 시작은 synthetic stage8 객체를 미리 주입한다. */
async function acceptedAt(intake: IntakeResult, startStepId: string, evidence: Record<string, unknown> | undefined) {
  const fakes = createLocalSketchFakes();
  if (["assemble-gate", "final-review", "publish"].includes(startStepId)) {
    const stage8 = `shorts/runs/${SYNTHETIC_RUN_ID}/stage8/`;
    fakes.seedObject(`${stage8}final.mp4`, SYNTHETIC_VIDEO_BYTES);
    fakes.seedObject(`${stage8}manifest.json`, new TextEncoder().encode("local-sketch synthetic manifest v1"));
  }
  const { coordinator } = makeCoordinator(intake, fakes, { predecessors: evidence });
  const request = await coordinator.apply(coordinator.preview(startStepId).previewId);
  return { fakes, coordinator, requestId: request.requestId };
}

/** shorts-youtube 만 가로챈다. inner 를 호출하면 fake 호출 계수가 유지된다. */
function wrapYoutube(fakes: Fakes, replace: (inner: () => Promise<unknown>) => Promise<unknown>): void {
  const tools = fakes.ports.tools;
  const bound = tools.invokeTool.bind(tools);
  tools.invokeTool = async (req) =>
    req.toolName === "shorts-youtube" ? replace(() => bound(req)) as never : bound(req);
}

describe("whole-sketch corrections: publish uncertainty never resends", () => {
  it("keeps the attempt sentinel after channel mismatch and never resends", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval(
      { youtubeChannelId: "not-the-approved-channel" });
    approve(fakes);
    await expect(coordinator.deliver(requestId)).rejects.toThrow(/channel_mismatch/);
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
    expect((await coordinator.deliver(requestId)).waitingReconciliation).toBe(true);
    expect((await coordinator.resolveReview(requestId)).waitingReconciliation).toBe(true);
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
  });

  it("keeps the attempt sentinel after a thrown upload and never resends", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes);
    let sends = 0;
    wrapYoutube(fakes, async () => {
      sends += 1;
      throw new Error("synthetic upload outage");
    });
    await expect(coordinator.deliver(requestId)).rejects.toThrow(/synthetic upload outage/);
    expect(sends).toBe(1);
    const again = await coordinator.deliver(requestId);
    expect(again.waitingReconciliation).toBe(true);
    await coordinator.resolveReview(requestId);
    expect(sends).toBe(1);
  });

  it("keeps the attempt sentinel after ok:false and never resends", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes);
    wrapYoutube(fakes, async (inner) => {
      const envelope = await inner() as { schema: string; mode: string; result: Record<string, unknown> };
      return { ...envelope, result: { ...envelope.result, ok: false } };
    });
    await expect(coordinator.deliver(requestId)).rejects.toThrow(/upload_not_ok/);
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
    const again = await coordinator.deliver(requestId);
    expect(again.waitingReconciliation).toBe(true);
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
  });

  it("stores the uploadAttempted sentinel before the send is awaited", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes);
    let during: Record<string, unknown> | null = null;
    wrapYoutube(fakes, async (inner) => {
      during = fakes.store.getDelivery(requestId) as unknown as Record<string, unknown>;
      return inner();
    });
    await coordinator.deliver(requestId);
    expect(during?.uploadAttempted).toBe(true);
    expect(during?.waiting).toBe("reconciliation");
  });

  it("sends at most once for concurrent deliveries of the same request", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes);
    let release: ((value: unknown) => void) | null = null;
    const gate = new Promise((resolve) => (release = resolve));
    let calls = 0;
    wrapYoutube(fakes, async (inner) => {
      calls += 1;
      if (calls === 1) return gate;
      return inner();
    });
    const first = coordinator.deliver(requestId);
    const second = coordinator.deliver(requestId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    release!({ schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: "local-sketch",
      result: { ok: true, video_id: "v1", channel_id: "local-sketch-channel" } });
    const a = await first;
    const b = await second;
    // 정확히 1회 전송: 한쪽은 published, 다른 쪽은 센티널 reconciliation 조회(재전송 없음).
    expect([a.stage, b.stage].sort()).toEqual(["publish", "published"]);
    expect(a.waitingReconciliation || b.waitingReconciliation).toBe(true);
    expect(calls).toBe(1);
    expect((await coordinator.readback(requestId)).stage).toBe("published");
  });
});

describe("whole-sketch corrections: accepted selected start is honored", () => {
  it("publish start with prior decision makes only the upload call after resolve", async () => {
    const intake = runPythonIntake();
    // 결정은 coordinator 조립 전에 같은 fakes 에 준비한다(증거 snapshot 전 id 확정).
    const fakes = createLocalSketchFakes();
    fakes.seedObject(VIDEO_OBJECT, SYNTHETIC_VIDEO_BYTES); // publish 시작은 assemble 을 실행하지 않음
    const decision = await fakes.ports.decisions.createDecision(
      { requestKey: "local-sketch-corrections-publish", payload: null });
    const { coordinator } = makeCoordinator(intake, fakes, { predecessors: predecessorEvidence(
      { __receiptSha256: intake.receiptSha256, decisionId: decision.operatorDecisionId }) });
    const requestId = (await coordinator.apply(coordinator.preview("publish").previewId)).requestId;
    expect(coordinator.preview("publish").affectedStepIds).toEqual(["publish"]);
    // 결정이 보류 중인 동안: publish stage human-review 대기, 업로드 0회.
    const pending = await coordinator.deliver(requestId);
    expect(pending).toMatchObject({ stage: "publish", waitingHumanReview: true });
    expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined();
    // 이후 구조화 승인 resolve → deliver 로 승인을 읽고 1회 전송.
    approve(fakes, "local-sketch-channel", SYNTHETIC_VIDEO_SHA256, decision.operatorDecisionId);
    const done = await coordinator.deliver(requestId);
    expect(done.stage).toBe("published");
    expect(done.uploadResult).toEqual({ videoId: "local-sketch-video-1", channelId: "local-sketch-channel" });
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
    // 영향 집합 [publish] — 이전 도구는 어떤 것도 호출되지 않는다.
    for (const tool of ["shorts-clips-verify", "shorts-assemble", "shorts-storage-list", "shorts-publish-card"]) {
      expect(fakes.calls.tools[tool], tool).toBeUndefined();
    }
    expect(fakes.calls.registrations).toBe(1);
    expect((await coordinator.deliver(requestId)).stage).toBe("published");
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
  });

  it("rejects publish start missing the decision prerequisite before any mutation", async () => {
    const intake = runPythonIntake();
    const { fakes, coordinator } = sketch(intake, undefined, {
      predecessors: predecessorEvidence({ __receiptSha256: intake.receiptSha256, decisionId: undefined }),
    });
    const view = coordinator.preview("publish");
    await expect(coordinator.apply(view.previewId)).rejects.toThrow(/missing_predecessor_evidence/);
    expect(fakes.calls.dispatch).toBe(0);
    expect(fakes.store.getGeneration("publish")).toBe(0);
    expect(fakes.store.getGeneration("flow-clips")).toBe(2);
  });

  it.each([
    ["assemble", { clipsGateOk: true }, ["shorts-clips-verify"]],
    ["assemble-gate", { clipsGateOk: true, assembleGateOk: undefined }, ["shorts-clips-verify", "shorts-assemble"]],
    ["final-review", { clipsGateOk: true }, ["shorts-clips-verify", "shorts-assemble", "shorts-storage-list"]],
    ["clips-blocked", { clipsGateOk: false, assembleGateOk: undefined }, ["shorts-clips-verify"]],
    ["assemble-blocked", { clipsGateOk: true, assembleGateOk: false }, ["shorts-clips-verify", "shorts-assemble", "shorts-storage-list"]],
  ] as const)("later start %s runs none of the already-satisfied earlier tools", async (start, evidenceOver, forbidden) => {
    const intake = runPythonIntake();
    const { fakes, coordinator, requestId } = await acceptedAt(
      intake, start, predecessorEvidence({ __receiptSha256: intake.receiptSha256, ...evidenceOver }),
    );
    const view = await coordinator.deliver(requestId);
    for (const tool of forbidden) expect(fakes.calls.tools[tool], tool).toBeUndefined();
    const expectedBlocked = start === "clips-blocked"
      ? { stage: "clips-gate", branchStepId: "clips-blocked" }
      : start === "assemble-blocked" ? { stage: "assemble-gate", branchStepId: "assemble-blocked" } : null;
    if (expectedBlocked) {
      expect(view.stage).toBe("blocked");
      expect(view.blocked).toEqual(expectedBlocked);
      expect(fakes.calls.tools["shorts-assemble"]).toBeUndefined();
      expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined();
    } else {
      // true 분기로 정상 진행 — 새 review 카드 대기(clips-gate 시작과 같은 종결점).
      expect(view.stage).toBe("final-review");
      expect(view.waitingHumanReview).toBe(true);
    }
  });
});

describe("whole-sketch corrections: approval binds video bytes", () => {
  it("keeps distinct video and manifest digests", () => {
    expect(SYNTHETIC_VIDEO_SHA256).not.toBe(SYNTHETIC_MANIFEST_SHA256);
    for (const digest of [SYNTHETIC_VIDEO_SHA256, SYNTHETIC_MANIFEST_SHA256]) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a manifest-digest approval before any upload", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes, "local-sketch-channel", SYNTHETIC_MANIFEST_SHA256);
    await expect(coordinator.deliver(requestId)).rejects.toThrow(/video_mismatch/);
    expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined();
  });

  it("rejects mutated fake video bytes before any upload", async () => {
    const { fakes, coordinator, requestId } = await flowAwaitingApproval();
    approve(fakes);
    fakes.seedObject(VIDEO_OBJECT, new TextEncoder().encode("mutated synthetic video bytes"));
    await expect(coordinator.deliver(requestId)).rejects.toThrow(/video_mismatch/);
    expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined();
  });

  it("consumes only envelopes flagged with both fixture schema and mode", async () => {
    const { intake, fakes, coordinator, requestId } = await flowAwaitingApproval();
    let seen: Record<string, unknown> | null = null;
    const tools = fakes.ports.tools;
    const bound = tools.invokeTool.bind(tools);
    tools.invokeTool = async (req) => {
      const envelope = await bound(req) as unknown as Record<string, unknown>;
      seen ??= envelope;
      return envelope as never;
    };
    approve(fakes);
    await coordinator.deliver(requestId); // 승인 후 youtube 호출 envelope 관찰
    expect(seen?.schema).toBe("shorts.local-sketch-tool-result.v1");
    expect(seen?.mode).toBe("local-sketch");
    // schema 가 벗겨진 envelope 은 소비하지 않고 고정 라벨로 거절한다.
    const strippedFakes = createLocalSketchFakes();
    const strippedTools = strippedFakes.ports.tools;
    const strippedBound = strippedTools.invokeTool.bind(strippedTools);
    strippedTools.invokeTool = async (req) => {
      const envelope = { ...(await strippedBound(req) as Record<string, unknown>) };
      delete envelope.schema;
      return envelope as never;
    };
    const { coordinator: stripped } = makeCoordinator(intake, strippedFakes);
    const request2 = await stripped.apply(stripped.preview("clips-gate").previewId);
    await expect(stripped.deliver(request2.requestId)).rejects.toThrow(/fixture_envelope_missing/);
    expect(strippedFakes.calls.tools["shorts-youtube"]).toBeUndefined();
  });
});

describe("whole-sketch corrections: explicit version markers and scope binding", () => {
  it("stores schema/mode on the accepted request and delivery state readback", async () => {
    const intake = runPythonIntake();
    const { fakes, coordinator } = sketch(intake);
    const request = await coordinator.apply(coordinator.preview("clips-gate").previewId);
    const storedRequest = fakes.store.getAcceptedRequest(request.previewId);
    expect(storedRequest?.schema).toBe("shorts.local-sketch-request.v1");
    expect(storedRequest?.mode).toBe("local-sketch");
    await coordinator.deliver(request.requestId);
    const state = fakes.store.getDelivery(request.requestId) as unknown as Record<string, unknown>;
    expect(state?.schema).toBe("shorts.local-sketch-state.v1");
    expect(state?.mode).toBe("local-sketch");
    expect(state?.uploadAttempted).toBe(false);
  });

  it("rejects an expectedScope that does not match the receipt scope at construction", () => {
    const intake = runPythonIntake();
    const { fakes } = sketch(intake);
    const build = () => makeCoordinator(intake, fakes, {
      conditions: LOCAL_SKETCH_CONDITIONS, expectedScope: { ...SYNTHETIC_SCOPE, attempt: 2 },
    });
    expect(build).toThrow(/predecessor_scope_mismatch/);
    expect(fakes.calls.registrations).toBe(0);
    expect(fakes.calls.dispatch).toBe(0);
  });

  it("rejects predecessor evidence whose scope or receipt hash mismatches", async () => {
    const intake = runPythonIntake();
    const badScope = predecessorEvidence(
      { __receiptSha256: intake.receiptSha256, scope: { ...SYNTHETIC_SCOPE, attempt: 9 } });
    await expect(acceptedAt(intake, "publish", badScope)).rejects.toThrow(/predecessor_scope_mismatch/);
    const badHash = predecessorEvidence({ __receiptSha256: "f".repeat(64) });
    await expect(acceptedAt(intake, "publish", badHash)).rejects.toThrow(/predecessor_scope_mismatch/);
  });
});

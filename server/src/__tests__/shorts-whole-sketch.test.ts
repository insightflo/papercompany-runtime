// shorts whole-flow LOCAL SKETCH integration test (production 아님).
// 하나의 로컬 명령이 Python 재사용 intake → receipt readback → TS 코디네이터
// preview/apply/deliver → 사람 결정 경계 → upload 결과를 잇는다.
// 포트는 명시적 로컬 fake(helpers/shorts-local-sketch-fixture.ts)이고 그래프/적격성은 실제 구현이다.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalSketchReceipt } from "../services/workflow/resume/local-sketch.js";
import {
  LOCAL_SKETCH_DELIVERY_SCHEMA,
  LOCAL_SKETCH_MODE,
  LOCAL_SKETCH_PREVIEW_SCHEMA,
  LOCAL_SKETCH_RECEIPT_SCHEMA,
  LOCAL_SKETCH_RECEIPT_TITLE,
} from "../services/workflow/resume/local-sketch-types.js";
import {
  SYNTHETIC_CLAIM_ID,
  SYNTHETIC_SCOPE,
  buildFixtureInputDocument,
  localSketchHistories,
} from "./helpers/shorts-local-sketch-fixture.js";
import {
  approve,
  runPythonIntake,
  runSketchBridge,
  sketch,
  tempDir,
} from "./helpers/shorts-local-sketch-test-setup.js";

const AFFECTED: readonly string[] = [
  "assemble",
  "assemble-blocked",
  "assemble-gate",
  "clips-blocked",
  "clips-gate",
  "final-review",
  "publish",
];

describe("shorts whole local sketch", () => {
  it("runs intake → preview → apply → deliver → human approval → publish", async () => {
    const intake = runPythonIntake();
    const { fakes, coordinator, nodes, histories } = sketch(intake);
    // 보존 증명: coordinator 에 실제로 전달한 동일 객체 참조를 가장 이른 preview 전에
    // 직렬화하고, deliver 후 같은 객체를 다시 직렬화해 비교한다(새 사본 비교 금지).
    const before = JSON.stringify({ nodes, histories });

    const view = coordinator.preview("clips-gate");
    expect(view.schema).toBe(LOCAL_SKETCH_PREVIEW_SCHEMA);
    expect(view.mode).toBe(LOCAL_SKETCH_MODE);
    expect(view.affectedStepIds).toEqual(AFFECTED);
    expect(view.blockedSteps).toEqual([]);
    expect(view.preservedProducerStepId).toBe("flow-clips");
    expect(view.outsideStepIds).toEqual(["archive-log"]);
    expect(coordinator.preview("clips-gate").previewId).toBe(view.previewId);

    const request = await coordinator.apply(view.previewId);
    expect(request.generations).toEqual(Object.fromEntries(AFFECTED.map((id) => [id, 1])));
    expect(fakes.calls.dispatch).toBe(1);
    expect(fakes.store.getGeneration("flow-clips")).toBe(2); // producer 무변경
    expect(fakes.store.getGeneration("archive-log")).toBe(0); // outside 무변경
    const replay = await coordinator.apply(view.previewId);
    expect(replay.requestId).toBe(request.requestId);
    expect(fakes.calls.dispatch).toBe(1);
    expect(fakes.store.getGeneration("publish")).toBe(1);
    expect(JSON.stringify({ nodes, histories })).toBe(before);

    const waiting = await coordinator.deliver(request.requestId);
    expect(waiting.stage).toBe("final-review");
    expect(waiting.waitingHumanReview).toBe(true);
    expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined(); // 사람 승인 전 pause
    expect(fakes.calls.tools["shorts-clips-verify"]).toBe(1);
    expect(fakes.calls.tools["shorts-assemble"]).toBe(1);
    expect(fakes.calls.tools["shorts-storage-list"]).toBe(1);
    expect(fakes.calls.tools["shorts-publish-card"]).toBe(1);
    expect(fakes.calls.registrations).toBe(1);
    expect(fakes.registrations[0]?.title).toBe(LOCAL_SKETCH_RECEIPT_TITLE);
    expect(fakes.registrations[0]?.sha256).toBe(intake.receiptSha256);

    expect((await coordinator.deliver(request.requestId)).waitingHumanReview).toBe(true);
    expect(fakes.calls.tools["shorts-publish-card"]).toBe(1);

    approve(fakes);
    const done = await coordinator.deliver(request.requestId);
    expect(done.schema).toBe(LOCAL_SKETCH_DELIVERY_SCHEMA);
    expect(done.stage).toBe("published");
    expect(done.uploadResult).toEqual({ videoId: "local-sketch-video-1", channelId: "local-sketch-channel" });
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
    expect((await coordinator.deliver(request.requestId)).stage).toBe("published");
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
    expect(JSON.stringify({ nodes, histories })).toBe(before);
  });

  it("a false gate records the blocked branch and stops before assembly", async () => {
    const intake = runPythonIntake();
    const { fakes, coordinator } = sketch(intake, { clipsGateOk: false });
    const request = await coordinator.apply(coordinator.preview("clips-gate").previewId);
    const view = await coordinator.deliver(request.requestId);
    expect(view.stage).toBe("blocked");
    expect(view.blocked).toEqual({ stage: "clips-gate", branchStepId: "clips-blocked" });
    expect(fakes.calls.tools["shorts-assemble"]).toBeUndefined();
    expect(fakes.calls.tools["shorts-youtube"]).toBeUndefined();
  });

  it("rejects an upload whose channel mismatches the approved binding", async () => {
    const intake = runPythonIntake();
    const { fakes, coordinator } = sketch(intake, { youtubeChannelId: "not-the-approved-channel" });
    const request = await coordinator.apply(coordinator.preview("clips-gate").previewId);
    await coordinator.deliver(request.requestId);
    approve(fakes);
    await expect(coordinator.deliver(request.requestId)).rejects.toThrow(/channel_mismatch/);
    expect(fakes.calls.tools["shorts-youtube"]).toBe(1);
  });

  it("rejects apply when a reachable step has a per-step eligibility blocker", async () => {
    const intake = runPythonIntake();
    const histories = localSketchHistories().map((history) =>
      history.stepId === "clips-gate" ? { ...history, hasOwner: true } : history);
    const { coordinator } = sketch(intake, undefined, { histories });
    const view = coordinator.preview("clips-gate");
    expect(view.blockedSteps).toEqual([{ stepId: "clips-gate", blocker: "active_work" }]);
    await expect(coordinator.apply(view.previewId)).rejects.toThrow(/blocked_step/);
  });

  it("rejects tampered synthetic intake bytes via the python bridge exit status", () => {
    const dir = tempDir();
    const doc = buildFixtureInputDocument();
    doc.clip_bytes["1"] = Buffer.from("tampered synthetic frame bytes").toString("base64");
    const inputPath = path.join(dir, "input.json");
    writeFileSync(inputPath, JSON.stringify(doc));
    let failed = false;
    try {
      runSketchBridge(inputPath, path.join(dir, "out"));
    } catch (error) {
      failed = true;
      expect((error as { status?: number }).status).not.toBe(0);
    }
    expect(failed).toBe(true);
    expect(() => readFileSync(path.join(dir, "out", "receipt.json"))).toThrow();
  });

  it("receipt parser rejects a document without the fixture schema/mode", () => {
    const bad = new TextEncoder().encode(JSON.stringify({
      schema: "shorts.cu-result.v1",
      mode: LOCAL_SKETCH_MODE,
      scope: SYNTHETIC_SCOPE,
      claim_id: SYNTHETIC_CLAIM_ID,
      clips: [],
      credits: [],
    }));
    expect(() => parseLocalSketchReceipt(bad)).toThrow(/invalid:receipt/);
  });
});

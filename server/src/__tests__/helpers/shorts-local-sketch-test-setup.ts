// [파일 목적] shorts whole-sketch 테스트 공유 셋업 — Python intake 실행, coordinator
//   조립, 사람 결정 승인. 전부 합성 데이터이고 production 마운트/네트워크는 없다.
// [수정시 주의]
//   - O workspace 경로는 SHORTS_OPERATIONS_ROOT 를 먼저 읽는다(LOCAL-SKETCH.md 문서화).
//   - sketch() 는 coordinator 에 실제로 전달한 nodes/histories 참조를 그대로 돌려준다 —
//     보존 증명은 새로 만든 사본이 아니라 전달된 동일 객체로 해야 한다.
//   - approve 는 실제 resolve wire shape(actionId confirm + selection approve)로 fake
//     decision 을 해결하고 구조화 payload machine 필드에 binding digest 를 담는다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  createLocalSketchCoordinator,
  parseLocalSketchReceipt,
} from "../../services/workflow/resume/local-sketch.js";
import {
  LOCAL_SKETCH_MODE,
  LOCAL_SKETCH_RECEIPT_SCHEMA,
} from "../../services/workflow/resume/local-sketch-types.js";
import {
  LOCAL_SKETCH_CONDITIONS,
  PRODUCER_STEP_ID,
  SYNTHETIC_CLAIM_ID,
  SYNTHETIC_SCOPE,
  SYNTHETIC_VIDEO_SHA256,
  buildFixtureInputDocument,
  createLocalSketchFakes,
  localSketchGraph,
  localSketchHistories,
} from "./shorts-local-sketch-fixture.js";

// O workspace 위치: SHORTS_OPERATIONS_ROOT 로버라이드 가능(문서화는
// services/workflow/resume/LOCAL-SKETCH.md). 기본값은 R 구조에서 해석한
// 명시적 sibling workspace 경로다.
const OPERATIONS_ROOT = process.env.SHORTS_OPERATIONS_ROOT
  ?? fileURLToPath(new URL("../../../../../../papercompany-operations/shorts-cu-resume", import.meta.url));
const SKETCH_SCRIPT = path.join(OPERATIONS_ROOT, "scripts", "shorts-flow-runner", "cu_reuse_sketch.py");

/** 배열 argv, shell 없음 — stdlib 전용 로컬 intake 브리지 실행. */
export function runSketchBridge(inputPath: string, outDir: string): void {
  execFileSync("python3", [SKETCH_SCRIPT, "--input", inputPath, "--output-dir", outDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "shorts-whole-sketch-"));
}

export interface IntakeResult {
  dir: string;
  receiptPath: string;
  receiptBytes: Uint8Array;
  receiptSha256: string;
}

export function runPythonIntake(): IntakeResult {
  const dir = tempDir();
  const inputPath = path.join(dir, "input.json");
  writeFileSync(inputPath, JSON.stringify(buildFixtureInputDocument()));
  // 배열 argv, shell 없음. 스크립트는 stdlib 전용 로컬 intake다.
  execFileSync("python3", [SKETCH_SCRIPT, "--input", inputPath, "--output-dir", path.join(dir, "out")]);
  const receiptPath = path.join(dir, "out", "receipt.json");
  const receiptBytes = new Uint8Array(readFileSync(receiptPath));
  const parsed = parseLocalSketchReceipt(receiptBytes);
  expect(parsed.receipt.schema).toBe(LOCAL_SKETCH_RECEIPT_SCHEMA);
  expect(parsed.receipt.mode).toBe(LOCAL_SKETCH_MODE);
  expect(parsed.receipt.scope).toEqual(SYNTHETIC_SCOPE);
  expect(parsed.receipt.claim_id).toBe(SYNTHETIC_CLAIM_ID);
  return { dir, receiptPath, receiptBytes, receiptSha256: parsed.sha256 };
}

export function sketch(
  intake: IntakeResult,
  options?: Parameters<typeof createLocalSketchFakes>[0],
  extra: Record<string, unknown> = {},
) {
  const fakes = createLocalSketchFakes(options);
  return { fakes, ...makeCoordinator(intake, fakes, extra) };
}

/** 주어진 fakes 에 coordinator 를 조립한다 — 결정/객체를 미리 준비한 fakes 재사용용. */
export function makeCoordinator(
  intake: IntakeResult,
  fakes: ReturnType<typeof createLocalSketchFakes>,
  extra: Record<string, unknown> = {},
) {
  const nodes = localSketchGraph();
  const histories = localSketchHistories();
  const coordinator = createLocalSketchCoordinator({
    nodes,
    histories,
    conditions: LOCAL_SKETCH_CONDITIONS,
    producerStepId: PRODUCER_STEP_ID,
    publishRequest: {
      video_title: "local-sketch synthetic short",
      video_description: "synthetic local sketch video",
      privacy: "unlisted",
      presign_url: "https://local-sketch.invalid/presign",
    },
    receipt: { path: intake.receiptPath, bytes: intake.receiptBytes },
    expectedScope: SYNTHETIC_SCOPE,
    store: fakes.store,
    ports: fakes.ports,
    ...extra,
  });
  return { coordinator, nodes, histories };
}

/** 사람 결정 승인: binding digest 는 VIDEO bytes digest(manifest digest 승인은 거절 대상). */
export function approve(
  fakes: ReturnType<typeof createLocalSketchFakes>,
  channelId = "local-sketch-channel",
  bindingSha256: string = SYNTHETIC_VIDEO_SHA256,
  targetId?: string,
): void {
  fakes.resolveDecision(
    { actionId: "confirm", selectedOptionIds: ["approve"], comment: null },
    {
      video_sha256: bindingSha256,
      channel_id: channelId,
      metadata: {
        video_title: "local-sketch synthetic short",
        video_description: "synthetic local sketch video",
        privacy: "unlisted",
      },
    },
    targetId,
  );
}

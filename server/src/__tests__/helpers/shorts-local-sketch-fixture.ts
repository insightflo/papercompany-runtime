/**
 * [파일 목적] shorts whole-flow LOCAL SKETCH 통합 테스트용 합성 fixture + 명시적 로컬 fake.
 *   전부 합성(UUID는 live ID 아님), 자연어 권위 없음, DB/network 없음, 실제 미디어 없음.
 * [수정시 주의] 그래프/이력은 실제 ResumeNode/StepHistory(동결 사본), artifact fake 는 raw
 *   bytes + 실제 SHA, 도구 fake 는 실제 wire 모양 + fixture envelope schema, 결정 fake 는 실제
 *   resolve wire shape 를 보존한다. 승인 binding 은 VIDEO bytes digest(manifest 아님).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  LOCAL_SKETCH_FIXTURE_SCHEMA, LOCAL_SKETCH_MODE, LOCAL_SKETCH_TOOL_RESULT_SCHEMA,
  type LocalSketchCondition, type LocalSketchDecisionPort, type LocalSketchDispatchPort,
  type LocalSketchArtifactPort, type LocalSketchObjectPort, type LocalSketchPreviewView,
  type LocalSketchStateStore, type LocalSketchScope, type LocalSketchToolPort,
} from "../../services/workflow/resume/local-sketch-types.js";
import type { ResumeNode, StepHistory } from "../../services/workflow/resume/types.js";

export const PRODUCER_STEP_ID = "flow-clips";
export const SYNTHETIC_CLAIM_ID = "77777777-7777-4777-8777-777777777777";
export const SYNTHETIC_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
export const SYNTHETIC_ISSUE_ID = "66666666-6666-4666-8666-666666666666";
export const SYNTHETIC_JOB_ID = "11111111-1111-4111-8111-111111111111";
export const SYNTHETIC_MISSION_ID = "33333333-3333-4333-8333-333333333333";
export const SYNTHETIC_RUN_ID = "44444444-4444-4444-8444-444444444444";
export const SYNTHETIC_STEP_RUN_ID = "55555555-5555-4555-8555-555555555555";
export const SYNTHETIC_SPEC_SHA256 = "b".repeat(64);

export const SYNTHETIC_SCOPE: LocalSketchScope = {
  job_id: SYNTHETIC_JOB_ID, company_id: SYNTHETIC_COMPANY_ID, mission_id: SYNTHETIC_MISSION_ID,
  workflow_run_id: SYNTHETIC_RUN_ID, step_run_id: SYNTHETIC_STEP_RUN_ID, step_id: PRODUCER_STEP_ID,
  issue_id: SYNTHETIC_ISSUE_ID, execution_generation: 2, attempt: 1, spec_sha256: SYNTHETIC_SPEC_SHA256,
};

const encoder = new TextEncoder();
const FRAME_BYTES = new Map<number, Uint8Array>([
  [1, encoder.encode("local-sketch synthetic frame 0001")], [2, encoder.encode("local-sketch synthetic frame 0002")],
]);
/** 결정적 synthetic video bytes — manifest text bytes 와 별개 버퍼(서로 다른 digest). */
export const SYNTHETIC_VIDEO_BYTES = encoder.encode("local-sketch synthetic video v1");
export const SYNTHETIC_VIDEO_SHA256 = createHash("sha256").update(SYNTHETIC_VIDEO_BYTES).digest("hex");
export const SYNTHETIC_MANIFEST_SHA256 = createHash("sha256")
  .update(encoder.encode("local-sketch synthetic manifest v1"))
  .digest("hex");

/** Python cu_reuse_sketch.py --input 문서(합성 클립 bytes 는 base64). */
export function buildFixtureInputDocument(): {
  schema: string; mode: string; submission: Record<string, unknown>; clip_bytes: Record<string, string>;
} {
  const clips = [...FRAME_BYTES.keys()].sort((a, b) => a - b).map((frame) => ({
    frame,
    path: `/repo/shots/sc${String(frame).padStart(3, "0")}/frame.png`,
    source_object: `shorts/runs/${SYNTHETIC_RUN_ID}/frames/${String(frame).padStart(4, "0")}.png`,
    source_sha256: "c".repeat(64),
    file_sha256: createHash("sha256").update(FRAME_BYTES.get(frame)!).digest("hex"),
    provenance_record: `prov-shot-${String(frame).padStart(4, "0")}`,
  }));
  const clip_bytes: Record<string, string> = {};
  for (const [frame, bytes] of FRAME_BYTES) clip_bytes[String(frame)] = Buffer.from(bytes).toString("base64");
  return {
    schema: LOCAL_SKETCH_FIXTURE_SCHEMA,
    mode: LOCAL_SKETCH_MODE,
    submission: {
      schema: "shorts.cu-submission.v1",
      scope: { ...SYNTHETIC_SCOPE },
      claim_id: SYNTHETIC_CLAIM_ID,
      clips,
      credits: [{
        event_id: "ev-local-sketch-0001",
        amount: 5,
        evidence_record: "ledger-ev-local-sketch-0001",
      }],
    },
    clip_bytes,
  };
}

function node(id: string, deps: string[] = [], condDeps: string[] = []): ResumeNode {
  return { id, dependencies: [...deps], conditionalDependencies: condDeps.map((stepId) => ({ stepId })) };
}

/** flow-clips producer + 7 downstream(clips-gate…publish) + disconnected archive-log. */
export function localSketchGraph(): ResumeNode[] {
  return deepFreeze([
    node("archive-log"),
    node("assemble", [], ["clips-gate"]),
    node("assemble-blocked", [], ["assemble-gate"]),
    node("assemble-gate", ["assemble"]),
    node("clips-blocked", [], ["clips-gate"]),
    node("clips-gate"),
    node("final-review", [], ["assemble-gate"]),
    node(PRODUCER_STEP_ID),
    node("publish", ["final-review"]),
  ]);
}

export function localSketchHistories(): StepHistory[] {
  return deepFreeze([
    history("archive-log", "completed", "read_only", "control"),
    history("assemble", "skipped", "external", "agent"),
    history("assemble-blocked", "skipped", "external", "agent"),
    history("assemble-gate", "pending", "read_only", "control"),
    history("clips-blocked", "skipped", "external", "agent"),
    history("clips-gate", "failed", "read_only", "control"),
    history("final-review", "pending", "read_only", "control"),
    history(PRODUCER_STEP_ID, "completed", "external", "tool", {
      issueId: SYNTHETIC_ISSUE_ID,
      startedAt: "2026-09-07T00:00:00.000Z",
      hasAttempt: true,
      hasExternalResult: true,
    }),
    history("publish", "pending", "external", "agent"),
  ]);
}

function history(
  stepId: string,
  status: StepHistory["status"],
  effect: StepHistory["effect"],
  kind: StepHistory["kind"],
  over: Partial<StepHistory> = {},
): StepHistory {
  return deepFreeze({
    stepId, status, issueId: null, startedAt: null, executionGeneration: 2,
    hasAttempt: false, hasQueue: false, hasOwner: false, hasExternalResult: false,
    effect, kind, ...over,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const LOCAL_SKETCH_CONDITIONS: LocalSketchCondition[] = deepFreeze([
  { onStepId: "clips-gate", when: "true", stepId: "assemble" },
  { onStepId: "clips-gate", when: "false", stepId: "clips-blocked" },
  { onStepId: "assemble-gate", when: "true", stepId: "final-review" },
  { onStepId: "assemble-gate", when: "false", stepId: "assemble-blocked" },
]);

export interface LocalSketchFakesOptions { clipsGateOk?: boolean; youtubeChannelId?: string; }

export function createLocalSketchFakes(options: LocalSketchFakesOptions = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls = { dispatch: 0, registrations: 0, tools: {} as Record<string, number> };
  const registrations: {
    issueId: string; title: string; path: string; scope: LocalSketchScope; sha256: string;
  }[] = [];
  const decisions: {
    id: string; status: "pending" | "resolved";
    result: { actionId: string; outcome: string; selectedOptionIds: string[]; comment: string | null } | null;
    payload: Record<string, unknown> | null;
  }[] = [];

  const artifacts: LocalSketchArtifactPort = {
    async registerArtifact(registration) {
      calls.registrations += 1;
      registrations.push({ ...registration });
      return { artifactId: `local-sketch-artifact-${calls.registrations}` };
    },
    async readArtifact(path) {
      const bytes = new Uint8Array(readFileSync(path)); // 실제 raw bytes + 실제 SHA
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  };

  /** synthetic object bytes 읽기 전용 포트 — 누락 객체는 고정 에러. */
  const objectsPort: LocalSketchObjectPort = {
    async readObject({ object }) {
      const bytes = objects.get(object);
      if (!bytes) throw new Error("object_missing");
      return bytes;
    },
  };

  const dispatch: LocalSketchDispatchPort = {
    async dispatchResume(request) {
      calls.dispatch += 1;
      return { accepted: true };
    },
  };

  const tools: LocalSketchToolPort = {
    async invokeTool({ toolName, parameters }) {
      calls.tools[toolName] = (calls.tools[toolName] ?? 0) + 1;
      const runId = String(parameters.run_id ?? SYNTHETIC_RUN_ID);
      const stage8 = `shorts/runs/${runId}/stage8/`;
      if (toolName === "shorts-clips-verify") {
        return { schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: LOCAL_SKETCH_MODE, result: { ok: options.clipsGateOk ?? true } };
      }
      if (toolName === "shorts-assemble") {
        objects.set(`${stage8}final.mp4`, SYNTHETIC_VIDEO_BYTES);
        objects.set(`${stage8}manifest.json`, encoder.encode("local-sketch synthetic manifest v1"));
        return {
          schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: LOCAL_SKETCH_MODE,
          result: {
            ok: true, status: "assembled", video_object: `${stage8}final.mp4`,
            bytes: SYNTHETIC_VIDEO_BYTES.length, duration_sec: 30, manifest_sha256: SYNTHETIC_MANIFEST_SHA256,
            video_format_ok: true, duration_ok: true,
          },
        };
      }
      if (toolName === "shorts-storage-list") {
        let count = 0;
        for (const key of objects.keys()) if (key.startsWith(stage8)) count += 1;
        return { schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: LOCAL_SKETCH_MODE, result: { ok: true, count } };
      }
      if (toolName === "shorts-publish-card") {
        const id = `local-sketch-decision-${decisions.length + 1}`;
        decisions.push({ id, status: "pending", result: null, payload: null });
        return {
          schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: LOCAL_SKETCH_MODE,
          result: { operator_decision_id: id },
        };
      }
      if (toolName === "shorts-youtube") {
        return {
          schema: LOCAL_SKETCH_TOOL_RESULT_SCHEMA, mode: LOCAL_SKETCH_MODE,
          result: {
            ok: true, video_id: "local-sketch-video-1",
            channel_id: options.youtubeChannelId ?? "local-sketch-channel",
          },
        };
      }
      throw new Error("unknown_tool");
    },
  };

  const decisionPort: LocalSketchDecisionPort = {
    async createDecision({ requestKey, payload }) {
      const id = `local-sketch-decision-${decisions.length + 1}-${requestKey}`;
      decisions.push({ id, status: "pending", result: null, payload: payload ?? null });
      return { operatorDecisionId: id };
    },
    async readDecision({ operatorDecisionId }) {
      const record = decisions.find((entry) => entry.id === operatorDecisionId);
      if (!record) throw new Error("unknown_decision");
      return { status: record.status, result: structuredClone(record.result), payload: structuredClone(record.payload) };
    },
  };

  /** 사람 결정: 실제 resolve wire shape 을 fake decision 에 기록하고 binding payload 를 저장.
   *  targetId 미지정 시 마지막 결정을 해결한다(기존 호환). */
  function resolveDecision(
    resolution: { actionId: string; selectedOptionIds: string[]; comment: string | null },
    binding: { video_sha256: string; channel_id: string; metadata: Record<string, string> },
    targetId?: string,
  ): void {
    const record = targetId
      ? decisions.find((entry) => entry.id === targetId)
      : decisions.at(-1);
    if (!record) throw new Error("unknown_decision");
    record.status = "resolved";
    record.result = {
      actionId: resolution.actionId,
      outcome: resolution.actionId === "confirm" ? "approve" : "submit",
      selectedOptionIds: [...resolution.selectedOptionIds],
      comment: resolution.comment,
    };
    record.payload = { approved_binding: structuredClone(binding) };
  }

  const previews = new Map<string, LocalSketchPreviewView>();
  const acceptedByPreview = new Map<string, NonNullable<ReturnType<LocalSketchStateStore["getAcceptedRequest"]>>>();
  const acceptedByRequest = new Map<string, NonNullable<ReturnType<LocalSketchStateStore["getAcceptedRequest"]>>>();
  const deliveries = new Map<string, NonNullable<ReturnType<LocalSketchStateStore["getDelivery"]>>>();
  const generations = new Map<string, number>([[PRODUCER_STEP_ID, 2]]);

  const store: LocalSketchStateStore = {
    getPreview: (previewId) => structuredClone(previews.get(previewId) ?? null),
    putPreview: (view) => void previews.set(view.previewId, structuredClone(view)),
    getAcceptedRequest: (previewId) => structuredClone(acceptedByPreview.get(previewId) ?? null),
    findAcceptedRequest: (requestId) => structuredClone(acceptedByRequest.get(requestId) ?? null),
    putAcceptedRequest: (record) => {
      acceptedByPreview.set(record.previewId, structuredClone(record));
      acceptedByRequest.set(record.requestId, structuredClone(record));
    },
    getDelivery: (requestId) => structuredClone(deliveries.get(requestId) ?? null),
    putDelivery: (state) => void deliveries.set(state.requestId, structuredClone(state)),
    getGeneration: (stepId) => generations.get(stepId) ?? 0,
    setGeneration: (stepId, value) => void generations.set(stepId, value),
  };

  return {
    ports: { artifacts, dispatch, tools, objects: objectsPort, decisions: decisionPort },
    store,
    calls,
    registrations,
    decisions,
    resolveDecision,
    /** 이후 시작 테스트용 synthetic object bytes 주입(assemble 도구 호출 없이). */
    seedObject: (name: string, bytes: Uint8Array) => void objects.set(name, bytes),
  };
}

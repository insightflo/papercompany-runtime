/**
 * [파일 목적] shorts whole-flow LOCAL SKETCH coordinator (production 아님).
 *   실제 forwardReachable / checkStepEligibility 를 사용해 preview/apply/deliver/
 *   resolveReview/readback 을 제공한다. 상태는 주입된 LocalSketchStateStore 소속(모듈
 *   global 금지)이고, 포트는 명시적 로컬 fake 이다.
 * [수정시 주의]
 *   - 기존 workflowService.resumeRun 을 호출하지 않는다. dispatchResume 포트는 미래 engine
 *     연결 자리의 명시적 local stub 이다. receipt hash 는 소비자가 raw bytes 로 계산한다.
 *   - per-step eligibility 통과는 production resumability 인증이 아니고, 등록 포트 호출은
 *     production artifact 등록이 아니다. 자연어/status-as-request 권위 발명 금지.
 *   - uploadAttempted 센티널이 true 인 상태는 절대 shorts-youtube 를 다시 호출하지 않는다. await
 *     이후 모든 delivery 저장은 saveDelivery 관문으로 최신 store 상태를 재판정해 단조 보존한다
 *     (로컬 주입 store 순서 보장일 뿐 crash-durable SQL/분산 증명이 아니다).
 *   - deliver 는 receipt 등록/readback 을 매 delivery 맨 먼저(1회) 하고, 이후 수락된
 *     request.startStepId 로 진행한다(clips-gate 하드코드 금지).
 */

import { checkStepEligibility } from "./eligibility.js";
import { forwardReachable } from "./graph.js";
import {
  BINDING_SPECS, METADATA_SPECS, blockedTargetFor, fail, isObject, parseLocalSketchReceipt,
  pickObject, predecessorSeeds, requirePrerequisites, scopeEquals, sha256Hex, toolFigure, toolText,
  validateSuppliedPredecessors,
} from "./local-sketch-evidence.js";
import {
  LOCAL_SKETCH_DELIVERY_SCHEMA, LOCAL_SKETCH_MODE, LOCAL_SKETCH_PREVIEW_SCHEMA,
  LOCAL_SKETCH_PUBLISH_REQUEST_SCHEMA, LOCAL_SKETCH_RECEIPT_TITLE, LOCAL_SKETCH_REQUEST_SCHEMA,
  LOCAL_SKETCH_STATE_SCHEMA, LOCAL_SKETCH_TOOL_RESULT_SCHEMA, LOCAL_SKETCH_UPLOAD_ARTIFACT,
  type LocalSketchAcceptedRequest, type LocalSketchApprovedBinding, type LocalSketchCoordinatorInput,
  type LocalSketchDeliveryState, type LocalSketchDeliveryView, type LocalSketchPreviewView,
  type LocalSketchScope, type LocalSketchStage,
} from "./local-sketch-types.js";

export { LocalSketchRejectedError, parseLocalSketchReceipt } from "./local-sketch-evidence.js";

/** 이 스케치가 지원하는 7개 downstream 시작 id(clips-gate + 6 later/blocked 시작). */
const KNOWN_STARTS: readonly string[] = [
  "clips-gate", "clips-blocked", "assemble", "assemble-gate", "assemble-blocked", "final-review", "publish",
];

export function createLocalSketchCoordinator(input: LocalSketchCoordinatorInput) {
  const { nodes, histories, conditions, producerStepId, publishRequest, receipt, store, ports } = input;
  const parsed = parseLocalSketchReceipt(receipt.bytes);
  // expectedScope 는 receipt scope 와 10 필드 전부 일치해야 한다(최소 소유 바인딩).
  if (!scopeEquals(input.expectedScope, parsed.receipt.scope)) fail("predecessor_scope_mismatch");
  // 공급된 선행 증거는 구성 시 검증/snapshot 한다(호출자 변형 차단).
  const predecessors = validateSuppliedPredecessors(input.predecessors, input.expectedScope, parsed.sha256);
  const scope = parsed.receipt.scope;
  const workflowRunId = scope.workflow_run_id;

  /** tool 응답은 외부 envelope 이 fixture 임을 표시해야 하며, machine 필드만 소비한다. */
  async function invoke(toolName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
    const envelope = await ports.tools.invokeTool({ toolName, parameters });
    if (envelope.schema !== LOCAL_SKETCH_TOOL_RESULT_SCHEMA || envelope.mode !== LOCAL_SKETCH_MODE) {
      fail("fixture_envelope_missing");
    }
    return envelope.result;
  }

  function preview(startStepId: string): LocalSketchPreviewView {
    const reachable = forwardReachable(nodes, startStepId);
    if (reachable.includes(producerStepId)) fail("producer_in_resume_set");
    const byStep = new Map(histories.map((history) => [history.stepId, history]));
    const blockedSteps = reachable.flatMap((stepId) => {
      const history = byStep.get(stepId);
      if (!history) fail("missing_history");
      const blocker = checkStepEligibility(history);
      return blocker ? [{ stepId, blocker }] : [];
    });
    const view: LocalSketchPreviewView = {
      schema: LOCAL_SKETCH_PREVIEW_SCHEMA, mode: LOCAL_SKETCH_MODE,
      previewId: `local-sketch-preview:${workflowRunId}:${startStepId}`,
      startStepId, workflowRunId, affectedStepIds: reachable, blockedSteps,
      preservedProducerStepId: producerStepId,
      // outside = producer 제외한 무관 노드.
      outsideStepIds: nodes.map((n) => n.id).filter((id) => !reachable.includes(id) && id !== producerStepId),
    };
    store.putPreview(view);
    return view;
  }

  async function apply(previewIdValue: string) {
    const snapshot = store.getPreview(previewIdValue);
    if (!snapshot || snapshot.mode !== LOCAL_SKETCH_MODE) fail("not_previewed");
    if (snapshot.blockedSteps.length > 0) fail("blocked_step");
    const existing = store.getAcceptedRequest(previewIdValue);
    if (existing) return existing; // 같은 preview 재재생 → 동일 request, 이중 증분/리셋 없음
    if (!KNOWN_STARTS.includes(snapshot.startStepId)) fail("invalid_start_step");
    // 요구 선행 증거는 generation 증분/디스패치/기록 이전에 강제한다(fallback 금지).
    requirePrerequisites(snapshot.startStepId, predecessors);
    const generations: Record<string, number> = {};
    for (const stepId of snapshot.affectedStepIds) {
      const next = store.getGeneration(stepId) + 1; // 영향 step 만 1회 증분
      store.setGeneration(stepId, next);
      generations[stepId] = next;
    }
    const requestId = `local-sketch-request:${previewIdValue}`;
    const dispatch = await ports.dispatch.dispatchResume({
      requestId, workflowRunId, startStepId: snapshot.startStepId, generations,
    });
    if (!dispatch.accepted) fail("dispatch_rejected");
    const record: LocalSketchAcceptedRequest = {
      schema: LOCAL_SKETCH_REQUEST_SCHEMA, mode: LOCAL_SKETCH_MODE,
      requestId, previewId: previewIdValue, startStepId: snapshot.startStepId, workflowRunId,
      issueId: scope.issue_id, affectedStepIds: [...snapshot.affectedStepIds], generations,
    };
    store.putAcceptedRequest(record);
    return record;
  }

  function initialState(record: LocalSketchAcceptedRequest): LocalSketchDeliveryState {
    return {
      schema: LOCAL_SKETCH_STATE_SCHEMA, mode: LOCAL_SKETCH_MODE, requestId: record.requestId,
      stage: "receipt-gate", registeredSha256: null, decisionId: null, assemble: null,
      approvedBinding: null, uploadAttempted: false, waiting: null, blocked: null, uploadResult: null,
    };
  }

  /** await 이후 모든 delivery 저장의 단일 관문: 저장 직전 최신 store 상태를 재읽어
   *  uploadAttempted 센티널/성공 uploadResult 를 단조 보존한다(반환값이 실제 현재 상태).
   *  성공 결과 저장분은 무조건 보존, 시도됨(결과 없음) 저장분은 시도됨+성공 next 만 교체 허용. */
  function saveDelivery(next: LocalSketchDeliveryState): LocalSketchDeliveryState {
    const stored = store.getDelivery(next.requestId);
    if (stored?.uploadAttempted && stored.uploadResult) return stored;
    if (!stored?.uploadAttempted || (next.uploadAttempted && next.uploadResult !== null)) {
      store.putDelivery(next);
      return next;
    }
    return stored;
  }

  /** 사람 결정 경계 관찰: 대기/불명은 그대로 두고 승인 시에만 publish 로 진행한다(도구 부작용 없음). */
  async function pollReview(state: LocalSketchDeliveryState): Promise<LocalSketchDeliveryState> {
    if ((state.stage !== "final-review" && state.stage !== "publish") || !state.decisionId) return state;
    const decision = await ports.decisions.readDecision({ operatorDecisionId: state.decisionId });
    if (decision.status !== "resolved" || !decision.result) return { ...state, waiting: "human_review" };
    const approved = decision.result.actionId === "confirm"
      && decision.result.selectedOptionIds.includes("approve");
    if (!approved) return { ...state, waiting: "reconciliation" }; // 절대 자동 재전송 없음
    if (!decision.payload || !isObject(decision.payload.approved_binding)) fail("review_binding_missing");
    const binding = pickObject<Record<string, unknown>>(decision.payload.approved_binding, BINDING_SPECS, "binding");
    const metadata = pickObject<LocalSketchApprovedBinding["metadata"]>(binding.metadata, METADATA_SPECS, "binding");
    return {
      ...state, waiting: null, stage: "publish",
      approvedBinding: {
        videoSha256: String(binding.video_sha256), channelId: String(binding.channel_id), metadata,
      },
    };
  }

  /** 전송 시도 후의 상태: 성공 저장분(published) 또는 reconciliation 대기 — 절대 재전송 없음. */
  function uploadOutcome(state: LocalSketchDeliveryState): LocalSketchDeliveryState {
    if (state.uploadResult || state.waiting === "reconciliation") return state;
    return { ...state, waiting: "reconciliation" };
  }

  /** 업로드 1회화: video bytes 대조 → 저장된 센티널 재확인 → 센티널 선저장 → 전송. */
  async function performUpload(state: LocalSketchDeliveryState): Promise<LocalSketchDeliveryState> {
    const binding = state.approvedBinding;
    if (!binding || !state.assemble) fail("review_binding_missing");
    // 승인은 video bytes digest 에 묶인다. 전송 직전 현재 bytes 를 다시 읽어 양쪽과 대조.
    const currentBytes = await ports.objects.readObject({ object: state.assemble.videoObject });
    const currentSha256 = sha256Hex(currentBytes);
    if (currentSha256 !== state.assemble.videoSha256 || currentSha256 !== binding.videoSha256) {
      fail("video_mismatch");
    }
    // 센티널 기록 직전 저장 상태를 다시 읽는다 — 다른 호출이 이미 보냈으면 절대 재전송 없음.
    const stored = store.getDelivery(state.requestId);
    if (stored?.uploadAttempted) return stored;
    saveDelivery({ ...state, uploadAttempted: true, waiting: "reconciliation" });
    const result = await invoke("shorts-youtube", {
      schema: LOCAL_SKETCH_PUBLISH_REQUEST_SCHEMA, run_id: workflowRunId,
      video_object: state.assemble.videoObject, video_title: binding.metadata.video_title,
      video_description: binding.metadata.video_description, privacy: binding.metadata.privacy,
    });
    if (result.ok !== true) fail("upload_not_ok");
    const channelId = toolText(result, "channel_id");
    if (channelId !== binding.channelId) fail("channel_mismatch");
    return {
      ...state, stage: "published", waiting: null, uploadAttempted: true,
      uploadResult: { videoId: toolText(result, "video_id"), channelId, artifact: LOCAL_SKETCH_UPLOAD_ARTIFACT },
    };
  }

  type Stage = (state: LocalSketchDeliveryState) => Promise<LocalSketchDeliveryState>;
  const stages: Partial<Record<LocalSketchStage, Stage>> = {
    "clips-gate": async (state) => {
      const result = await invoke("shorts-clips-verify", { prefix: `shorts/runs/${workflowRunId}/clips/` });
      return result.ok === true ? { ...state, stage: "assemble" } : blockedBranch(state, "clips-gate");
    },
    assemble: async (state) => {
      const result = await invoke("shorts-assemble", { run_id: workflowRunId });
      if (result.ok !== true || result.video_format_ok !== true || result.duration_ok !== true) fail("assemble_not_ok");
      const videoObject = toolText(result, "video_object");
      // 승인 바인딩 대상은 manifest text 가 아니라 실제 video bytes digest 다.
      const videoSha256 = sha256Hex(await ports.objects.readObject({ object: videoObject }));
      return {
        ...state, stage: "assemble-gate",
        assemble: {
          videoObject, bytes: toolFigure(result, "bytes"), durationSec: toolFigure(result, "duration_sec"),
          manifestSha256: toolText(result, "manifest_sha256"), videoSha256,
        },
      };
    },
    "assemble-gate": async (state) => {
      const result = await invoke("shorts-storage-list", { action: "list", object: `shorts/runs/${workflowRunId}/stage8/` });
      return toolFigure(result, "count") > 0 ? { ...state, stage: "final-review" } : blockedBranch(state, "assemble-gate");
    },
    "final-review": async (state) => {
      if (!state.decisionId) {
        if (!state.assemble) fail("tool_field_missing:manifest_sha256");
        const result = await invoke("shorts-publish-card", {
          run_id: workflowRunId, issue_id: scope.issue_id, mission_id: scope.mission_id,
          video_title: publishRequest.video_title, video_description: publishRequest.video_description,
          privacy: publishRequest.privacy, duration_sec: state.assemble.durationSec, bytes: state.assemble.bytes,
          presign_url: publishRequest.presign_url, manifest_sha256: state.assemble.manifestSha256,
        });
        state = { ...state, decisionId: toolText(result, "operator_decision_id") };
      }
      return pollReview({ ...state, stage: "final-review" });
    },
    publish: async (state) => {
      if (state.uploadAttempted) return uploadOutcome(state); // 시도됨 — 절대 재전송 없음
      if (!state.approvedBinding) {
        const reviewed = await pollReview(state); // 미결/불명 대기 — 도구 부작용 없음
        if (!reviewed.approvedBinding) return reviewed;
        state = reviewed;
      }
      return performUpload(state);
    },
  };

  function blockedBranch(state: LocalSketchDeliveryState, stage: LocalSketchStage): LocalSketchDeliveryState {
    const condition = conditions.find((entry) => entry.onStepId === stage && entry.when === "false");
    if (!condition) fail("blocked_branch_unlisted");
    return { ...state, stage: "blocked", waiting: null, blocked: { stage, branchStepId: condition.stepId } };
  }

  /** delivery 맨 먼저(1회): producer receipt 등록/readback 후 수락된 시작 step 으로 진입. */
  async function enterStartStep(
    state: LocalSketchDeliveryState,
    record: LocalSketchAcceptedRequest,
  ): Promise<LocalSketchDeliveryState> {
    if (state.registeredSha256 !== parsed.sha256) {
      await ports.artifacts.registerArtifact({
        issueId: scope.issue_id, title: LOCAL_SKETCH_RECEIPT_TITLE, path: receipt.path, scope, sha256: parsed.sha256,
      });
      const readback = await ports.artifacts.readArtifact(receipt.path);
      if (readback.sha256 !== parsed.sha256) fail("receipt_hash_mismatch");
    }
    const blocked = blockedTargetFor(record.startStepId);
    if (blocked) {
      return { ...state, stage: "blocked", waiting: null, registeredSha256: parsed.sha256, blocked };
    }
    return {
      ...state, stage: record.startStepId as LocalSketchStage, registeredSha256: parsed.sha256,
      ...predecessorSeeds(record.startStepId, predecessors),
    };
  }

  async function deliver(requestId: string): Promise<LocalSketchDeliveryView> {
    const record = store.findAcceptedRequest(requestId);
    if (!record) fail("not_accepted"); // 수락된 request record 없으면 delivery 없음
    let state: LocalSketchDeliveryState = store.getDelivery(requestId) ?? initialState(record);
    if (state.stage === "receipt-gate") state = saveDelivery(await enterStartStep(state, record));
    while (state.stage !== "published" && state.stage !== "blocked") {
      const stage = stages[state.stage];
      if (!stage) break;
      const before = state.stage;
      state = saveDelivery(await stage(state));
      if (state.stage === before) break; // human_review/reconciliation 대기 — 진행 없이 저장만
    }
    return toView(state);
  }

  /** 사람 결정 경계 관찰(도구 부작용 없음, readDecision 만). 이미 전송 시도된 상태는 무변경. */
  async function resolveReview(requestId: string): Promise<LocalSketchDeliveryView> {
    const state = store.getDelivery(requestId);
    if (!state) fail("not_accepted");
    if (state.uploadAttempted) return toView(state);
    return toView(saveDelivery(await pollReview(state)));
  }
  function readback(requestId: string): LocalSketchDeliveryView {
    const state = store.getDelivery(requestId);
    if (!state) fail("not_accepted");
    return toView(state);
  }
  function toView(state: LocalSketchDeliveryState): LocalSketchDeliveryView {
    return {
      schema: LOCAL_SKETCH_DELIVERY_SCHEMA, mode: LOCAL_SKETCH_MODE, requestId: state.requestId,
      stage: state.stage, waitingHumanReview: state.waiting === "human_review",
      waitingReconciliation: state.waiting === "reconciliation", blocked: state.blocked,
      uploadResult: state.uploadResult
        ? { videoId: state.uploadResult.videoId, channelId: state.uploadResult.channelId }
        : null,
    };
  }
  return { preview, apply, deliver, resolveReview, readback };
}

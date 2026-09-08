/**
 * [파일 목적] shorts whole-flow LOCAL SKETCH 전용 wire/types (production 아님).
 *   기존 resume types 에서 ResumeNode/StepHistory/StepEligibilityBlocker 만 재사용하고
 *   나머지는 sketch 계약만 정의한다. 모든 top-level fixture/receipt/state/output 에는
 *   mode "local-sketch" 와 version schema 가 명시된다.
 * [수정시 주의]
 *   - 포트(registerArtifact/readArtifact, dispatchResume, invokeTool,
 *     createDecision/readDecision)는 명시적 로컬 fake 전용 — network/DB 바인딩 금지,
 *     generic live adapter/fallback 발명 금지.
 *   - production 계약 승격 금지. 실제 연결 bridge 는 receipt 를 독립 검증해야 한다.
 *   - 승인 binding 은 fake decision 의 구조화 payload 안의 machine 필드일 뿐이며
 *     자연어/추론 권위가 아니다.
 */

import type { StepEligibilityBlocker } from "./types.js";

export const LOCAL_SKETCH_MODE = "local-sketch";
export const LOCAL_SKETCH_FIXTURE_SCHEMA = "shorts.local-reuse-fixture.v1";
export const LOCAL_SKETCH_RECEIPT_SCHEMA = "shorts.local-reuse-receipt.v1";
export const LOCAL_SKETCH_PREVIEW_SCHEMA = "shorts.local-sketch-preview.v1";
export const LOCAL_SKETCH_DELIVERY_SCHEMA = "shorts.local-sketch-delivery.v1";
export const LOCAL_SKETCH_REQUEST_SCHEMA = "shorts.local-sketch-request.v1";
export const LOCAL_SKETCH_STATE_SCHEMA = "shorts.local-sketch-state.v1";
export const LOCAL_SKETCH_TOOL_RESULT_SCHEMA = "shorts.local-sketch-tool-result.v1";
export const LOCAL_SKETCH_PREDECESSORS_SCHEMA = "shorts.local-sketch-predecessors.v1";
export const LOCAL_SKETCH_PUBLISH_REQUEST_SCHEMA = "shorts.publish-request.v1";
export const LOCAL_SKETCH_RECEIPT_TITLE = "clips-result.v1.json";
export const LOCAL_SKETCH_UPLOAD_ARTIFACT = "youtube-publish.v1.json";

/** cu_contract.validate_scope 의 10 필드와 동일한 구조(값 검증은 Python 계약이 담당). */
export interface LocalSketchScope {
  job_id: string;
  company_id: string;
  mission_id: string;
  workflow_run_id: string;
  step_run_id: string;
  step_id: string;
  issue_id: string;
  execution_generation: number;
  attempt: number;
  spec_sha256: string;
}

export interface LocalSketchCredit {
  event_id: string;
  amount: number;
  evidence_record: string;
}

export interface LocalSketchReceiptClip {
  frame: number;
  path: string;
  source_object: string;
  file_sha256: string;
  stored_object: string;
  stored_sha256: string;
}

/** cu_reuse_sketch.py 가 쓰는 fixture receipt (공식 CU terminal result 아님). */
export interface LocalSketchReceipt {
  schema: typeof LOCAL_SKETCH_RECEIPT_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  scope: LocalSketchScope;
  claim_id: string;
  clips: LocalSketchReceiptClip[];
  credits: LocalSketchCredit[];
}

/** canonical 그래프에는 true/false 가 없으므로 sketch fixture 가 분기 소속을 별도 표로 갖는다. */
export interface LocalSketchCondition {
  onStepId: string;
  when: "true" | "false";
  stepId: string;
}

// --- explicit ports (local fakes only; no network/DB binding) ----------------

export interface LocalSketchArtifactPort {
  registerArtifact(input: {
    issueId: string;
    title: string;
    path: string;
    scope: LocalSketchScope;
    sha256: string;
  }): Promise<{ artifactId: string }>;
  readArtifact(path: string): Promise<{ bytes: Uint8Array; sha256: string }>;
}

/** 미래 generation-aware engine 연결 자리의 명시적 local stub — 기존 resumeRun 이 아니다. */
export interface LocalSketchDispatchPort {
  dispatchResume(request: {
    requestId: string;
    workflowRunId: string;
    startStepId: string;
    generations: Record<string, number>;
  }): Promise<{ accepted: boolean }>;
}

/** tool 응답은 외부 envelope 이 fixture 임을 표시하고, 코디네이터는 machine 필드만 소비한다. */
export interface LocalSketchToolEnvelope {
  schema: typeof LOCAL_SKETCH_TOOL_RESULT_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  result: Record<string, unknown>;
}

export interface LocalSketchToolPort {
  invokeTool(request: {
    toolName: string;
    parameters: Record<string, unknown>;
  }): Promise<LocalSketchToolEnvelope>;
}

/** 명시적 로컬 fake 객체 포트 — synthetic object bytes 읽기 전용(network 바인딩 금지). */
export interface LocalSketchObjectPort {
  readObject(request: { object: string }): Promise<Uint8Array>;
}

/** 실제 operator decision resolve wire shape (actionId confirm + selection approve). */
export interface LocalSketchDecisionResult {
  actionId: string;
  outcome: string;
  selectedOptionIds: string[];
  comment: string | null;
}

export interface LocalSketchDecisionPort {
  createDecision(request: {
    requestKey: string;
    payload: Record<string, unknown> | null;
  }): Promise<{ operatorDecisionId: string }>;
  readDecision(request: {
    operatorDecisionId: string;
  }): Promise<{
    status: "pending" | "resolved";
    result: LocalSketchDecisionResult | null;
    payload: Record<string, unknown> | null;
  }>;
}

// --- injected local state store (fake semantics — SQL atomicity 아님) --------

export interface LocalSketchApprovedBinding {
  videoSha256: string;
  channelId: string;
  metadata: { video_title: string; video_description: string; privacy: string };
}

export interface LocalSketchAcceptedRequest {
  schema: typeof LOCAL_SKETCH_REQUEST_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  requestId: string;
  previewId: string;
  startStepId: string;
  workflowRunId: string;
  issueId: string;
  affectedStepIds: string[];
  generations: Record<string, number>;
}

/** assemble 단계 결과(이후 시작 step 주입/업로드 바인딩에 재사용). */
export interface LocalSketchAssembly {
  videoObject: string;
  bytes: number;
  durationSec: number;
  manifestSha256: string;
  /** 실제 video bytes 의 SHA256 — manifest text digest 와 별개다. */
  videoSha256: string;
}

/** 로컬 주입 선행 증거 문서 — production 신뢰/이력이 아니라 합성 공급값 전다. */
export interface LocalSketchPredecessorEvidence {
  schema: typeof LOCAL_SKETCH_PREDECESSORS_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  scope: LocalSketchScope;
  receiptSha256: string;
  clipsGateOk?: boolean;
  assemble?: LocalSketchAssembly;
  assembleGateOk?: boolean;
  decisionId?: string;
}

export type LocalSketchStage =
  | "receipt-gate"
  | "clips-gate"
  | "assemble"
  | "assemble-gate"
  | "final-review"
  | "publish"
  | "published"
  | "blocked";

export interface LocalSketchDeliveryState {
  schema: typeof LOCAL_SKETCH_STATE_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  requestId: string;
  stage: LocalSketchStage;
  registeredSha256: string | null;
  decisionId: string | null;
  assemble: LocalSketchAssembly | null;
  approvedBinding: LocalSketchApprovedBinding | null;
  /** 전송 시도 센티널 — true 면 같은 request 로 절대 재전송하지 않는다. */
  uploadAttempted: boolean;
  waiting: "human_review" | "reconciliation" | null;
  blocked: { stage: LocalSketchStage; branchStepId: string } | null;
  uploadResult: {
    videoId: string;
    channelId: string;
    artifact: typeof LOCAL_SKETCH_UPLOAD_ARTIFACT;
  } | null;
}

/** 상태는 모듈 global 이 아니라 주입된 store 소속이다. 같은 preview 재재생은 동일 요청. */
export interface LocalSketchStateStore {
  getPreview(previewId: string): LocalSketchPreviewView | null;
  putPreview(view: LocalSketchPreviewView): void;
  getAcceptedRequest(previewId: string): LocalSketchAcceptedRequest | null;
  findAcceptedRequest(requestId: string): LocalSketchAcceptedRequest | null;
  putAcceptedRequest(record: LocalSketchAcceptedRequest): void;
  getDelivery(requestId: string): LocalSketchDeliveryState | null;
  putDelivery(state: LocalSketchDeliveryState): void;
  getGeneration(stepId: string): number;
  setGeneration(stepId: string, value: number): void;
}

// --- structured views (UI 계약; UI 는 server import 없이 구조 재진술 가능) ----

export interface LocalSketchPreviewView {
  schema: typeof LOCAL_SKETCH_PREVIEW_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  previewId: string;
  startStepId: string;
  workflowRunId: string;
  affectedStepIds: string[];
  blockedSteps: { stepId: string; blocker: StepEligibilityBlocker }[];
  preservedProducerStepId: string;
  outsideStepIds: string[];
}

export interface LocalSketchDeliveryView {
  schema: typeof LOCAL_SKETCH_DELIVERY_SCHEMA;
  mode: typeof LOCAL_SKETCH_MODE;
  requestId: string;
  stage: LocalSketchStage;
  waitingHumanReview: boolean;
  waitingReconciliation: boolean;
  blocked: { stage: LocalSketchStage; branchStepId: string } | null;
  uploadResult: { videoId: string; channelId: string } | null;
}

/** 최종 승인 전 publish-card 제안 메타데이터(fixture 합성값; 승인 후에는 binding metadata 사용). */
export interface LocalSketchPublishProposal {
  video_title: string;
  video_description: string;
  privacy: string;
  presign_url: string;
}

export interface LocalSketchCoordinatorInput {
  nodes: import("./types.js").ResumeNode[];
  histories: import("./types.js").StepHistory[];
  conditions: LocalSketchCondition[];
  producerStepId: string;
  publishRequest: LocalSketchPublishProposal;
  receipt: { path: string; bytes: Uint8Array };
  /** receipt scope 와 대조되는 기대 scope — 10 필드 모두 일치해야 구성된다. */
  expectedScope: LocalSketchScope;
  /** 선택적 로컬 주입 선행 증거(합성 공급값; 구성 시 snapshot 된다). */
  predecessors?: LocalSketchPredecessorEvidence;
  store: LocalSketchStateStore;
  ports: {
    artifacts: LocalSketchArtifactPort;
    dispatch: LocalSketchDispatchPort;
    tools: LocalSketchToolPort;
    objects: LocalSketchObjectPort;
    decisions: LocalSketchDecisionPort;
  };
}

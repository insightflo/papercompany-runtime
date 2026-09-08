/**
 * [파일 목적] shorts local-sketch 격리 미리보기/확인 컴포넌트 — production 마운트 금지.
 *   서버 런타임 import 없이 로컬 구조 타입만 재진술하며(local structural UI subset),
 *   코디네이터의 public view 계약과 동일하게 유지한다. 오케스트레이션을 복제하지 않고
 *   콜백으로만 연결되며, 사람 승인 결정(콜백/버튼)을 스스로 갖지 않는다 — 대기 상태만 표시.
 * [수정시 주의]
 *   - view 계약 필드를 바꾸면 server local-sketch-types 의 view 와 함께 검토할 것.
 *   - approve/reject 액션 UI 를 추가하지 않는다(사람 결정 경계는 밖에서 처리).
 */

import { useState } from "react";

export interface ShortsResumeSketchPreviewView {
  schema: string;
  mode: string;
  previewId: string;
  startStepId: string;
  workflowRunId: string;
  affectedStepIds: string[];
  blockedSteps: { stepId: string; blocker: string }[];
  preservedProducerStepId: string;
  outsideStepIds: string[];
}

export interface ShortsResumeSketchDeliveryView {
  schema: string;
  mode: string;
  requestId: string;
  stage: string;
  waitingHumanReview: boolean;
  waitingReconciliation: boolean;
  blocked: { stage: string; branchStepId: string } | null;
  uploadResult: { videoId: string; channelId: string } | null;
}

export interface ShortsResumeSketchProps {
  preview: ShortsResumeSketchPreviewView;
  delivery?: ShortsResumeSketchDeliveryView | null;
  startStepOptions: string[];
  onPreview: (startStepId: string) => void;
  onApply: (previewId: string) => void;
  disabled?: boolean;
  busy?: boolean;
  error?: string | null;
}

/** 시작 step 선택값: 미리보기의 시작 step 이 후보에 있으면 그것, 없으면 첫 후보(기본 clips-gate). */
export function selectedStartStepId(
  preview: ShortsResumeSketchPreviewView,
  startStepOptions: string[],
): string {
  if (startStepOptions.includes(preview.startStepId)) return preview.startStepId;
  return startStepOptions[0] ?? preview.startStepId;
}

function DeliveryStatus({ delivery }: { delivery: ShortsResumeSketchDeliveryView }) {
  return (
    <div data-testid="shorts-sketch-delivery">
      <p data-testid="shorts-sketch-stage">stage: {delivery.stage}</p>
      {delivery.waitingHumanReview ? (
        <p data-testid="shorts-sketch-waiting-review">
          waiting for human review — approval happens outside this sketch component
        </p>
      ) : null}
      {delivery.waitingReconciliation ? (
        <p data-testid="shorts-sketch-waiting-reconciliation">
          unresolved review outcome — waiting reconciliation, no automatic resend
        </p>
      ) : null}
      {delivery.blocked ? (
        <p role="alert" data-testid="shorts-sketch-blocked">
          blocked at {delivery.blocked.stage} — branch {delivery.blocked.branchStepId}
        </p>
      ) : null}
      {delivery.uploadResult ? (
        <p data-testid="shorts-sketch-upload">
          uploaded {delivery.uploadResult.videoId} to {delivery.uploadResult.channelId}
        </p>
      ) : null}
    </div>
  );
}

export function ShortsResumeSketch({
  preview,
  delivery = null,
  startStepOptions,
  onPreview,
  onApply,
  disabled = false,
  busy = false,
  error = null,
}: ShortsResumeSketchProps) {
  const [selected, setSelected] = useState(() => selectedStartStepId(preview, startStepOptions));
  const inactive = disabled || busy;
  return (
    <section aria-label="Shorts local sketch resume" data-testid="shorts-resume-sketch">
      <p role="note" data-banner="local-sketch">
        local mock — local-sketch fixture, not production
      </p>
      <label>
        Start step
        <select
          data-testid="shorts-sketch-start-step"
          value={selected}
          disabled={inactive}
          onChange={(event) => {
            setSelected(event.target.value);
            onPreview(event.target.value);
          }}
        >
          {startStepOptions.map((stepId) => (
            <option key={stepId} value={stepId}>
              {stepId}
            </option>
          ))}
        </select>
      </label>
      <ul data-testid="shorts-sketch-affected">
        {preview.affectedStepIds.map((stepId) => (
          <li key={stepId}>{stepId}</li>
        ))}
      </ul>
      <p data-testid="shorts-sketch-producer">preserved producer: {preview.preservedProducerStepId}</p>
      {preview.blockedSteps.map((entry) => (
        <p key={entry.stepId} role="alert">
          {entry.stepId}: {entry.blocker}
        </p>
      ))}
      {delivery ? <DeliveryStatus delivery={delivery} /> : null}
      {error ? (
        <p role="alert" data-testid="shorts-sketch-error">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="shorts-sketch-apply"
        disabled={inactive}
        onClick={() => onApply(preview.previewId)}
      >
        {busy ? "Applying…" : "Confirm apply (local sketch)"}
      </button>
    </section>
  );
}

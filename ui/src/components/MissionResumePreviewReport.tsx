// ui/src/components/MissionResumePreviewReport.tsx
//
// [purpose] MissionResumeDialog의 재개 범위 스냅샷 표시 전용 presentational helper.
//   상태 없이 ResumePreview를 읽기 전용으로 렌더한다. 영향/보존 단계 이름, 차단 전체(메시지+코드),
//   생성/예산/필수 승인 요약, 스냅샷 만료 여부를 보여준다.
import type { ResumePreview } from "@paperclipai/shared/types/workflow-resume";

const AFFECTED_ACTION_LABEL = { execute: "실행", reevaluate: "재평가" } as const;
const GENERATION_LABEL = {
  none: "재실행 범위에서 새 생성 없음",
  possible: "재실행 범위에서 생성이 발생할 수 있습니다",
} as const;
const BUDGET_LABEL = { verified: "예산 확인 완료", unknown: "예산 상태 미확인" } as const;

interface MissionResumePreviewReportProps {
  preview: ResumePreview;
  expired: boolean;
}

export function MissionResumePreviewReport({ preview, expired }: MissionResumePreviewReportProps) {
  const approvalsUnknown = preview.blockers.some((blocker) =>
    ["external_effect_unknown", "historical_definition_unproven", "unsupported_graph"].includes(blocker.code));
  const approvalLabel = preview.approvals.length > 0 ? `${preview.approvals.length}개 단계에 필요`
    : approvalsUnknown ? "확정할 수 없음" : "없음";
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="mission-resume-preview">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">재개 범위 스냅샷</p>
      {!preview.eligible && (
        <p className="font-medium text-destructive" role="alert">이 범위는 지금 재개할 수 없습니다.</p>
      )}
      {preview.blockers.length > 0 && (
        <ul className="space-y-1">
          {preview.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.stepId ?? index}`} className="text-destructive" role="alert">
              {blocker.message}
              <span className="ml-1 text-xs text-muted-foreground">({blocker.code})</span>
            </li>
          ))}
        </ul>
      )}
      {preview.affected.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">다시 수행되는 단계</p>
          <ul className="space-y-0.5">
            {preview.affected.map((step, index) => (
              <li key={`${step.stepId}-${index}`}>
                {step.name}
                <span className="ml-1 text-xs text-muted-foreground">({AFFECTED_ACTION_LABEL[step.action]})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.preserved.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">보존되는 단계</p>
          <ul className="space-y-0.5">
            {preview.preserved.map((step, index) => (
              <li key={`${step.stepId}-${index}`}>{step.name}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li>생성: {GENERATION_LABEL[preview.generation]}</li>
        <li>예산: {BUDGET_LABEL[preview.budget]}</li>
        <li>필수 승인: {approvalLabel}</li>
        <li>
          스냅샷:{" "}
          {preview.snapshotToken ? (expired ? "만료됨 — 범위를 다시 확인하세요" : "준비됨") : "없음"}
        </li>
        {preview.expiresAt && <li>스냅샷 만료: {new Date(preview.expiresAt).toLocaleString()}</li>}
      </ul>
    </div>
  );
}

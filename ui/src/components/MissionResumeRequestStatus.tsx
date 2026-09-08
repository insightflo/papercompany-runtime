// ui/src/components/MissionResumeRequestStatus.tsx
//
// [purpose] MissionResumeDialog의 재시도/요청 상태 표시 전용 presentational helper.
//   'accepted'는 "실행기 전달 완료"이지 실행 완료가 아니다. 가상의 전달 단계·승인 성공을 만들지 않고
//   서버가 준 state/code만 보여준다. 승인/게시 버튼은 여기에 존재하지 않는다.
import { Button } from "@/components/ui/button";
import type { ResumeRequestView } from "@paperclipai/shared/types/workflow-resume";

export const ACCEPTED_MESSAGE = "재개 요청이 실행기에 전달되었습니다";

const REQUEST_STATE_LABEL: Record<ResumeRequestView["state"], string> = {
  pending_delivery: "실행기 전달 대기",
  accepted: "실행기 전달 완료",
  blocked: "차단됨",
  cancelled: "취소됨",
};

interface MissionResumeRequestStatusProps {
  applyError: { message: string; uncertain: boolean } | null;
  canRetry: boolean;
  onRetry: () => void;
  requestLoading: boolean;
  requestError: string | null;
  requestView: ResumeRequestView | null;
}

export function MissionResumeRequestStatus({
  applyError,
  canRetry,
  onRetry,
  requestLoading,
  requestError,
  requestView,
}: MissionResumeRequestStatusProps) {
  return (
    <>
      {applyError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          <p>{applyError.message}</p>
          {canRetry && (
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
              같은 요청 다시 보내기
            </Button>
          )}
        </div>
      )}
      {requestLoading && <p className="text-xs text-muted-foreground">재개 요청 상태를 확인하는 중…</p>}
      {requestError && (
        <p className="text-sm text-destructive" role="alert">재개 요청 상태 확인 실패: {requestError}</p>
      )}
      {requestView && (
        <div className="rounded-md border border-border p-3 text-sm" data-testid="mission-resume-request-state">
          <p className="font-medium">재개 요청 상태: {REQUEST_STATE_LABEL[requestView.state]}</p>
          {requestView.code && <p className="text-xs text-muted-foreground">코드: {requestView.code}</p>}
          {requestView.state === "pending_delivery" && (
            <p className="text-xs text-muted-foreground">실행기에 전달되는 동안 상태를 자동 확인합니다.</p>
          )}
          {requestView.state === "accepted" && (
            <p className="text-xs text-emerald-600">{ACCEPTED_MESSAGE}</p>
          )}
          {requestView.state === "blocked" && (
            <p className="text-xs text-destructive">요청이 차단되었습니다. 안내를 확인한 뒤 새로 진행하세요.</p>
          )}
        </div>
      )}
    </>
  );
}
